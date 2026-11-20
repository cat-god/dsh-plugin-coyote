/**
 * dsh-plugin-coyote —— 让 AI 伙伴操控「郊狼 3.0」脉冲主机的 DSH 插件
 * ============================================================================
 * 它是什么：
 *   把郊狼 3.0 的官方 **SOCKET 协议**（WebSocket 中继，不需要蓝牙、不需要 root）
 *   接成一组 DSH 工具 + 一个本机 HTTP 接口，让模型可以调强度、放波形、临时顶一下、
 *   随时全停。配对只需要手机 APP 扫一次二维码（插件把二维码画成 PNG 落在家目录里）。
 *
 * 为什么走 SOCKET 而不是蓝牙：
 *   ① 官方支持、跨平台、不需要 BLE 适配器；② 手机 APP 自己做 BLE 那一层，
 *   我们只跟中继说 JSON；③ 本仓库零原生依赖（只用 Node 22 自带的全局 WebSocket）。
 *
 * 家目录（`$DSH_HOME/coyote-3/`）：
 *   `state.json`    上次连到哪/强度多少（重启后能看到，不自动重连）
 *   `outbox/`       二维码 PNG 落这儿（`coyote_qr` 会返回绝对路径）
 *   `coyote.log`    本插件日志
 *
 * 安全护栏（默认全开，可在设置页调）：
 *   · 双上限取 min：插件自己的 `maxStrength` 与 APP 报的通道软上限
 *   · 令牌桶：加/抬强度受限速（默认 40/s），**降与归零永远瞬时放行**
 *   · 会期上限：一次配对最多开 1 小时
 *   · 看门狗：15 秒收不到 APP 回帧就自动全停 + 断开
 *   · 单次投放上限 600 秒，长波形自动切片续投（单条 JSON ≤1950 字符是硬约束）
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs';

// 这两样从**宿主那棵树**里取（拿不到就退到自己的依赖；再拿不到，defineTool 用本地等价实现）。
// 起因：它们是 optional peer，桌面版 profile 是 autoInstallPeers: false ⇒ 永远不装
// ⇒ 裸 import 会让整条插件不激活。
const hostDeps = await loadHostDeps();
const z = hostDeps.z;
const defineTool = hostDeps.defineTool;

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  initCoyote, setStateDir, outboxDir, coyoteState, coyoteLastFrame, buildQrText,
  connect, disconnect, renderQr,
  coyoteSetStrength, coyoteStepStrength, coyotePulse, coyotePlay,
  coyoteTempBoost, coyoteClear, coyoteStop, isLive, persistCoyoteState,
} from './lib/coyote.js';
import { COYOTE_WAVES, findWaveform, waveformListText } from './lib/coyote-waves.js';
import { makeWaveform, makeRamp, shapeList } from './lib/coyote-waves-gen.js';
import { coyotePromptLine } from './lib/coyote-prompt.js';
import { stateDirOf, readJson, writeJson, ensureDir } from './lib/state.mjs';

// 给宿主侧（例如提示词拼装）直接用的出口：不装进会话也能 import 这一段
export { coyotePromptLine };

export const name = 'coyote';

// 不需要 settings 的注入（设置值从 apply 的 config 参数拿，热改由 DSH 自己触发重载）。
// webServer 拿不到就不挂 HTTP 接口，tools 拿不到就退化成「只跑逻辑」。
export const inject = ['webServer', 'tools'];

/**
 * 设置项。**每个字段都要 `.extra('volatile', true)`**：
 * DSH 的 settings.update() 只认 volatile 字段，没有这个标记写设置时会抛
 * "Plugin entry … has no volatile fields"。
 * ⚠️ 字段范围**不写 .max()/.min()**：schema 校验不过会让 cordis 拒收这条 entry
 * ⇒ 整条插件不激活。范围一律在读取时钳（clampConfig）。
 */
export const Config = !z ? undefined : z.object({
  /** 总闸：关着时所有工具都回「没开」，也不会连中继 */
  enabled: z.boolean().default(false).extra('volatile', true),
  /** 中继地址。`wss://ws.dungeon-lab.cn/` 是官方公共中继（测试用） */
  url: z.string().default('wss://ws.dungeon-lab.cn/').extra('volatile', true),
  /** 我们自己的强度上限（与 APP 的通道软上限取 min） */
  maxStrength: z.natural().default(100).extra('volatile', true),
  /** 心跳间隔（毫秒）；官方建议 60s 内，过期中继会断 */
  heartbeatMs: z.natural().default(55000).extra('volatile', true),
  /** 多久接不到 APP 回帧就自动全停 + 断开（毫秒） */
  watchdogMs: z.natural().default(15000).extra('volatile', true),
  /** 抬高强度的令牌桶速率（每秒最多涨多少点） */
  increasePerSec: z.natural().default(40).extra('volatile', true),
  /** 一次配对的最长会期（秒） */
  maxSessionSec: z.natural().default(3600).extra('volatile', true),
  /** 单次投放的最长时长（秒） */
  maxPlaySec: z.natural().default(600).extra('volatile', true),
  /** 二维码 PNG 的放大倍数（每个模块几像素） */
  qrScale: z.natural().default(6).extra('volatile', true),
  /** 只在「主人私聊」里注入玩法尾注（多用户宿主一定要开） */
  promptOnlyForOwner: z.boolean().default(true).extra('volatile', true),
  /** 玩法尾注里提到的会话 key（留空＝不限制，任何会话都注） */
  ownerKey: z.string().default('').extra('volatile', true),
});

/** 逐字段按默认值类型归一 —— apply 传进来的 config 字段**不保证是标量**（历史事故：对象当真值）。 */
function clampConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const num = (v, def, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(hi, Math.max(lo, Math.floor(n)));
  };
  const str = (v, def) => (typeof v === 'string' ? v : def);
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  return {
    enabled: bool(r.enabled, false),
    url: str(r.url, 'wss://ws.dungeon-lab.cn/').trim() || 'wss://ws.dungeon-lab.cn/',
    maxStrength: num(r.maxStrength, 100, 1, 200),
    heartbeatMs: num(r.heartbeatMs, 55000, 10000, 120000),
    watchdogMs: num(r.watchdogMs, 15000, 3000, 120000),
    increasePerSec: num(r.increasePerSec, 40, 1, 200),
    maxSessionSec: num(r.maxSessionSec, 3600, 60, 86400),
    maxPlaySec: num(r.maxPlaySec, 600, 1, 3600),
    qrScale: num(r.qrScale, 6, 2, 16),
    promptOnlyForOwner: bool(r.promptOnlyForOwner, true),
    ownerKey: str(r.ownerKey, '').trim(),
  };
}

export function apply(ctx, config) {
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  let myVer = '';
  const myVersion = () => {
    if (myVer) return myVer;
    try { myVer = String(JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version || ''); } catch { myVer = ''; }
    return myVer;
  };

  const stateDir = stateDirOf(ctx);
  const logFile = join(stateDir, 'coyote.log');
  const log = (msg) => {
    const line = `${new Date().toISOString()}  ${msg}`;
    try { appendFileSync(logFile, line + '\n', 'utf8'); } catch { /* 日志写不进去也不致命 */ }
    try { ctx.logger?.info?.(`[coyote] ${msg}`); } catch { /* 没有 logger 就算了 */ }
  };
  for (const n of hostDeps.notes) log(n);

  let cfg = clampConfig(config);
  // 状态落插件自己的家目录（不能往 profile node_modules 里写 —— 升级会被覆盖）
  setStateDir(stateDir);
  ensureDir(outboxDir());

  initCoyote({
    getConfig: () => cfg,
    log, // 模块内部日志走这里，和插件日志同一个文件
  });
  persistCoyoteState();
  log(`已挂载 v${myVersion()}（家=${stateDir}，总闸=${cfg.enabled ? '开' : '关'}，中继=${cfg.url}）`);

  /* ─────────────── 工具 ─────────────── */

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  };
  /** 工具返回值一律过一遍：宿主只吃「无损 JSON」。 */
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
  };
  const tool = (spec) => {
    if (!ctx.tools?.register) return; // 没有 tools 服务就静默跳过（别让 apply 抛）
    ctx.tools.register(defineTool({
      ...spec,
      output: spec.output || textOutput,
      async execute(args, exec) { return safe(await spec.execute(args, exec)); },
    }));
  };

  const ensureOn = () => {
    if (cfg.enabled === true) return null;
    return { ok: false, error: '郊狼插件没开（设置页把 enabled 打开，或在 DSH 设置里改）' };
  };

  tool({
    name: 'coyote_status',
    description: '查郊狼 3.0 现在的状态：插件开关、中继是否连上、APP 是否已配对、A/B 两通道强度与软上限、安全护栏读数（令牌、会期、冷却、看门狗）。只读。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const off = ensureOn();
      if (off) return off;
      return { ok: true, state: coyoteState(), lastFrame: coyoteLastFrame() };
    },
  });

  tool({
    name: 'coyote_qr',
    description: '连中继并出一张配对二维码（PNG 落到插件家目录的 outbox 里，返回绝对路径与二维码文本）。用法：手机开 DG-LAB APP → 首页「Socket 控制」→ 扫码。每次调用都会重新申请一个 clientId，旧码立刻作废。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const off = ensureOn();
      if (off) return off;
      const r = await renderQr();
      if (!r.ok) return { ok: false, error: r.error, state: coyoteState() };
      const file = join(outboxDir(), r.file);
      return { ok: true, file, exists: existsSync(file), text: r.text, modules: r.modules, bytes: r.bytes, state: coyoteState() };
    },
  });

  tool({
    name: 'coyote_connect',
    description: '只连中继（不出二维码）。一般用 coyote_qr 就够了。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const off = ensureOn();
      if (off) return off;
      const r = await connect();
      persistCoyoteState();
      return { ...r, state: coyoteState() };
    },
  });

  tool({
    name: 'coyote_waves',
    description: '列出内置的 16 条官方波形（名字 + 帧数 + 秒数）。放波形前先用它确认名字。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const off = ensureOn();
      if (off) return off;
      return {
        ok: true,
        count: COYOTE_WAVES.length,
        list: waveformListText(),
        waves: COYOTE_WAVES.map((w) => ({ name: w.name, frames: w.frames.length, seconds: Number((w.frames.length / 10).toFixed(1)) })),
      };
    },
  });

  tool({
    name: 'coyote_set',
    description: '把某个通道的强度设成绝对值（0~100，实际还会被 APP 报的软上限和插件 maxStrength 夹）。降强度与归零永远瞬时放行。',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['A', 'B'], description: '通道' },
        value: { type: 'number', description: '目标强度 0~100' },
      },
      required: ['channel', 'value'],
      additionalProperties: false,
    },
    async execute(args) {
      const off = ensureOn();
      if (off) return off;
      return coyoteSetStrength(args.channel, args.value);
    },
  });

  tool({
    name: 'coyote_step',
    description: '按档微调某个通道的强度（正数加、负数减），一次一档最安全。',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['A', 'B'], description: '通道' },
        steps: { type: 'number', description: '正数加几档、负数减几档' },
      },
      required: ['channel', 'steps'],
      additionalProperties: false,
    },
    async execute(args) {
      const off = ensureOn();
      if (off) return off;
      return coyoteStepStrength(args.channel, args.steps);
    },
  });

  tool({
    name: 'coyote_pulse',
    description: '放一段波形。二选一：给 wave（内置波形名，先调 coyote_waves 查）或给 frames（16 位十六进制帧数组，自己编有风险）。单条最多 10 秒；要更久用 coyote_play。',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['A', 'B'], description: '通道' },
        wave: { type: 'string', description: '内置波形名，如 潮汐 / 连击 / 呼吸' },
        frames: { type: 'array', items: { type: 'string' }, description: '16 位 HEX 帧数组（不推荐手写）' },
        seconds: { type: 'number', description: '持续秒数，默认 5，最多 10' },
      },
      required: ['channel'],
      additionalProperties: false,
    },
    async execute(args) {
      const off = ensureOn();
      if (off) return off;
      if (args.wave) {
        const w = findWaveform(String(args.wave));
        if (!w) return { ok: false, error: `没有这个波形：${args.wave}`, available: waveformListText() };
        return coyotePulse(args.channel, w.frames, args.seconds);
      }
      if (Array.isArray(args.frames) && args.frames.length) return coyotePulse(args.channel, args.frames, args.seconds);
      return { ok: false, error: '要给 wave（波形名）或 frames（帧数组）' };
    },
  });

  tool({
    name: 'coyote_build',
    description: '按参数现场造一段波形（只造不播，返回帧数与预览）。形状可选：平 / ramp（渐强）/ rampDown（渐弱）/ wave（起伏）/ pulse（脉冲）/ breathe（呼吸）。频率 10~120（10~30 有冲击感，>100 刺麻），强度 0~100。',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: '时长（秒），默认 5，最多 60' },
        shape: { type: 'string', description: '形状：平/ramp/rampDown/wave/pulse/breathe' },
        freq: { type: 'number', description: '频率值 10~120（越大越刺）' },
        freqTo: { type: 'number', description: '渐变的终点频率' },
        intensity: { type: 'number', description: '强度 0~100' },
        floor: { type: 'number', description: '谷底强度，默认 0' },
        jitter: { type: 'number', description: '随机抖动幅度 0~1' },
        bpm: { type: 'number', description: '按拍子切（0=不用）' },
        seed: { type: 'number', description: '随机种子（同种子同结果）' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const off = ensureOn();
      if (off) return off;
      const built = makeWaveform(args);
      return { ok: true, built: { seconds: built.seconds, peak: built.peak, shape: built.shape, frames: built.frames.length, preview: built.frames.slice(0, 6) } };
    },
  });

  tool({
    name: 'coyote_play',
    description: '播一段长波形（可超过 10 秒，最多 maxPlaySec，默认 600）。三选一给内容：wave（内置波形名）/ 现造参数（shape+freq+intensity 那套）/ 不给就按默认现造。桥接会自动切片续投。',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['A', 'B'], description: '通道' },
        wave: { type: 'string', description: '内置波形名' },
        seconds: { type: 'number', description: '总时长（秒）' },
        shape: { type: 'string', description: '现造时的形状' },
        freq: { type: 'number', description: '现造时的频率' },
        intensity: { type: 'number', description: '现造时的强度' },
      },
      required: ['channel'],
      additionalProperties: false,
    },
    async execute(args) {
      const off = ensureOn();
      if (off) return off;
      let frames = null;
      if (args.wave) {
        const w = findWaveform(String(args.wave));
        if (!w) return { ok: false, error: `没有这个波形：${args.wave}`, available: waveformListText() };
        frames = w.frames;
      } else if (args.shape || args.freq || args.intensity) {
        frames = makeWaveform(args).frames;
      } else {
        frames = makeWaveform({ seconds: 10 }).frames;
      }
      return coyotePlay(args.channel, frames, args.seconds);
    },
  });

  tool({
    name: 'coyote_boost',
    description: '临时顶一下强度，到点自动降回去（回落失败会整体全停兜底）。秒数默认 3、最多 60。',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['A', 'B'], description: '通道' },
        value: { type: 'number', description: '顶到多少（0~100）' },
        seconds: { type: 'number', description: '顶几秒，默认 3' },
      },
      required: ['channel', 'value'],
      additionalProperties: false,
    },
    async execute(args) {
      const off = ensureOn();
      if (off) return off;
      return coyoteTempBoost(args.channel, args.value, args.seconds);
    },
  });

  tool({
    name: 'coyote_clear',
    description: '清掉某个通道排队中的波形（不影响强度）。',
    parameters: {
      type: 'object',
      properties: { channel: { type: 'string', enum: ['A', 'B'], description: '通道' } },
      required: ['channel'],
      additionalProperties: false,
    },
    async execute(args) {
      const off = ensureOn();
      if (off) return off;
      return coyoteClear(args.channel);
    },
  });

  tool({
    name: 'coyote_stop',
    description: '全停：两通道清队列 + 强度归零 + 掐掉正在补投的长波形。幂等、不受任何限速。用户说停/难受时第一时间调它。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const r = coyoteStop();
      persistCoyoteState();
      return r;
    },
  });

  tool({
    name: 'coyote_disconnect',
    description: '断开中继（会先全停）。断开后要重新出二维码配对。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      try { coyoteStop(); } catch { /* 停不掉也照样断 */ }
      const r = disconnect('tool');
      persistCoyoteState();
      return { ...r, state: coyoteState() };
    },
  });

  /* ─────────────── 玩法尾注（给宿主拼提示用） ─────────────── */

  /**
   * 按当前状态给一段「她这轮该知道的事」。
   * 关着 / 没配对 / 不是主人会话都返回空串 —— 群里注这段等于告诉她「你有这能力」
   * 但一调就报错，那是骗她。
   */
  const promptTail = (chatKey = '') => {
    try {
      if (cfg.enabled !== true) return '';
      if (cfg.promptOnlyForOwner && cfg.ownerKey && String(chatKey) !== cfg.ownerKey) return '';
      return coyotePromptLine({ coyoteCfg: cfg, state: coyoteState() });
    } catch (e) {
      log(`尾注失败：${e?.message ?? e}`);
      return '';
    }
  };

  /* ─────────────── 本机 HTTP 接口 ─────────────── */

  const sendJson = (res, status, obj) => {
    try {
      const body = JSON.stringify(obj);
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(body);
    } catch { /* 连回包都写不出去就算了 */ }
  };
  const readBody = async (req, limit = 65536) => {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new Error('请求体太大');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
  };

  /** 只接受本机同源请求（插件跑在宿主里，接口不该被外网/别的网页驱动）。 */
  const sameOriginOk = (req) => {
    try {
      const host = String(req.headers.host || '');
      if (!host) return true;
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false;
      const pick = String(req.headers.origin || req.headers.referer || '');
      if (!pick) return true;
      try {
        const u = new URL(pick);
        return String(u.host || '').toLowerCase() === host.toLowerCase();
      } catch { return false; }
    } catch { return false; }
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (req.method === 'GET' && p === '/api/coyote-3/state') {
      return sendJson(res, 200, {
        ok: true,
        version: myVersion(),
        config: cfg,
        state: coyoteState(),
        lastFrame: coyoteLastFrame(),
        waves: COYOTE_WAVES.length,
        shapes: shapeList(),
        home: stateDir,
      });
    }
    if (req.method === 'POST' && p === '/api/coyote-3/qr') {
      await readBody(req);
      const r = await renderQr();
      if (!r.ok) return sendJson(res, 200, { ok: false, error: r.error, state: coyoteState() });
      return sendJson(res, 200, { ok: true, file: join(outboxDir(), r.file), text: r.text, state: coyoteState() });
    }
    if (req.method === 'POST' && p === '/api/coyote-3/connect') {
      await readBody(req);
      const r = await connect();
      persistCoyoteState();
      return sendJson(res, 200, { ...r, state: coyoteState() });
    }
    if (req.method === 'POST' && p === '/api/coyote-3/stop') {
      await readBody(req);
      const r = coyoteStop();
      persistCoyoteState();
      return sendJson(res, 200, { ...r, state: coyoteState() });
    }
    if (req.method === 'POST' && p === '/api/coyote-3/disconnect') {
      await readBody(req);
      try { coyoteStop(); } catch { /* 停不掉也照样断 */ }
      const r = disconnect('console');
      persistCoyoteState();
      return sendJson(res, 200, { ...r, state: coyoteState() });
    }
    if (req.method === 'POST' && p === '/api/coyote-3/action') {
      const body = await readBody(req);
      const off = ensureOn();
      if (off) return sendJson(res, 200, off);
      try {
        switch (String(body.op || '')) {
          case 'status': return sendJson(res, 200, { ok: true, state: coyoteState() });
          case 'set': return sendJson(res, 200, coyoteSetStrength(body.channel, body.value));
          case 'step': return sendJson(res, 200, coyoteStepStrength(body.channel, body.steps));
          case 'clear': return sendJson(res, 200, coyoteClear(body.channel));
          case 'stop': { const r = coyoteStop(); persistCoyoteState(); return sendJson(res, 200, r); }
          default: return sendJson(res, 400, { ok: false, error: `未知操作：${body.op}` });
        }
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
      }
    }
    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${p}` });
  };

  if (ctx.webServer?.register) {
    try {
      ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: '/api/coyote-3',
        handler: async (req, res) => {
          if (!sameOriginOk(req)) {
            sendJson(res, 403, { ok: false, error: '只接受本机同源请求' });
            return;
          }
          try { await handle(req, res); } catch (e) {
            sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
          }
        },
      }), 'coyote: /api/coyote-3 路由');
    } catch (e) {
      log(`HTTP 路由没挂上：${e?.message ?? e}`);
    }
  } else {
    log('没有 webServer 服务 —— 只注册工具，不挂 HTTP 接口');
  }

  // 卸载/停用插件时确保不再通电（这是这个插件唯一不能忘的收尾）
  ctx.effect(() => () => {
    try { coyoteStop(); } catch { /* 已经停了 */ }
    try { disconnect('unload'); } catch { /* 已经断了 */ }
  }, 'coyote: 卸载时全停 + 断开');

  // 设置热改：DSH 重新 apply 时会带新 config；这里也留一个读取入口给测试
  ctx.coyote3 = { getConfig: () => cfg, setConfig: (next) => { cfg = clampConfig(next); return cfg; }, promptTail, state: coyoteState };
  return { promptTail };
}
