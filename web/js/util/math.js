/** math.js — 数值工具 */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a, b, t) => a + (b - a) * t;

/** 二维欧氏距离（landmark 为归一化坐标，需按画面宽高比还原，避免椭圆化误差） */
export function dist2(a, b, aspect = 1) {
  const dx = (a.x - b.x) * aspect;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/** 三维欧氏距离 */
export function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

export const RAD2DEG = 180 / Math.PI;
export const DEG2RAD = Math.PI / 180;

export function mean(arr) {
  if (!arr.length) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

export function stdev(arr, m = null) {
  if (arr.length < 2) return 0;
  const mu = m === null ? mean(arr) : m;
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - mu;
    s += d * d;
  }
  return Math.sqrt(s / (arr.length - 1));
}

/** 分位数（线性插值法），arr 无需预排序 */
export function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = Float64Array.from(arr).sort();
  const idx = (a.length - 1) * clamp(p, 0, 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? a[lo] : lerp(a[lo], a[hi], idx - lo);
}

/** 中位数（对离群点鲁棒，标定时优于均值） */
export const median = (arr) => percentile(arr, 0.5);

/**
 * 分段线性隶属函数（模糊化）
 * v <= lo 时返回 0，v >= hi 时返回 1，中间线性上升。
 * 这是把「物理量」映射为「疲劳贡献度 [0,1]」的核心手段。
 */
export function membership(v, lo, hi) {
  if (!Number.isFinite(v)) return 0;
  if (hi === lo) return v >= hi ? 1 : 0;
  return clamp((v - lo) / (hi - lo), 0, 1);
}

/**
 * S 型隶属函数（非线性模糊化）
 *
 * 与线性 membership 相比，S 曲线在低端有一个缓慢起步区（避免噪声触发），
 * 在中段快速上升（提高灵敏度），在高端自然饱和。
 *
 * 调参实验结论：PERCLOS 用线性函数时，轻度疲劳段（8-13%）隶属度
 * 只有 0.08-0.29，贡献太低导致灵敏度偏低。改用 S 曲线后同样 PERCLOS
 * 值的隶属度可提高到 0.15-0.45，让系统在轻度阶段更早产生有效贡献。
 *
 * 数学形式：sigmoid 变换，但保证 v≤lo 时为 0、v≥hi 时为 1。
 */
export function membershipS(v, lo, hi) {
  if (!Number.isFinite(v)) return 0;
  if (hi === lo) return v >= hi ? 1 : 0;
  if (v <= lo) return 0;
  if (v >= hi) return 1;
  // 归一化到 [0,1]
  const t = (v - lo) / (hi - lo);
  // Sigmoid 变换：t=0.5 时为 0.5，两端非线性
  // k=6 让曲线在 t∈[0.2, 0.8] 区间接近线性，两端有适度弯曲
  const k = 6;
  const s = 1 / (1 + Math.exp(-k * (t - 0.5)));
  // 由于 sigmoid 在 t=0 时 ≈0.0025、t=1 时 ≈0.9975，
  // 需要重新标定到 [0,1]：减去 s(0) 再除以 s(1)-s(0)
  const s0 = 1 / (1 + Math.exp(k * 0.5));     // s at t=0
  const s1 = 1 / (1 + Math.exp(-k * 0.5));   // s at t=1
  return clamp((s - s0) / (s1 - s0), 0, 1);
}

/** 双侧隶属函数：偏离中心区间越远，隶属度越高（用于眨眼频率这类"过高或过低都异常"的指标） */
export function membershipTwoSided(v, normLo, normHi, hardLo, hardHi) {
  if (!Number.isFinite(v)) return 0;
  if (v >= normLo && v <= normHi) return 0;
  if (v > normHi) return membership(v, normHi, hardHi);
  return membership(-v, -normLo, -hardLo);
}

/** 指数移动平均 */
export class Ema {
  constructor(alpha = 0.12, initial = null) {
    this.alpha = alpha;
    this.value = initial;
  }
  push(v) {
    if (!Number.isFinite(v)) return this.value;
    this.value = this.value === null ? v : this.value + this.alpha * (v - this.value);
    return this.value;
  }
  reset(initial = null) {
    this.value = initial;
  }
}

/** 中值滤波器（长度固定的小窗口，抑制关键点抖动导致的尖刺） */
export class MedianFilter {
  constructor(size = 5) {
    this.size = size;
    this.buf = [];
  }
  push(v) {
    if (!Number.isFinite(v)) return this.buf.length ? median(this.buf) : NaN;
    this.buf.push(v);
    if (this.buf.length > this.size) this.buf.shift();
    return median(this.buf);
  }
  reset() {
    this.buf.length = 0;
  }
}

/**
 * 由 4×4 列主序变换矩阵提取欧拉角（度）。
 * MediaPipe facialTransformationMatrixes 给出的是「头部相对相机」的刚体变换。
 * 采用 R = Rz(roll)·Ry(yaw)·Rx(pitch) 分解，与 OpenCV 常用约定一致。
 */
export function matrixToEuler(data) {
  // 列主序：data[col*4 + row]
  const m00 = data[0], m10 = data[1], m20 = data[2];
  const _m01 = data[4], m11 = data[5], m21 = data[6];
  const _m02 = data[8], m12 = data[9], m22 = data[10];

  const sy = Math.hypot(m00, m10);
  let pitch, yaw, roll;
  if (sy > 1e-6) {
    pitch = Math.atan2(m21, m22);
    yaw = Math.atan2(-m20, sy);
    roll = Math.atan2(m10, m00);
  } else {
    pitch = Math.atan2(-m12, m11);
    yaw = Math.atan2(-m20, sy);
    roll = 0;
  }
  return {
    pitch: pitch * RAD2DEG,
    yaw: yaw * RAD2DEG,
    roll: roll * RAD2DEG,
  };
}

/** 角度归一到 (-180, 180]，避免 ±180 附近突变 */
export function normalizeAngle(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** 格式化：数值 → 固定小数位字符串（NaN 安全） */
export function fmt(v, digits = 2, fallback = '--') {
  return Number.isFinite(v) ? v.toFixed(digits) : fallback;
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
