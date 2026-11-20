// 郊狼波形生成器 —— 参数化造帧，不用手工数十六进制。
//
// 为什么需要这个：
//   `coyote-waves.js` 里那 16 条是官方固化的波形，只能原样播。想「慢一点」「强一点」
//   「跟着 BPM 走」就没办法了 —— 而那些恰恰是最常用的手感调节。官方 App 的完整波形库
//   在服务端下发的 JS 里（dungeon-server.com:8445/corejs/client.js），拿不到；但波形
//   本身只是 8 字节一帧的数据，完全可以自己算出来。
//
// 帧格式（与官方 V3 一致，一帧 = 100ms）：
//   8 字节 = 4 个频率值 + 4 个强度值，各按十六进制两字符编码，共 16 个字符。
//   例 `151515155C5C5C5C` = 频率 0x15(21)、强度 0x5C(92)。
//   频率值域实际手感区间约 10~120，强度 0~100。
//
// ⚠️ 这是「会电人的硬件」，生成器只负责造数据，不负责保护。上限、时长、自动归零
//    全在 `coyote.js` 里统一夹，别在这里偷偷放宽。

/** 强度上限（百分比）。官方波形里最强的一档就是 0x64 = 100。 */
export const MAX_INTENSITY = 100;

/** 频率的可调区间：低于 10 基本感觉不到，高于 120 会变成刺痛。 */
export const FREQ_MIN = 10;
export const FREQ_MAX = 120;

/** 一帧 = 100ms。 */
export const FRAME_MS = 100;

const SHAPES = Object.freeze(['平', 'ramp', 'rampDown', 'wave', 'pulse', 'random', 'breathe']);

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 确定性随机（mulberry32）。同一个 seed 出同一段波形 —— 复现手感时必须能对得上。
 * @param {number} seed
 */
function makeRandom(seed) {
  let a = (Number(seed) || 1) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / (1 << 30) / 4;
  };
}

/** 把 0~1 的进度映射成 0~1 的包络值。 */
function envelopeOf(shape, progress) {
  const p = Math.min(1, Math.max(0, progress));
  switch (shape) {
    case 'ramp':
      // 线性渐强：从静到满
      return p;
    case 'rampDown':
      return 1 - p;
    case 'wave':
      // 一个完整正弦（起落各半），比线性更有「呼吸感」
      return (1 - Math.cos(p * Math.PI * 2)) / 2;
    case 'pulse':
      // 方波：前半满、后半空，配 duty 用
      return p < 0.5 ? 1 : 0;
    case 'breathe':
      // 慢吸快呼：3/4 时间爬升，1/4 时间落回
      return p < 0.75 ? p / 0.75 : (1 - p) / 0.25;
    case '平':
    default:
      return 1;
  }
}

/**
 * 造一段波形帧。
 *
 * @param {object} opts
 * @param {number} [opts.seconds=5]    总时长（秒），会被切成 frames = seconds * 10
 * @param {string} [opts.shape='平']   包络：平 / ramp / rampDown / wave / pulse / breathe
 * @param {number} [opts.freq=30]      频率（10~120）。给了 freqTo 就是渐变
 * @param {number} [opts.freqTo]       结束频率（不给 = 固定 freq）
 * @param {number} [opts.intensity=40] 峰值强度（0~100）
 * @param {number} [opts.floor=0]      谷值强度（0~intensity），包络乘在这段区间上
 * @param {number} [opts.jitter=0]     抖动幅度（0~20）：每帧随机加减，避免身体适应
 * @param {number} [opts.bpm=0]        鼓点（0 = 不切分）。给了就按 BPM 让强度跟着跳
 * @param {number} [opts.seed=1]       随机种子（jitter / random 形状用）
 * @returns {{ frames: string[], seconds: number, peak: number, shape: string }}
 */
export function makeWaveform(opts = {}) {
  const seconds = Math.min(10, Math.max(0.2, Number(opts.seconds) || 5));
  const count = Math.max(2, Math.round(seconds * (1000 / FRAME_MS)));
  const shape = SHAPES.includes(opts.shape) ? opts.shape : '平';
  const freqFrom = clampInt(opts.freq, FREQ_MIN, FREQ_MAX, 30);
  const freqTo = clampInt(opts.freqTo ?? opts.freq, FREQ_MIN, FREQ_MAX, freqFrom);
  const peak = clampInt(opts.intensity, 0, MAX_INTENSITY, 40);
  const floor = clampInt(opts.floor, 0, peak, 0);
  const jitter = clampInt(opts.jitter, 0, 20, 0);
  const bpm = clampInt(opts.bpm, 0, 300, 0);
  const rand = makeRandom(opts.seed ?? 1);

  // BPM：一拍占多少帧（一帧 100ms ⇒ 一拍 60000/bpm 毫秒）
  const framesPerBeat = bpm > 0 ? Math.max(1, Math.round(60000 / bpm / FRAME_MS)) : 0;

  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const progress = count <= 1 ? 0 : i / (count - 1);
    let env = envelopeOf(shape, progress);
    // 'random' 形状：整段随机（与 jitter 不同 —— jitter 是「在包络上抖动幅度」，
    // random 是「干脆不要包络」）。放在包络之后、BPM 之前，BPM 照样能压在随机上。
    if (shape === 'random') env = rand();

    // BPM 鼓点：每一拍的头两帧顶到峰值，其余压到谷值
    if (framesPerBeat > 0) {
      const pos = i % framesPerBeat;
      env *= pos < 2 ? 1 : 0.15;
    }

    // 频率线性过渡（给 freqTo 才有意义）
    const freq = Math.round(freqFrom + (freqTo - freqFrom) * progress);

    let value = floor + (peak - floor) * env;
    if (jitter > 0) {
      value += (rand() * 2 - 1) * jitter;
    }
    const intensity = clampInt(value, 0, MAX_INTENSITY, 0);

    // 4 个频率值 + 4 个强度值（与官方帧的排布一致）
    const f = freq.toString(16).padStart(2, '0').toUpperCase();
    const s = intensity.toString(16).padStart(2, '0').toUpperCase();
    frames.push(`${f}${f}${f}${f}${s}${s}${s}${s}`);
  }

  return { frames, seconds: count * (FRAME_MS / 1000), peak, shape };
}

/**
 * 一段「渐强」：从 startIntensity 慢慢爬到 endIntensity。
 * 这是最常用的一个 —— 直接喊「升到 60」会一步跳过去，人会缩；慢慢加才是那种感觉。
 *
 * @param {{from?:number, to?:number, seconds?:number, freq?:number}} opts
 */
export function makeRamp(opts = {}) {
  return makeWaveform({
    seconds: opts.seconds ?? 10,
    shape: 'ramp',
    freq: opts.freq ?? 30,
    intensity: opts.to ?? 60,
    floor: opts.from ?? 0,
    seed: 1
  });
}

/** 可用的形状名（给工具描述 / 控制台下拉用）。 */
export function shapeList() {
  return SHAPES.slice();
}
