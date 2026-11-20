/**
 * lib/state.mjs —— 插件自己的家目录解析 + 一点点 JSON 读写
 * ============================================================================
 * 为什么不能按相对层级往上爬（历史坑）：
 *   插件是以 `link:<DSH_HOME>\plugins\<name>` 或 `node_modules/<name>` 装进 profile 的，
 *   往上两级根本不是"仓库根"，在别人的机器上会凭空在主目录旁边拉出一个 state\ 目录。
 *
 * 所以：优先问 DSH 要（`ctx.get('dshHomePath')`），兜底 `$DSH_HOME` / `~/.dsh`。
 *   ⚠️ `dshHomePath` **返回的是函数不是字符串**：
 *      形状是 `(...segments) => join(resolveDshHome(), ...segments)`
 *      当字符串用（`String(p)`）会拼出「函数源码 + \coyote-3」那种路径 ⇒ mkdir ENOENT
 *      ⇒ apply 抛错 ⇒ 插件不激活。这个坑已经在真机上踩过一次。
 * ============================================================================
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 插件在 DSH 家目录里的目录名 */
export const HOME_DIR_NAME = 'coyote-3';

/**
 * 解析并创建插件家目录。永不抛错（抛了会让整条插件不激活）。
 * @param {any} ctx cordis 上下文（可能没有 get）
 * @returns {string} 绝对路径
 */
export function stateDirOf(ctx) {
  let dir = '';
  try {
    const p = ctx?.get?.('dshHomePath');
    if (typeof p === 'function') {
      const v = p(HOME_DIR_NAME); // 函数形态：把目录名传进去
      if (v) dir = String(v);
    } else if (typeof p === 'string' && p) {
      dir = join(p, HOME_DIR_NAME);
    }
  } catch { /* 拿不到就用下面的兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), HOME_DIR_NAME);
  try { mkdirSync(dir, { recursive: true }); } catch { /* 建不出来也只是没地方存盘 */ }
  return dir;
}

/** 读 JSON，失败返回 fallback（永不抛） */
export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** 原子写 JSON（tmp + rename）。失败返回 false */
export function writeJson(file, value) {
  try {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

/** 补目录（永不抛） */
export function ensureDir(dir) {
  try { mkdirSync(dir, { recursive: true }); return true; } catch { return false; }
}
