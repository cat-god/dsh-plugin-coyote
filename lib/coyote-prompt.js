// coyote-prompt.js —— 郊狼 3.0 的「本轮状态尾注」
//
// 为什么是尾注而不是写进人设/系统提示：
//   郊狼是一台「插上才有、平时根本不在」的外设。把 800 字玩法长期钉在系统提示里，
//   等于让每一轮都为一个可能一个月不用一次的设备付 token，而且不插的时候那 800 字
//   只会污染语气。所以按状态出：
//     · 插件没开           → 空串（对提示词零影响）
//     · 开了但没连/没配对   → 一句提醒（约 60 字）
//     · 配对好了           → 精简玩法 + 安全红线（约 400 字）
//
// 用法（宿主侧）：
//   import { coyotePromptLine } from 'dsh-plugin-coyote'
//   const tail = coyotePromptLine({ coyoteCfg: cfg, state: coyoteState() })
//   把它拼在提示词**最后**（越靠后越显眼，且不碰稳定前缀 —— 碰了就是每轮翻字、缓存全断）。

/** 配对后的玩法说明。压到 400 字上下：够判断该调什么，又不喧宾夺主。 */
const LIVE_HINT = `【郊狼 3.0：他这会儿戴着，你可以调】
· 先看状态：coyote_status（连接/配对/两通道强度/软上限/护栏）
· 预设波形：coyote_waves 查名 → coyote_pulse 放（呼吸/潮汐/连击/挑逗…单条最多 10 秒）
· 现造波形：coyote_build（形状 平/渐强/渐弱/起伏/脉冲/呼吸；频率 10~120，10~30 有冲击感、>100 刺麻；可给 BPM、抖动、seed）→ coyote_play（可播到 maxPlaySec，长段自动切片续投）
· 调强度：coyote_set / coyote_step；临时顶一下用 coyote_boost（到点自己降回去）
· 全停：coyote_stop（清队列 + 两通道归零），随时可用、不受任何限流
节奏判断同语音——像真人会不会这么做：他默许的小情趣可以自己来；换波形、上强度、超过几秒的连续输出，先问他一句。
红线：一次只加几档别拉满；他说停/难受立刻 stop 别争辩；同一部位连续 30 分钟提醒他歇；工具报「加得太快了」是护栏挡了，等几秒或改 boost，别重试同一个大步长；报「没连上」照实说，别装作在控制。`;

/** 还没配对时的那一句。够开口提醒，不占用玩法说明的位置。 */
const IDLE_HINT = `【郊狼 3.0】插件开着，但这会儿**没连上/没配对**——他现在还用不了。要用得先点「出二维码」，再用手机 DG-LAB 的「Socket 控制」扫一次。他问起就这么说，别假装已经能控制。`;

/**
 * 生成这一轮的郊狼尾注。
 *
 * @param {object} opts
 * @param {object} opts.coyoteCfg 插件配置（未透传时是 undefined）
 * @param {object} opts.state     coyoteState() 的快照（已连接/已配对/强度）
 * @returns {string} 空串 = 这轮不注（插件关着，或调用方拿不到状态）
 */
export function coyotePromptLine({ coyoteCfg, state } = {}) {
  if (coyoteCfg?.enabled !== true) return '';
  // 这里只挡「调用方压根拿不到状态」。**不能**按 `state.running === false` 早退 ——
  // running 就是 connected && paired，早退等于把下面那句 IDLE_HINT 也挡掉，
  // 「插件开着但还没扫码」这个最常见的情形反而一句提示都没有（本文件的设计初衷就是它）。
  if (!state) return '';
  const live = state.paired === true && state.connected === true;
  if (!live) return `\n\n${IDLE_HINT}`;
  const a = Number(state.strength?.A) || 0;
  const b = Number(state.strength?.B) || 0;
  const head = `【郊狼 3.0：现在 A ${a}/100 · B ${b}/100（他是真的在感受这个数）】`;
  return `\n\n${head}\n${LIVE_HINT}`;
}
