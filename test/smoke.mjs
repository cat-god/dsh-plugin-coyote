#!/usr/bin/env node
/**
 * test/smoke.mjs —— 用**假的 ctx** 把 apply() 真跑一遍
 *
 * 为什么需要它：
 *   test/run.mjs 只做静态断言 + 纯函数验证。但插件最容易死的地方是 `apply()`：
 *   一旦它抛错，DSH 只留一句 `warning: 1 entry did not activate`，工具一个都不会出现，
 *   而且没有任何 stack 给用户。所以这里伪造一个够用的 ctx，把 apply 真跑起来，
 *   断言：工具注册齐了、HTTP 路由挂上了、卸载钩子挂了、状态目录落在临时目录里。
 *
 * 跑法：node test/smoke.mjs
 * 注意：**不会连中继**（默认 enabled=false）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
async function atest(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok   ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name} — ${e?.message ?? e}`); }
}
function ok(cond, msg) { assert.ok(cond, msg); }

const home = mkdtempSync(join(tmpdir(), 'coyote-smoke-'));
process.env.DSH_HOME = home;

// ── 假 ctx ────────────────────────────────────────────────────────────────
const registered = [];
const routes = [];
const cleanups = [];
const logs = [];
const ctx = {
  // dshHomePath 返回的是**函数**（真机踩过的坑：当字符串用会拼出函数源码）
  get: (k) => (k === 'dshHomePath' ? (...segs) => join(home, ...segs) : undefined),
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  tools: {
    register(t) { registered.push(t); return t; },
  },
  webServer: {
    register(spec) { routes.push(spec); return () => {}; },
  },
  effect(fn, label) {
    const r = fn();
    cleanups.push({ label, dispose: typeof r === 'function' ? r : null });
    return r;
  },
};

const mod = await import(pathToFileURL(join(fileURLToPath(new URL('..', import.meta.url)), 'index.js')).href);
const ret = mod.apply(ctx, {
  enabled: false,           // 总闸关着 —— smoke 不该真的连中继
  maxStrength: 80,
  ownerKey: 'private:10001',
  promptOnlyForOwner: true,
});

console.log('\n== smoke: apply() 真跑 ==');

await atest('apply 返回了 promptTail 函数', () => {
  ok(ret && typeof ret.promptTail === 'function', 'apply 应返回 { promptTail }');
  ok(typeof mod.coyotePromptLine === 'function', 'index.js 应 re-export coyotePromptLine');
});

await atest('13 个工具都注册了', () => {
  const names = registered.map((t) => t.name).sort();
  const want = ['coyote_boost', 'coyote_build', 'coyote_clear', 'coyote_connect', 'coyote_disconnect',
    'coyote_play', 'coyote_pulse', 'coyote_qr', 'coyote_set', 'coyote_status', 'coyote_step',
    'coyote_stop', 'coyote_waves'].sort();
  assert.deepEqual(names, want);
});

await atest('每个工具都有 description 与 parameters', () => {
  for (const t of registered) {
    ok(typeof t.description === 'string' && t.description.length > 8, `${t.name} 缺描述`);
    ok(t.parameters && typeof t.parameters === 'object', `${t.name} 缺 parameters`);
    ok(t.parameters.type === 'object' && t.parameters.additionalProperties !== undefined,
      `${t.name} 的 parameters 是 object 却没写 additionalProperties（defineTool 会拒）`);
  }
});

await atest('HTTP 路由挂在 /api/coyote-3', () => {
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/coyote-3');
  assert.equal(routes[0].kind, 'prefix');
  ok(typeof routes[0].handler === 'function');
});

await atest('挂了一个卸载清理（停 + 断）', () => {
  const unload = cleanups.find((c) => c.label.includes('卸载'));
  ok(unload, `没找到卸载钩子，实际：${cleanups.map((c) => c.label).join(' | ')}`);
  ok(typeof unload.dispose === 'function', '卸载钩子要返回 dispose');
  unload.dispose(); // 真调一次，不能抛
});

await atest('状态目录落在临时家目录里（没写进插件包）', () => {
  const dir = join(home, 'coyote-3');
  ok(existsSync(dir), `没建家目录：${dir}`);
  ok(existsSync(join(dir, 'coyote.log')), '日志没落到家目录');
});

await atest('总闸关着 → 工具回「没开」而不是抛', async () => {
  const st = registered.find((t) => t.name === 'coyote_status');
  const r = await st.execute({}, {});
  assert.equal(r.ok, false);
  ok(String(r.error).includes('没开'), r.error);
});

await atest('总闸关着 → promptTail 是空串', () => {
  assert.equal(ret.promptTail('private:10001'), '');
});

await atest('改配置后 promptTail 在 owner 会话里有内容', () => {
  ctx.coyote3.setConfig({ enabled: true, ownerKey: 'private:10001' });
  const t = ret.promptTail('private:10001');
  ok(t.length > 0, '开了之后 owner 会话应该有尾注');
});

await atest('非 owner 会话不注（多用户宿主防串台）', () => {
  assert.equal(ret.promptTail('private:99999'), '');
});

await atest('日志里有挂载记录', () => {
  ok(logs.some((l) => l.includes('[coyote]') && l.includes('已挂载')), logs.slice(0, 5).join(' | '));
});

try { rmSync(home, { recursive: true, force: true }); } catch { /* 临时目录留着也不碍事 */ }

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}（通过 ${pass} / 失败 ${fail}）`);
process.exit(fail === 0 ? 0 : 1);
