#!/usr/bin/env node
/**
 * test/run.mjs —— 插件自检（不需要连中继、不需要硬件、不需要 DSH）
 *
 * 跑法：node test/run.mjs
 * 退出码：0 = 全过，1 = 有失败
 *
 * 为什么这些断言值得写：
 *   这个插件的失败模式大多是**静默**的 —— 波形帧写错一位、二维码多一个 #、
 *   状态目录回落到「仓库根/state」、工具名在 preset 里对不上……这些都不会抛错，
 *   只会在真机上"看起来没反应"。所以每一项都在断言**具体的字符串/形状**。
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('同步 test() 里不要返 Promise，请用 atest()');
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name} — ${e?.message ?? e}`);
  }
}
async function atest(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name} — ${e?.message ?? e}`);
  }
}
function ok(cond, msg) {
  assert.ok(cond, msg);
}

const waves = await imp('lib/coyote-waves.js');
const gen = await imp('lib/coyote-waves-gen.js');
const coyote = await imp('lib/coyote.js');
const prompt = await imp('lib/coyote-prompt.js');
const state = await imp('lib/state.mjs');

/* ─────────────────────────  1. 波形库  ───────────────────────── */
console.log('\n== 1. 内置波形库 ==');
test('16 条官方波形', () => {
  assert.equal(waves.COYOTE_WAVES.length, 16);
});
test('每条都有名字且帧数 > 0', () => {
  for (const w of waves.COYOTE_WAVES) {
    ok(typeof w.name === 'string' && w.name.length > 0, `波形缺名字：${JSON.stringify(w.name)}`);
    ok(Array.isArray(w.frames) && w.frames.length > 0, `${w.name} 没有帧`);
  }
});
test('每一帧都是 16 位十六进制', () => {
  for (const w of waves.COYOTE_WAVES) {
    for (const f of w.frames) {
      ok(/^[0-9A-Fa-f]{16}$/.test(f), `${w.name} 有非法帧：${f}`);
    }
  }
});
test('findWaveform 忽略大小写与空格', () => {
  const a = waves.findWaveform('潮汐');
  ok(a && a.name === '潮汐', '找不到「潮汐」');
  assert.equal(waves.findWaveform(' 潮汐 '), a);
});
test('findWaveform 找不到返回 null（不抛）', () => {
  assert.equal(waves.findWaveform('不存在的波形'), null);
  assert.equal(waves.findWaveform(''), null);
});
test('waveformListText 列出全部名字', () => {
  const t = waves.waveformListText();
  for (const w of waves.COYOTE_WAVES) ok(t.includes(w.name), `清单里少了 ${w.name}`);
});

/* ─────────────────────────  2. 波形生成器  ───────────────────────── */
console.log('\n== 2. 波形生成器 ==');
test('shapeList 含七种形状', () => {
  const s = gen.shapeList();
  for (const want of ['平', 'ramp', 'rampDown', 'wave', 'pulse', 'random', 'breathe']) {
    ok(s.includes(want), `形状里少了 ${want}（实际：${s.join('/')}）`);
  }
});
test('默认参数造出合法帧（16 位 HEX）', () => {
  const r = gen.makeWaveform({ seconds: 2 });
  assert.equal(r.frames.length, 20);
  for (const f of r.frames) ok(/^[0-9A-F]{16}$/.test(f), `非法帧：${f}`);
});
test('ramp 单调上升：首帧强度 00，末帧等于目标', () => {
  const r = gen.makeWaveform({ seconds: 2, shape: 'ramp', freq: 30, intensity: 60 });
  ok(r.frames[0].endsWith('00000000'), `首帧应无强度：${r.frames[0]}`);
  ok(r.frames[r.frames.length - 1].endsWith('3C3C3C3C'), `末帧应是 60(0x3C)：${r.frames[r.frames.length - 1]}`);
});
test('强度越界夹回 0~100', () => {
  const hi = gen.makeWaveform({ seconds: 1, intensity: 9999 });
  ok(hi.frames[0].endsWith('64646464'), `强度应夹到 100(0x64)：${hi.frames[0]}`);
  const lo = gen.makeWaveform({ seconds: 1, intensity: -50 });
  ok(lo.frames[0].endsWith('00000000'), `负强度应夹到 0：${lo.frames[0]}`);
});
test('频率夹在 10~120 且每帧四组同值', () => {
  const r = gen.makeWaveform({ seconds: 1, freq: 1 });
  const f = r.frames[0];
  const parts = f.match(/.{2}/g);
  assert.equal(parts.length, 8);
  assert.equal(parts[0], '0A', `频率下限应是 10(0x0A)：${f}`);
  assert.equal(parts[1], parts[0]);
  assert.equal(parts[2], parts[0]);
  assert.equal(parts[3], parts[0]);
});
test('同 seed 同结果、异 seed 异结果（jitter 打开时）', () => {
  const a = gen.makeWaveform({ seconds: 1, jitter: 0.5, seed: 7 }).frames.join('');
  const b = gen.makeWaveform({ seconds: 1, jitter: 0.5, seed: 7 }).frames.join('');
  const c = gen.makeWaveform({ seconds: 1, jitter: 0.5, seed: 8 }).frames.join('');
  assert.equal(a, b, '同 seed 应完全一致');
  ok(a !== c, '异 seed 应该不同');
});
test('bpm 切拍不改帧数、只改强度分布', () => {
  const flat = gen.makeWaveform({ seconds: 4, shape: '平', intensity: 50 });
  const beat = gen.makeWaveform({ seconds: 4, shape: '平', intensity: 50, bpm: 120 });
  assert.equal(beat.frames.length, flat.frames.length);
  ok(beat.frames.join('') !== flat.frames.join(''), 'bpm 应该改变强度分布');
});
test('makeRamp 从 from 到 to', () => {
  const r = gen.makeRamp({ from: 10, to: 70, seconds: 2, freq: 30 });
  ok(r.frames[0].endsWith('0A0A0A0A'), `起点应是 10(0x0A)：${r.frames[0]}`);
  ok(r.frames[r.frames.length - 1].endsWith('46464646'), `终点应是 70(0x46)：${r.frames.at(-1)}`);
});

/* ─────────────────────────  3. 二维码文本  ───────────────────────── */
console.log('\n== 3. 二维码文本格式 ==');
const SAMPLE_ID = '6239052b-7fef-4885-9674-48e1720bbec3';
test('前缀是官方下载页', () => {
  const t = coyote.buildQrText(SAMPLE_ID, 'wss://ws.dungeon-lab.cn/');
  ok(t.startsWith('https://www.dungeon-lab.com/app-download.php#'), t);
});
test('含 DGLAB-SOCKET 标签', () => {
  ok(coyote.buildQrText(SAMPLE_ID, 'wss://ws.dungeon-lab.cn/').includes('#DGLAB-SOCKET#'));
});
test('恰好两个 #（多一个 APP 就拒扫）', () => {
  const t = coyote.buildQrText(SAMPLE_ID, 'wss://ws.dungeon-lab.cn/');
  assert.equal((t.match(/#/g) || []).length, 2, t);
});
test('末段是 ws 地址 + clientId', () => {
  const t = coyote.buildQrText(SAMPLE_ID, 'wss://ws.dungeon-lab.cn/');
  const tail = t.split('#')[2];
  assert.equal(tail, `wss://ws.dungeon-lab.cn/${SAMPLE_ID}`);
});

/* ─────────────────────────  4. 默认关  ───────────────────────── */
console.log('\n== 4. 默认关闭时必须是安全的 ==');
coyote.initCoyote({ getConfig: () => ({ enabled: false }), log: () => {} });
test('isLive() 为 false', () => {
  assert.equal(coyote.isLive(), false);
});
test('设强度被拒', () => {
  assert.throws(() => coyote.coyoteSetStrength('A', 10), /./);
});
test('放波形被拒', () => {
  assert.throws(() => coyote.coyotePulse('A', gen.makeWaveform({ seconds: 1 }).frames, 1), /./);
});
test('stop 安全返回（不抛）', () => {
  const r = coyote.coyoteStop();
  assert.equal(r.stopped, false);
});
test('状态快照不含 socket 对象（不可序列化）', () => {
  const s = coyote.coyoteState();
  ok(!('socket' in s), '状态里不该有 socket');
  JSON.stringify(s); // 能序列化就行
});
test('状态里带上 qrText 字段名', () => {
  const s = coyote.coyoteState();
  ok('qrText' in s, 'coyoteState() 应含 qrText');
});

/* ─────────────────────────  5. 状态目录注入  ───────────────────────── */
console.log('\n== 5. 状态目录 ==');
test('setStateDir 生效，outboxDir 跟着变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coyote-test-'));
  try {
    ok(coyote.setStateDir(dir) === true);
    assert.equal(coyote.outboxDir(), join(dir, 'outbox'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('setStateDir 空值被拒（不把状态写到 cwd）', () => {
  assert.equal(coyote.setStateDir(''), false);
});
test('stateDirOf 在拿不到 ctx 时也有兜底路径', () => {
  const d = state.stateDirOf(undefined);
  ok(typeof d === 'string' && d.length > 0, d);
  ok(d.includes('coyote-3'), `兜底目录应含插件名：${d}`);
});
test('stateDirOf 认得 dshHomePath 是函数（真机踩过的坑）', () => {
  const fake = { get: (k) => (k === 'dshHomePath' ? (...segs) => join('X:', 'dsh', ...segs) : undefined) };
  const d = state.stateDirOf(fake);
  assert.equal(d, join('X:', 'dsh', 'coyote-3'));
});

/* ─────────────────────────  6. 玩法尾注  ───────────────────────── */
console.log('\n== 6. 玩法尾注（按状态出，不进人设） ==');
test('插件关着 → 空串', () => {
  assert.equal(prompt.coyotePromptLine({ coyoteCfg: { enabled: false }, state: null }), '');
});
test('没有配置 → 空串', () => {
  assert.equal(prompt.coyotePromptLine({}), '');
});
test('没连或没配对 → 只有短提醒，不提 build/play', () => {
  const t = prompt.coyotePromptLine({ coyoteCfg: { enabled: true }, state: { connected: false, paired: false } });
  ok(t.length > 0 && t.length < 200, `短提醒应该很短，实际 ${t.length}`);
  ok(!t.includes('coyote_build'), '没配对时不该教她现造波形');
  ok(t.includes('没连上') || t.includes('没配对'), t);
});
test('配对后 → 带 A/B 实际读数与工具名', () => {
  const t = prompt.coyotePromptLine({
    coyoteCfg: { enabled: true },
    state: { connected: true, paired: true, strength: { A: 12, B: 0 } },
  });
  ok(t.includes('A 12'), t.slice(0, 120));
  ok(t.includes('B 0'), t.slice(0, 120));
  for (const tool of ['coyote_status', 'coyote_pulse', 'coyote_build', 'coyote_play', 'coyote_stop']) {
    ok(t.includes(tool), `玩法里少了 ${tool}`);
  }
  ok(t.includes('立刻 stop') || t.includes('立刻'), '红线里要有「立刻停」');
});
test('配对态尾注不超过 900 字（别喧宾夺主）', () => {
  const t = prompt.coyotePromptLine({
    coyoteCfg: { enabled: true },
    state: { connected: true, paired: true, strength: { A: 1, B: 1 } },
  });
  ok(t.length <= 900, `尾注太长：${t.length}`);
});

/* ─────────────────────────  7. 插件入口与接线  ───────────────────────── */
console.log('\n== 7. 插件入口（不需要 DSH 也能验的部分） ==');
const indexSrc = read('index.js');
test('导出 name / inject', () => {
  ok(/export const name = 'coyote'/.test(indexSrc), '命名空间必须是 coyote');
  ok(/export const inject = \[[^\]]*webServer/.test(indexSrc), 'inject 要含 webServer');
});
test('十二个工具名都在', () => {
  const names = ['coyote_status', 'coyote_qr', 'coyote_connect', 'coyote_waves', 'coyote_set',
    'coyote_step', 'coyote_pulse', 'coyote_build', 'coyote_play', 'coyote_boost',
    'coyote_clear', 'coyote_stop', 'coyote_disconnect'];
  for (const n of names) ok(indexSrc.includes(`name: '${n}'`), `缺少工具 ${n}`);
});
test('每个 Config 字段都带 volatile（否则设置写不进去）', () => {
  const block = indexSrc.slice(indexSrc.indexOf('export const Config'), indexSrc.indexOf('/** 逐字段'));
  // 逐行看：形如 `  enabled: z.boolean().default(false).extra('volatile', true),`
  const fieldLines = block.split(/\r?\n/).filter((l) => /^\s{2}\w+:\s*z\./.test(l));
  ok(fieldLines.length >= 10, `Config 字段太少：${fieldLines.length}`);
  for (const line of fieldLines) {
    ok(line.includes("extra('volatile', true)"), `字段没带 volatile：${line.trim().slice(0, 70)}`);
  }
});
test('Config 里不出现 .max( / .min(（schema 不过会让整条插件不激活）', () => {
  const block = indexSrc.slice(indexSrc.indexOf('export const Config'), indexSrc.indexOf('/** 逐字段'));
  ok(!/\.max\(|\.min\(/.test(block), '不要用 max/min 做范围校验，改在 clampConfig 里钳');
});
test('HTTP 路由前缀是 /api/coyote-3', () => {
  ok(indexSrc.includes("path: '/api/coyote-3'"), '路由前缀变了？记得同步 README');
});
test('卸载时会全停 + 断开（这个插件唯一不能忘的收尾）', () => {
  const at = indexSrc.indexOf('ctx.effect(() => () => {');
  ok(at >= 0, '缺少卸载清理（ctx.effect(() => () => { ... })）');
  const body = indexSrc.slice(at, at + 400);
  ok(body.includes('coyoteStop()'), '卸载清理要全停');
  ok(body.includes("disconnect('unload')"), '卸载清理要断开中继');
});
test('apply 里把状态目录注进去了', () => {
  ok(indexSrc.includes('setStateDir(stateDir)'), '忘了注入状态目录，状态会写到 profile 里');
});
test('危险动作前有总闸判断', () => {
  ok(indexSrc.includes('const ensureOn = ()'), '缺少总闸 helper');
});

/* ─────────────────────────  8. 打包元数据  ───────────────────────── */
console.log('\n== 8. 打包元数据 ==');
const pkg = JSON.parse(read('package.json'));
test('name / type / main 正确', () => {
  assert.equal(pkg.name, 'dsh-plugin-coyote');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, './index.js');
});
test('engines 声明 node >=22 与 dsh', () => {
  ok(String(pkg.engines?.node || '').includes('22'), JSON.stringify(pkg.engines));
  ok(typeof pkg.engines?.dsh === 'string', '缺 engines.dsh');
});
test('peerDependencies 全部 optional（桌面版 autoInstallPeers=false）', () => {
  for (const k of Object.keys(pkg.peerDependencies || {})) {
    assert.equal(pkg.peerDependenciesMeta?.[k]?.optional, true, `${k} 不是 optional`);
  }
});
test('dsh.bundle.patch 指向存在的文件', () => {
  const p = pkg.dsh?.bundle?.patch;
  ok(typeof p === 'string' && p.length > 0, '缺 dsh.bundle.patch');
  ok(existsSync(join(ROOT, p)), `patch 文件不存在：${p}`);
});
test('files 白名单包含 lib 与 index.js', () => {
  ok(pkg.files.includes('index.js') && pkg.files.includes('lib'), JSON.stringify(pkg.files));
});
test('cordis.patch.yml 的 id 等于插件命名空间', () => {
  const y = read('cordis.patch.yml');
  ok(/-\s*id:\s*coyote\b/.test(y), 'patch 里的 id 必须是 coyote（不是包名）');
  ok(/name:\s*dsh-plugin-coyote/.test(y), 'patch 里的 name 必须是包名');
});
test('LICENSE 存在且是 MIT', () => {
  ok(existsSync(join(ROOT, 'LICENSE')), '缺 LICENSE');
  ok(read('LICENSE').includes('MIT License'));
});
test('README 里写清了两把锁与家目录', () => {
  const r = read('README.md');
  ok(r.includes('enabled'), 'README 要说明默认关');
  ok(r.includes('coyote-3'), 'README 要说明家目录');
});

/* ─────────────────────────  9. 安全信封源码级  ───────────────────────── */
console.log('\n== 9. 安全信封（源码级，离线可验） ==');
const coyoteSrc = read('lib/coyote.js');
test('默认值里有五个护栏旋钮', () => {
  for (const k of ['increasePerSec', 'maxSessionSec', 'maxPlaySec', 'watchdogMs', 'sessionCooldownMs']) {
    ok(coyoteSrc.includes(k), `缺少护栏旋钮 ${k}`);
  }
});
// 看门狗必须大于官方中继 60s 心跳间隔，否则「没人在玩」被错杀成「链路断了」
//（qq-bridge 2026-11-21 实修：旧默认 15s 导致配对后 20 秒必被掐）。
test('看门狗默认 90 秒且任何帧都算活性（heartbeat 不进 default）', () => {
  ok(coyoteSrc.includes('watchdogMs: 90000'), '看门狗默认值不是 90000');
  ok(!coyoteSrc.includes('watchdogMs: 15000'), '还残留旧默认 15000');
  const i = coyoteSrc.indexOf('function handleFrame');
  const head = coyoteSrc.slice(i, i + 900);
  ok(head.includes('state.lastFrameAt = Date.now();'), 'handleFrame 顶部没有统一活性');
  ok(head.includes("case 'heartbeat'"), '没有 heartbeat 分支');
});
test('coyoteStop 先掐补投再归零', () => {
  const i = coyoteSrc.indexOf('export function coyoteStop');
  const body = coyoteSrc.slice(i, i + 1600);
  ok(body.includes('coyoteHaltPlayback('), 'stop 里没有掐掉补投');
  ok(body.includes('clearTempBoost('), 'stop 里没有清掉临时顶');
});
test('boost 回落失败会整体停（不留在高位）', () => {
  const i = coyoteSrc.indexOf('export function coyoteTempBoost');
  const body = coyoteSrc.slice(i, i + 2200);
  ok(body.includes('coyoteStop('), 'boost 回落失败没有兜底全停');
});
test('单条消息 >1950 字符要抛（APP 会直接丢）', () => {
  ok(coyoteSrc.includes('1950'), '缺少 1950 长度硬约束');
});
test('长波形切片上限 8.6 秒（对齐 APP 队列节奏）', () => {
  ok(/8\.6/.test(coyoteSrc), '缺少 8.6 秒切片上限');
});

/* ─────────────────────────  收尾  ───────────────────────── */
console.log(`\n${fail === 0 ? '全部通过' : '有失败'}（通过 ${pass} / 失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
