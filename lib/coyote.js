// coyote.js · 让小鱼能操控「郊狼 3.0」脉冲主机（DG-LAB / 电击理疗仪）
//
// 为什么走 SOCKET 而不是蓝牙：
//   蓝牙要一台一直开着的安卓机当桥、还要 BLE 扫描/配对/20 字节 0xB0 帧的手工拼包；
//   而官方 SOCKET 协议是**纯 WebSocket + JSON**，郊狼 3.0 的 APP 自己扫码连上来，
//   我们这一侧只要发字符串指令就行。零新依赖（Node 22 自带全局 WebSocket）、
//   零 BLE 代码、跨平台。这是官方给第三方控制端留的正门。
//
// 协议要点（来自官方开源仓库 dungeonlab-open/dglab-websocket-simple socket/v2/README.md）：
//   · 连上中继后服务端立刻下发 `{"type":"bind","clientId":"<我们的ID>","targetId":"","message":"targetId"}`，
//     clientId 就是「终端 ID」，要编进二维码里。
//   · 二维码格式**必须**严格是
//       https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#<ws地址>/<终端ID>
//     有且仅有两个 `#`；APP 扫到后连上来，发 `bind`，服务端回 `message:"200"` 表示配对成功。
//   · 强度：`{"type":3,"channel":1|2,"strength":0..200,"message":"set channel"}`（1=A 通道 2=B 通道）；
//     `type:2` 加 1、`type:1` 减 1、`type:4` + `message:"clear"` 清空该通道波形队列。
//   · 波形：`{"type":"clientMsg","channel":"A"|"B","time":秒,"message":'A:["HEX",...]'}`
//     —— 每帧 8 字节 HEX = 100ms；数组最长 100（10 秒）。服务端会按 time 反复重发。
//   · APP 会主动回传 `{"type":"msg","message":"strength-<A强度>+<B强度>+<A上限>+<B上限>"}`，
//     以及 `feedback-<0..9>`（APP 上的反馈按钮）。这是我们知道真实状态的唯一途径。
//   · `break` + `209` = 对端断开；`error` + 错误码 = 服务端拒绝。
//
// 安全边界（这一条比别的插件都重要，因为接的是会电人的硬件）：
//   1. 默认**关闭**（`config.coyote.enabled` 必须是 true），关着时一个字节都不发。
//   2. 强度双重夹紧：既不许超过 APP 自己报的软上限（`strength-LIMIT` 里的后两个数），
//      也不许超过 `config.coyote.maxStrength`（默认 100，硬上限 200 是协议值）。
//      两道取小 —— APP 那边的软上限是用户自己拧的，比我们的配置更权威。
//   3. 波形时长夹在 0.2~10 秒（协议上限 10 秒 = 100 帧），帧数组在这里就裁好。
//   4. 所有指令都要求「已配对」，没配对直接报错，不会攒着等配对后一次性放出去。
//   5. `stop()` 先清两个通道的波形队列再把强度归零 —— 只说"停"不清队列的话，
//      APP 里那几百帧还会继续放完。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// 落盘路径：原来是「仓库根/state」，那是嵌在 qq-bridge 里时的写法。
// 做成独立 DSH 插件后没有「仓库根」这个概念 —— 插件装进 profile 的 node_modules 里，
// 往里写东西会在升级时被覆盖。所以改成**插件自己的家目录**，由 setStateDir() 注入
// （index.js 用 DSH 的 dshHomePath 解析出 ~/.dsh/coyote-3，拿不到就退回 os.tmpdir()）。
// 没注入时用一个惰性兜底：第一次真要写盘时才解析，避免模块加载期就碰 $DSH_HOME。
let STATE_DIR = '';
let OUTBOX = '';
let STATE_FILE = '';
function resolveStateDir() {
  if (STATE_DIR) return STATE_DIR;
  const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  STATE_DIR = path.join(base, 'coyote-3');
  OUTBOX = path.join(STATE_DIR, 'outbox');
  STATE_FILE = path.join(STATE_DIR, 'state.json');
  return STATE_DIR;
}
/**
 * 注入状态目录（插件 apply() 里调一次）。
 * @param {string} dir 绝对路径
 */
export function setStateDir(dir) {
  const d = String(dir || '').trim();
  if (!d) return false;
  STATE_DIR = path.resolve(d);
  OUTBOX = path.join(STATE_DIR, 'outbox');
  STATE_FILE = path.join(STATE_DIR, 'state.json');
  return true;
}
/** 二维码 PNG 落在哪个目录（index.js 发图时要用）。 */
export function outboxDir() {
  resolveStateDir();
  return OUTBOX;
}

// 二维码用 vendored 的 QRCode.js（qrcode-terminal 0.12.0 里那份，MIT）。
// 为什么不用 npm 装 qrcode：依赖面刻意保持小，而且画一张二维码真的只需要
// 「模块矩阵 + 一个 PNG 编码器」，装一个库反而更重。见 lib/vendor/qrcode/SOURCE.txt。
const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', 'qrcode') + path.sep;
const vendorRequire = createRequire(VENDOR_DIR);
let QRCodeCtor = null;
let QRErrorCorrectLevelM = null;
function loadQrLib() {
  if (QRCodeCtor && QRErrorCorrectLevelM) return true;
  try {
    QRCodeCtor = vendorRequire('./index.js');
    const ecl = vendorRequire('./QRErrorCorrectLevel.js');
    QRErrorCorrectLevelM = ecl.M;
    return true;
  } catch {
    return false;
  }
}

// ── 极简 PNG 编码器（灰度 8bit，无压缩滤波）───────────────────────────────
// 只需要「一张黑白点阵」，所以固定 color type 0、bit depth 8、filter 0。
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** 把 QRCode 实例的模块矩阵渲染成 PNG（1 模块 = scale 像素，四周留 quietZone 模块白边）。 */
function qrToPng(qr, { scale = 6, quietZone = 4 } = {}) {
  const count = qr.getModuleCount();
  const side = (count + quietZone * 2) * scale;
  const raw = Buffer.alloc((side + 1) * side, 0xff);
  for (let y = 0; y < side; y += 1) {
    const rowStart = y * (side + 1);
    raw[rowStart] = 0; // filter type 0
    const my = Math.floor(y / scale) - quietZone;
    for (let x = 0; x < side; x += 1) {
      const mx = Math.floor(x / scale) - quietZone;
      const dark = my >= 0 && my < count && mx >= 0 && mx < count && qr.isDark(my, mx);
      raw[rowStart + 1 + x] = dark ? 0x00 : 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ── 常量 ──────────────────────────────────────────────────────────────────
export const COYOTE_DEFAULTS = Object.freeze({
  // 默认关：这东西接的是会电人的硬件，必须显式打开。
  enabled: false,
  // 官方公共中继。想自己架就把 README 里那套 backend 跑起来，填自己的 ws:// 地址。
  url: 'wss://ws.dungeon-lab.cn/',
  // 我们自己这一侧再夹一道上限（APP 的软上限优先，两者取小）。
  maxStrength: 100,
  // 心跳间隔：官方默认 60 秒，桥接侧也照这个发，免得服务端认为我们掉线。
  heartbeatMs: 55000,
  // 连上后没人扫二维码，多久自动断开（省得一直挂着一个空连接）。
  idleTimeoutMs: 5 * 60 * 1000,
  // 二维码 PNG 的模块像素尺寸。
  qrScale: 6,

  // ── 安全信封（2026-11-20 补，抄社区成熟方案里被反复验证的那几条）────────
  // 上调速率限制：令牌桶，每秒补这么多点。**只限「往上加」，下调与归零永远瞬时放行**
  // —— 出事的时候不能让限流挡着急停。
  increasePerSec: 40,
  // 两次「开一场」之间的冷却（毫秒）。防止连着点几下把强度一路顶上去。
  sessionCooldownMs: 3000,
  // 单次波形最长播放秒数（硬停，不是建议值）。
  maxPlaySec: 600,
  // 单场会话最长秒数，到点强制停。
  maxSessionSec: 3600,
  // 看门狗：配对后这么久没收到 APP 的 strength 回报，就认为链路哑了，自动全停。
  watchdogMs: 15000
});

const CHANNELS = Object.freeze({ A: 1, B: 2, a: 1, b: 2, '1': 1, '2': 2 });

function channelOf(input) {
  const key = String(input ?? 'A').trim();
  const n = CHANNELS[key];
  if (!n) throw new Error(`通道只能是 A 或 B（收到「${key}」）`);
  return n;
}

function channelLetter(n) {
  return n === 2 ? 'B' : 'A';
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ── 状态机 ────────────────────────────────────────────────────────────────
// 单例：一台主机、一个连接。多开会互相打架（同一 clientId 只允许一个配对）。
const state = {
  connected: false, // 我们到中继的 WebSocket 是否开着
  paired: false, // APP 是否已扫码连上来
  clientId: '', // 我们的终端 ID（编进二维码）
  targetId: '', // APP 那侧的 ID
  url: COYOTE_DEFAULTS.url,
  strength: { A: 0, B: 0 },
  softLimit: { A: 200, B: 200 }, // APP 报的软上限，没报过就按协议最大值
  lastError: '',
  lastFrameAt: 0,
  pairedAt: 0,
  connectStartedAt: 0,
  // ── 安全信封的运行时账本 ──
  sessionStartedAt: 0, // 本场什么时候开的（配对上那一刻）
  startedByUs: false, // 最近一次强度上调是不是我们发的（区分 APP 手动还是自动）
  lastPlayEndsAt: 0, // 上一段波形预计播完的时刻
  cooldownUntil: 0 // 在此之前不许「开新的一场」
};

let socket = null;
let heartbeatTimer = null;
let idleTimer = null;
let logHook = null;
let cfgGetter = null;
let lastFrameText = '';
const listeners = new Set();

function log(text) {
  if (typeof logHook === 'function') logHook(text);
}

function cfg() {
  const raw = typeof cfgGetter === 'function' ? cfgGetter() : null;
  return { ...COYOTE_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
}

function emit(event) {
  for (const fn of listeners) {
    try { fn(event); } catch {}
  }
}

function effectiveLimit(channel) {
  const c = cfg();
  const ours = clampNumber(c.maxStrength, 0, 200, COYOTE_DEFAULTS.maxStrength);
  const appSaid = clampNumber(state.softLimit[channel], 0, 200, 200);
  return Math.min(ours, appSaid);
}

// ── 令牌桶（只限「往上加」）────────────────────────────────────────────────
// 为什么只限一边：出事的时候要立刻能降、能归零。把限流套在急停上就是帮倒忙。
// 往上加是唯一会「把人推到受不了」的方向，所以只掐它。
const bucket = { tokens: 40, at: Date.now() };

function bucketRefill() {
  const c = cfg();
  const rate = clampNumber(c.increasePerSec, 1, 200, COYOTE_DEFAULTS.increasePerSec);
  const now = Date.now();
  const elapsed = Math.max(0, now - bucket.at) / 1000;
  bucket.at = now;
  bucket.tokens = Math.min(rate * 2, bucket.tokens + elapsed * rate);
  return rate;
}

/**
 * 申请 n 个「上调额度」。不够就抛错，不排队 —— 排队意味着指令会在几秒后
 * 突然一起生效，那比干脆拒绝更危险。
 */
function takeTokens(n) {
  const want = Math.max(0, Math.round(Number(n) || 0));
  if (want === 0) return;
  bucketRefill();
  if (bucket.tokens < want) {
    const rate = cfg().increasePerSec;
    throw new Error(`加得太快了（这一秒还剩 ${bucket.tokens.toFixed(1)} 点额度，要 ${want}）。上限 ${rate}/秒，等一下再继续；降强度不受限制。`);
  }
  bucket.tokens -= want;
}

/** 把额度还回去（发失败时用）。 */
function refundTokens(n) {
  const want = Math.max(0, Math.round(Number(n) || 0));
  if (want > 0) bucket.tokens += want;
}

// ── 会期闸（单次时长 / 单场时长）───────────────────────────────────────────
function sessionAgeSec() {
  return state.sessionStartedAt ? (Date.now() - state.sessionStartedAt) / 1000 : 0;
}

function checkSession() {
  const c = cfg();
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    const left = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
    throw new Error(`刚停过一场，冷却 ${left} 秒后才能再来（防手滑连点）`);
  }
  const cap = clampNumber(c.maxSessionSec, 60, 6 * 3600, COYOTE_DEFAULTS.maxSessionSec);
  if (state.sessionStartedAt && sessionAgeSec() > cap) {
    throw new Error(`这一场已经 ${Math.round(sessionAgeSec() / 60)} 分钟，超过 ${Math.round(cap / 60)} 分钟的上限；先 stop 再重新开`);
  }
}

// ── 看门狗：APP 不吭声就自己断电 ───────────────────────────────────────────
// 配对后 APP 每次改强度都会回 `strength-*`，所以 lastFrameAt 是活的探针。
// 链路真断了（手机息屏、走出 WiFi），我们不能假设「没消息 = 没变化」而继续按旧值放。
let watchdogTimer = null;
let watchdogFired = 0;

function armWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
  const ms = Math.max(1000, Math.floor(clampNumber(cfg().watchdogMs, 3000, 120000, COYOTE_DEFAULTS.watchdogMs) / 3));
  watchdogTimer = setInterval(() => {
    if (!isLive()) return;
    const idle = Date.now() - (state.lastFrameAt || state.pairedAt || Date.now());
    const limit = clampNumber(cfg().watchdogMs, 3000, 120000, COYOTE_DEFAULTS.watchdogMs);
    if (idle <= limit) return;
    watchdogFired += 1;
    log(`[coyote] 看门狗：APP 已经 ${Math.round(idle / 1000)} 秒没回报任何帧，按链路失联处理 —— 全停`);
    try { coyoteStop(); } catch {}
    try { disconnect('watchdog'); } catch {}
  }, ms);
  if (watchdogTimer.unref) watchdogTimer.unref();
}

function disarmWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

/** 有没有真的在跑（连接开着 + 已配对）。所有控制指令都先过这一关。 */
export function isLive() {
  return state.connected === true && state.paired === true;
}

/** 当前状态快照（给工具 / 控制台看，不含 WebSocket 对象）。 */
export function coyoteState() {
  const c = cfg();
  const now = Date.now();
  bucketRefill();
  return {
    enabled: c.enabled === true,
    running: isLive(),
    connected: state.connected,
    paired: state.paired,
    clientId: state.clientId,
    url: state.url,
    strength: { ...state.strength },
    softLimit: { ...state.softLimit },
    maxStrength: clampNumber(c.maxStrength, 0, 200, COYOTE_DEFAULTS.maxStrength),
    lastError: state.lastError,
    lastFrameAt: state.lastFrameAt,
    pairedAt: state.pairedAt,
    // ── 安全信封的实时读数（控制台/工具都靠这几个数判断还能不能加）──
    tokens: Math.floor(bucket.tokens),
    sessionSec: state.sessionStartedAt ? Math.round((now - state.sessionStartedAt) / 1000) : 0,
    maxSessionSec: clampNumber(c.maxSessionSec, 60, 6 * 3600, COYOTE_DEFAULTS.maxSessionSec),
    cooldownLeftSec: state.cooldownUntil > now ? Math.ceil((state.cooldownUntil - now) / 1000) : 0,
    playing: playTimers.size > 0,
    watchdogFired,
    // 没配对时把二维码内容一起给出来，控制台/工具不用再单独调一次。
    qrText: state.clientId ? buildQrText(state.clientId) : ''
  };
}

/** 官方严格格式：两个 `#`，最后一段是 ws 地址 + `/` + 终端 ID。 */
export function buildQrText(clientId) {
  const c = cfg();
  const base = String(c.url || COYOTE_DEFAULTS.url).replace(/\/+$/, '');
  return `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#${base}/${clientId}`;
}

function sendFrame(frame) {
  if (!socket || socket.readyState !== 1) throw new Error('还没连上中继（先 connect）');
  if (!state.paired) throw new Error('APP 还没扫码连上来（先出二维码让用户扫）');
  const payload = JSON.stringify({ ...frame, clientId: state.clientId, targetId: state.targetId });
  // 协议硬限制：单条 JSON > 1950 字符 APP 会直接丢。
  if (payload.length > 1950) throw new Error(`这一条指令太长（${payload.length} 字符 > 1950），APP 会丢弃`);
  socket.send(payload);
  return payload.length;
}

// ── 连接 ──────────────────────────────────────────────────────────────────
function stopTimers() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  disarmWatchdog();
}

function armIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  const ms = clampNumber(cfg().idleTimeoutMs, 10000, 30 * 60 * 1000, COYOTE_DEFAULTS.idleTimeoutMs);
  idleTimer = setTimeout(() => {
    if (!state.paired) {
      log('[coyote] 5 分钟没人扫码，自动断开中继（省得挂着空连接）');
      disconnect('idle');
    }
  }, ms);
  if (idleTimer.unref) idleTimer.unref();
}

function armHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  const ms = clampNumber(cfg().heartbeatMs, 5000, 5 * 60 * 1000, COYOTE_DEFAULTS.heartbeatMs);
  heartbeatTimer = setInterval(() => {
    if (!socket || socket.readyState !== 1 || !state.paired) return;
    try {
      socket.send(JSON.stringify({
        type: 'heartbeat',
        clientId: state.clientId,
        targetId: state.targetId,
        message: '200'
      }));
    } catch {}
  }, ms);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function handleFrame(frame) {
  if (!frame || typeof frame !== 'object') return;
  switch (frame.type) {
    case 'bind':
      // 首次：clientId 有了、targetId 还是空 —— 我们还等着人扫码。
      if (typeof frame.clientId === 'string' && frame.clientId) state.clientId = frame.clientId;
      if (typeof frame.targetId === 'string' && frame.targetId === '') {
        state.paired = false;
        emit({ type: 'ready', clientId: state.clientId });
        return;
      }
      if (frame.message === '200' && typeof frame.targetId === 'string' && frame.targetId) {
        state.paired = true;
        state.targetId = frame.targetId;
        state.pairedAt = Date.now();
        // 配对成功 = 「开一场」的起点。会期上限与看门狗都从这里开始算。
        state.sessionStartedAt = state.pairedAt;
        state.lastFrameAt = state.pairedAt;
        state.lastError = '';
        bucketRefill();
        bucket.tokens = clampNumber(cfg().increasePerSec, 1, 200, COYOTE_DEFAULTS.increasePerSec) * 2;
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        armHeartbeat();
        armWatchdog();
        log('[coyote] APP 已扫码连上（配对完成）');
        emit({ type: 'paired', targetId: state.targetId });
        return;
      }
      return;
    case 'msg':
      if (typeof frame.message !== 'string') return;
      lastFrameText = frame.message;
      state.lastFrameAt = Date.now();
      // strength-<A强度>+<B强度>+<A上限>+<B上限>
      {
        const m = /^strength-(\d+)\+(\d+)\+(\d+)\+(\d+)$/.exec(frame.message);
        if (m) {
          state.strength.A = Number(m[1]);
          state.strength.B = Number(m[2]);
          state.softLimit.A = Number(m[3]);
          state.softLimit.B = Number(m[4]);
          emit({ type: 'strength', ...state.strength, limit: { ...state.softLimit } });
          return;
        }
      }
      {
        const m = /^feedback-(\d+)$/.exec(frame.message);
        if (m) {
          emit({ type: 'feedback', index: Number(m[1]) });
          return;
        }
      }
      return;
    case 'break':
      state.paired = false;
      state.targetId = '';
      stopTimers();
      log('[coyote] APP 断开了（break），强度已归零');
      state.strength = { A: 0, B: 0 };
      state.sessionStartedAt = 0;
      // 断开后留一个冷却窗：就算有人立刻重连，也不会马上就「接着上一场」往上顶。
      state.cooldownUntil = Date.now() + clampNumber(cfg().sessionCooldownMs, 0, 60000, COYOTE_DEFAULTS.sessionCooldownMs);
      emit({ type: 'unpaired', reason: 'break' });
      return;
    case 'error': {
      const code = String(frame.message ?? '');
      state.lastError = `服务端错误 ${code}`;
      log(`[coyote] 服务端报错：${code}`);
      emit({ type: 'error', code });
      return;
    }
    default:
  }
}

/**
 * 连上中继，拿 clientId，准备好二维码。
 * @returns {Promise<{ok:boolean, clientId?:string, qrText?:string, error?:string}>}
 */
export function connect() {
  const c = cfg();
  if (c.enabled !== true) return Promise.resolve({ ok: false, error: '郊狼插件没开（config.coyote.enabled 是 false）' });
  if (socket && socket.readyState === 1 && state.clientId) {
    return Promise.resolve({ ok: true, clientId: state.clientId, qrText: state.paired ? '' : buildQrText(state.clientId), already: true });
  }
  if (socket) { try { socket.close(); } catch {} socket = null; }
  state.url = String(c.url || COYOTE_DEFAULTS.url);
  state.connected = false;
  state.paired = false;
  state.clientId = '';
  state.targetId = '';
  state.lastError = '';
  state.connectStartedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    let ws;
    try {
      ws = new WebSocket(state.url);
    } catch (error) {
      state.lastError = `连不上中继：${error?.message ?? error}`;
      finish({ ok: false, error: state.lastError });
      return;
    }
    socket = ws;
    // 15 秒内拿不到 clientId 就当连接失败（公共中继偶尔会卡）。
    const timer = setTimeout(() => {
      if (!state.clientId) {
        state.lastError = '连上去了但 15 秒没拿到终端 ID（中继没响应）';
        try { ws.close(); } catch {}
        finish({ ok: false, error: state.lastError });
      }
    }, 15000);

    ws.addEventListener('open', () => {
      state.connected = true;
      emit({ type: 'open', url: state.url });
    });
    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : '';
      let frame = null;
      try { frame = JSON.parse(raw); } catch { return; }
      handleFrame(frame);
      if (state.clientId && !settled) {
        clearTimeout(timer);
        armIdleTimer();
        finish({ ok: true, clientId: state.clientId, qrText: buildQrText(state.clientId) });
      }
    });
    ws.addEventListener('error', (ev) => {
      const msg = ev?.message ?? ev?.error?.message ?? 'WebSocket 错误';
      state.lastError = `中继连接错误：${msg}`;
      emit({ type: 'socket-error', message: state.lastError });
    });
    ws.addEventListener('close', (ev) => {
      const wasPaired = state.paired;
      state.connected = false;
      state.paired = false;
      state.targetId = '';
      stopTimers();
      // 链路断了：手上的补投循环与临时抬高定时器必须一起掐掉，
      // 否则它们会在几秒后往一个已经断掉的 socket 上继续发（或者更糟：重连后突然生效）。
      clearTempBoost();
      coyoteHaltPlayback();
      state.sessionStartedAt = 0;
      if (socket === ws) socket = null;
      if (!settled) {
        clearTimeout(timer);
        finish({ ok: false, error: state.lastError || `中继断开（code=${ev?.code ?? '?'}）` });
      }
      emit({ type: 'close', code: ev?.code ?? 0, wasPaired });
    });
  });
}

/** 断开中继（会顺带把强度归零，别让 APP 拿着最后一个数字一直电）。 */
export function disconnect(reason = 'manual') {
  if (isLive()) {
    try { coyoteStop(); } catch {}
  }
  clearTempBoost();
  coyoteHaltPlayback();
  stopTimers();
  const ws = socket;
  socket = null;
  state.connected = false;
  state.paired = false;
  state.targetId = '';
  state.clientId = '';
  state.strength = { A: 0, B: 0 };
  state.sessionStartedAt = 0;
  if (ws) { try { ws.close(); } catch {} }
  log(`[coyote] 已断开中继（${reason}）`);
  emit({ type: 'disconnect', reason });
}

// ── 出二维码 ──────────────────────────────────────────────────────────────
/**
 * 把二维码渲染成 PNG 落到 state/outbox，返回文件名（可直接喂给 qq_send_image）。
 * @returns {Promise<{ok:boolean, file?:string, text?:string, error?:string}>}
 */
export async function renderQr() {
  resolveStateDir(); // 先把 OUTBOX 解出来（没注入时走兜底，见文件头注释）
  const c = cfg();
  if (c.enabled !== true) return { ok: false, error: '郊狼插件没开' };
  if (!state.clientId) {
    const r = await connect();
    if (!r.ok) return { ok: false, error: r.error };
  }
  if (state.paired) {
    return { ok: false, error: 'APP 已经连上了，不用再扫码；要换设备先 disconnect' };
  }
  if (!loadQrLib()) return { ok: false, error: '二维码库加载失败（lib/vendor/qrcode 缺文件？）' };
  const text = buildQrText(state.clientId);
  let qr;
  try {
    qr = new QRCodeCtor(-1, QRErrorCorrectLevelM);
    qr.addData(text);
    qr.make();
  } catch (error) {
    return { ok: false, error: `生成二维码失败：${error?.message ?? error}` };
  }
  try {
    fs.mkdirSync(OUTBOX, { recursive: true });
    const file = `coyote-qr-${Date.now()}.png`;
    const png = qrToPng(qr, { scale: clampNumber(c.qrScale, 2, 16, 6) });
    fs.writeFileSync(path.join(OUTBOX, file), png);
    log(`[coyote] 二维码已生成：${file}（${png.length} 字节，${qr.getModuleCount()}×${qr.getModuleCount()} 模块）`);
    return { ok: true, file, text, modules: qr.getModuleCount(), bytes: png.length };
  } catch (error) {
    return { ok: false, error: `写二维码文件失败：${error?.message ?? error}` };
  }
}

// ── 强度 ──────────────────────────────────────────────────────────────────
/**
 * 设成绝对值。会被「我们的 maxStrength」和「APP 报的软上限」两者取小夹住。
 *
 * 安全信封（2026-11-20 补）：
 *   · 往上加要过令牌桶（默认 40/秒），降和归零**永不受限**；
 *   · 过会期闸（单场上限、连点冷却）；
 *   · 返回值里带 `clamped` 与 `limit`，让调用方知道「你要 180，我只给了 100」
 *     —— 静默限幅最坑人，模型会以为设成功了。
 *
 * @param {'A'|'B'|1|2} channel
 * @param {number} value 0~200
 */
export function coyoteSetStrength(channel, value) {
  if (!isLive()) throw new Error('郊狼没连着（先 connect 并让 APP 扫码）');
  const n = channelOf(channel);
  const letter = channelLetter(n);
  const limit = effectiveLimit(n);
  const want = clampNumber(value, 0, 200, 0);
  const applied = Math.min(want, limit);
  const current = Number(state.strength[letter]) || 0;
  const rise = applied - current;
  if (rise > 0) {
    checkSession();
    takeTokens(rise);
    try {
      sendFrame({ type: 3, channel: n, strength: applied, message: 'set channel' });
    } catch (error) {
      refundTokens(rise);
      throw error;
    }
  } else {
    // 降 / 归零：不限流、不查会期。急停优先级最高。
    sendFrame({ type: 3, channel: n, strength: applied, message: 'set channel' });
  }
  state.strength[letter] = applied;
  state.startedByUs = rise > 0;
  return { channel: letter, value: applied, limit, clamped: applied !== want, rise: Math.max(0, rise) };
}

/** 在当前基础上加/减（一步 = 1）。走协议原生的 type 1/2，APP 那边会按自己的步进处理。 */
export function coyoteStepStrength(channel, steps) {
  if (!isLive()) throw new Error('郊狼没连着（先 connect 并让 APP 扫码）');
  const n = channelOf(channel);
  const letter = channelLetter(n);
  const raw = Math.round(Number(steps) || 0);
  if (raw === 0) throw new Error('步数不能为 0');
  const limit = effectiveLimit(n);
  const current = Number(state.strength[letter]) || 0;
  const target = Math.min(limit, Math.max(0, current + raw));
  const delta = target - current;
  if (delta === 0) {
    return { channel: letter, value: current, limit, clamped: true, moved: 0 };
  }
  // 协议里的 1/2 每次只动一档，所以按需要发多条（上限 200 次，正常不会到）。
  const type = delta > 0 ? 2 : 1;
  const times = Math.min(200, Math.abs(delta));
  if (type === 2) {
    checkSession();
    takeTokens(times);
  }
  let sent = 0;
  try {
    for (; sent < times; sent += 1) {
      sendFrame({ type, channel: n, message: 'set channel' });
    }
  } catch (error) {
    if (type === 2) refundTokens(times - sent);
    if (sent > 0) state.strength[letter] = current + sent;
    throw error;
  }
  const applied = current + (type === 2 ? times : -times);
  state.strength[letter] = applied;
  state.startedByUs = type === 2;
  return { channel: letter, value: applied, limit, clamped: applied !== current + raw, moved: applied - current };
}

// ── 波形 ──────────────────────────────────────────────────────────────────
/**
 * 播一段波形（单次，最长 10 秒）。
 * @param {'A'|'B'|1|2} channel
 * @param {string[]} frames 8 字节 HEX 帧数组，一帧 = 100ms
 * @param {number} seconds 总时长（秒）。服务端按这个时长反复重发这段波形。
 */
export function coyotePulse(channel, frames, seconds = 5) {
  if (!isLive()) throw new Error('郊狼没连着（先 connect 并让 APP 扫码）');
  const n = channelOf(channel);
  const letter = channelLetter(n);
  const list = Array.isArray(frames) ? frames.filter((f) => /^[0-9a-fA-F]{16}$/.test(String(f))) : [];
  if (!list.length) throw new Error('波形帧必须是 8 字节 HEX（16 个十六进制字符），且至少一帧');
  const capped = list.slice(0, 100); // 协议上限 100 帧 = 10 秒
  const time = Math.min(10, Math.max(0.2, Number(seconds) || 5));
  const message = `${letter}:${JSON.stringify(capped)}`;
  if (message.length > 1900) throw new Error(`这段波形太长（${message.length} 字符），超过了 1950 的上限`);
  sendFrame({ type: 'clientMsg', channel: letter, time, message });
  state.lastPlayEndsAt = Date.now() + time * 1000;
  return { channel: letter, frames: capped.length, seconds: time, truncated: capped.length < list.length };
}

// ── 长波形投放（自动切片 + 补投）───────────────────────────────────────────
// APP 的波形队列只有 500 条 = 50 秒，而单条消息最多 100 帧 = 10 秒。
// 想放两分钟就得「投一段 → 等队列空出 → 再投」，而且要先 clear 再投
// （网络抖动会让 clear 晚于 pulse 到达，那一整段就丢了）。
// 这套循环的参数（每次 ≤8.6 秒、clear 后等一下再发）是社区 DG-Lab-Play 踩出来的。
let playTimers = new Set();
let playSeq = 0;

function clearPlayTimers() {
  for (const t of playTimers) { try { clearTimeout(t); } catch {} }
  playTimers.clear();
}

/**
 * 把一段波形持续播放 seconds 秒（可以远超 10 秒）。
 * 返回后自己接管补投，直到播完或被 stop 打断。
 *
 * @param {'A'|'B'|1|2} channel
 * @param {string[]} frames
 * @param {number} seconds 想播多久（会被 maxPlaySec 夹住）
 */
export function coyotePlay(channel, frames, seconds = 30) {
  if (!isLive()) throw new Error('郊狼没连着（先 connect 并让 APP 扫码）');
  const n = channelOf(channel);
  const letter = channelLetter(n);
  const list = Array.isArray(frames) ? frames.filter((f) => /^[0-9a-fA-F]{16}$/.test(String(f))) : [];
  if (!list.length) throw new Error('波形帧必须是 8 字节 HEX（16 个十六进制字符），且至少一帧');
  const cap = clampNumber(cfg().maxPlaySec, 10, 3600, COYOTE_DEFAULTS.maxPlaySec);
  const total = Math.min(cap, Math.max(1, Number(seconds) || 30));
  const chunk = list.slice(0, 100);
  // 每次投多少秒：优先整数秒，且不超过一条消息能塞下的量。
  const chunkSec = Math.max(0.5, Math.min(8.6, chunk.length / 10));
  const rounds = Math.max(1, Math.ceil(total / chunkSec));

  playSeq += 1;
  const mySeq = playSeq;
  clearPlayTimers();
  try { sendFrame({ type: 4, channel: n, message: 'clear' }); } catch {}

  let sent = 0;
  const post = () => {
    if (mySeq !== playSeq) return; // 被新的播放顶掉了
    if (!isLive()) return;
    if (sent >= rounds) return;
    try {
      const message = `${letter}:${JSON.stringify(chunk)}`;
      sendFrame({ type: 'clientMsg', channel: letter, time: chunkSec, message });
      sent += 1;
      state.lastPlayEndsAt = Date.now() + chunkSec * 1000;
    } catch (error) {
      log(`[coyote] 补投失败，提前收尾：${error?.message ?? error}`);
      return;
    }
    if (sent < rounds) {
      const t = setTimeout(post, Math.round(chunkSec * 1000 * 0.8));
      if (t.unref) t.unref();
      playTimers.add(t);
    }
  };
  // 先等 150ms 再投第一段：给 clear 让路（这是社区实测出来的，不是保险起见）。
  const first = setTimeout(post, 150);
  if (first.unref) first.unref();
  playTimers.add(first);

  log(`[coyote] 开始播放 ${letter} 通道：${chunkSec.toFixed(1)} 秒/段 × ${rounds} 段 ≈ ${total} 秒`);
  return { channel: letter, frames: chunk.length, chunkSec: +chunkSec.toFixed(2), rounds, seconds: total, capped: total < Number(seconds) };
}

/** 打断正在进行的补投（stop 会自己调，也可以单独调）。 */
export function coyoteHaltPlayback() {
  playSeq += 1;
  clearPlayTimers();
  return { ok: true };
}

// ── 临时抬高（到点自己降回去）─────────────────────────────────────────────
// 「顶一下再回来」是这类设备最常用的一招，但用裸指令没法安全表达：
// 发完就没人记得降回去了。这里用定时器兜住，stop / 断连也会清掉。
let tempTimer = null;
let tempRestore = null;

/**
 * 临时把强度抬到 value 秒数 seconds，到点自动回到原值。
 * @param {'A'|'B'|1|2} channel
 * @param {number} value
 * @param {number} seconds
 */
export function coyoteTempBoost(channel, value, seconds = 3) {
  if (!isLive()) throw new Error('郊狼没连着（先 connect 并让 APP 扫码）');
  const letter = channelLetter(channelOf(channel));
  const before = Number(state.strength[letter]) || 0;
  const r = coyoteSetStrength(channel, value);
  if (tempTimer) { try { clearTimeout(tempTimer); } catch {} tempTimer = null; }
  tempRestore = { channel: letter, to: before };
  const ms = Math.max(200, Math.min(60000, Math.round((Number(seconds) || 3) * 1000)));
  tempTimer = setTimeout(() => {
    tempTimer = null;
    const plan = tempRestore;
    tempRestore = null;
    if (!plan || !isLive()) return;
    try {
      coyoteSetStrength(plan.channel, plan.to);
      log(`[coyote] 临时抬高结束，${plan.channel} 通道回到 ${plan.to}`);
    } catch (error) {
      log(`[coyote] 临时抬高回落失败（已尽量归零）：${error?.message ?? error}`);
      try { coyoteStop(); } catch {}
    }
  }, ms);
  if (tempTimer.unref) tempTimer.unref();
  return { channel: letter, from: before, to: r.value, seconds: ms / 1000, restoreTo: before };
}

function clearTempBoost() {
  if (tempTimer) { try { clearTimeout(tempTimer); } catch {} tempTimer = null; }
  tempRestore = null;
}

/** 清空某通道的波形队列（APP 里攒着的帧会立刻停掉，但强度值不变）。 */
export function coyoteClear(channel) {
  if (!isLive()) throw new Error('郊狼没连着（先 connect 并让 APP 扫码）');
  const n = channelOf(channel);
  sendFrame({ type: 4, channel: n, message: 'clear' });
  return { channel: channelLetter(n), cleared: true };
}

/**
 * 全停：两个通道的队列都清空、强度都归零。
 * 顺序不能反 —— 只清队列不清强度，APP 还在按原强度空放；只清强度不清队列，
 * 已经进队列的那几百帧会接着放完。
 *
 * 同时把手上的定时器全掐掉（补投循环、临时抬高），否则「停了」两秒后
 * 补投的下一段又把它顶起来。这个是急停，永远不受限流。幂等。
 */
export function coyoteStop() {
  clearTempBoost();
  coyoteHaltPlayback();
  state.lastPlayEndsAt = 0;
  state.playing = false;
  if (!isLive()) return { stopped: false, reason: '没连着' };
  const detail = [];
  for (const ch of [1, 2]) {
    try { sendFrame({ type: 4, channel: ch, message: 'clear' }); detail.push(`${channelLetter(ch)} 清队列`); } catch {}
    try { sendFrame({ type: 3, channel: ch, strength: 0, message: 'set channel' }); detail.push(`${channelLetter(ch)} 归零`); } catch {}
  }
  state.strength = { A: 0, B: 0 };
  state.sessionStartedAt = 0;
  state.cooldownUntil = Date.now() + clampNumber(cfg().sessionCooldownMs, 0, 60000, COYOTE_DEFAULTS.sessionCooldownMs);
  log(`[coyote] 全停（${detail.join('、')}）`);
  return { stopped: true, detail };
}

// ── 接线 ──────────────────────────────────────────────────────────────────
/**
 * 由 bridge.js 在启动时调用一次。
 * @param {{getConfig?: () => any, log?: (s: string) => void}} opts
 */
export function initCoyote(opts = {}) {
  if (typeof opts.getConfig === 'function') cfgGetter = opts.getConfig;
  if (typeof opts.log === 'function') logHook = opts.log;
  return { ok: true, defaults: COYOTE_DEFAULTS };
}

/** 订阅事件（控制台 SSE / 调试用）。返回取消订阅函数。 */
export function onCoyoteEvent(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 最近一条 APP 回的原始帧（排查协议问题用）。 */
export function coyoteLastFrame() {
  return lastFrameText;
}

/** 把状态落盘（控制台重启后还能看到上次连到哪）。失败不影响主流程。 */
export function persistCoyoteState() {
  try {
    resolveStateDir();
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), ...coyoteState() }, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
    return true;
  } catch {
    return false;
  }
}
