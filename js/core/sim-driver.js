/**
 * sim-driver.js — 模拟驾驶员（合成特征发生器）
 *
 * 用途：答辩演示、回归测试、参数调试。
 * 按预设的疲劳演进剧本生成面部特征，完整走通
 * 清醒 → 打哈欠 → 眨眼变慢 → 长时闭眼 → 重度报警 的全过程。
 *
 * 剧本阶段：
 *   0–25s    清醒
 *   25–62s   轻度疲劳
 *   62–102s  中度疲劳
 *   102–147s 重度疲劳
 *   147s+    循环回到清醒
 */

/** 各阶段参数由目标 PERCLOS 反推 */
const PHASES = [
  {
    name: '清醒',
    until: 25000,
    blinkPerMin: 15,
    blinkMs: [90, 150],
    yawnPerMin: 0,
    longClosureChance: 0,
    longClosureMs: [0, 0],
    nodPerMin: 0,
    headSway: 2.5,
  },
  {
    name: '轻度疲劳',
    until: 62000,
    blinkPerMin: 26,
    blinkMs: [160, 280],
    yawnPerMin: 3.5,
    longClosureChance: 0.35,
    longClosureMs: [560, 950],
    nodPerMin: 2.6,
    headSway: 4.5,
  },
  {
    name: '中度疲劳',
    until: 102000,
    blinkPerMin: 24,
    blinkMs: [250, 430],
    yawnPerMin: 3.5,
    longClosureChance: 0.5,
    longClosureMs: [700, 1400],
    nodPerMin: 4.0,
    headSway: 7,
  },
  {
    name: '重度疲劳',
    until: 147000,
    blinkPerMin: 22,
    blinkMs: [340, 540],
    yawnPerMin: 2.5,
    longClosureChance: 0.7,
    longClosureMs: [2000, 3400],
    nodPerMin: 7.0,
    headSway: 12,
  },
];

const CYCLE_MS = PHASES[PHASES.length - 1].until;

/** 演示起点偏移：快进到某阶段开头（只偏移起始时刻，不倍速） */
const START_OFFSETS = {
  awake: 0,
  mild: 25000,
  moderate: 62000,
  severe: 102000,
};

/** 基线：模拟一位睁眼 EAR 约 0.30 的驾驶员 */
const EAR_OPEN = 0.30;
const EAR_CLOSED = 0.055;
const MAR_CLOSED = 0.06;
const MAR_YAWN = 0.85;

export class SimulatedDriver {
  constructor() {
    this.reset();
  }

  reset() {
    this.t0 = null;
    this.startOffsetMs = 0;
    this.nextBlinkAt = 0;
    this.blinkUntil = 0;
    this.blinkDur = 0;
    this.nextYawnAt = 2500;
    this.yawnUntil = 0;
    this.yawnStart = 0;
    this.yawnDur = 0;
    this.nextNodAt = 4000;
    this.nodUntil = 0;
    this.nodPhase = 0;
    this.phaseName = '清醒';
    this.cycles = 0;
    this._rng = mulberry32(20250730);
  }

  /** 选择演示起点阶段 */
  setStartStage(stage) {
    this.startOffsetMs = START_OFFSETS[stage] ?? 0;
  }

  currentPhase(elapsed) {
    const t = elapsed % CYCLE_MS;
    for (const p of PHASES) if (t < p.until) return { p, t };
    return { p: PHASES[PHASES.length - 1], t };
  }

  /** 生成一帧合成特征，字段与 FeatureExtractor.extract 的输出一致 */
  frame(ts) {
    if (this.t0 === null) {
      this.t0 = ts - (this.startOffsetMs || 0);
      this.nextBlinkAt = ts + 800;
    }
    const elapsed = ts - this.t0;
    const { p, t } = this.currentPhase(elapsed);
    this.phaseName = p.name;
    this.phaseElapsed = t;

    const rnd = this._rng;

    // 眨眼 / 闭眼调度
    if (ts >= this.nextBlinkAt) {
      const isLong = rnd() < p.longClosureChance;
      const range = isLong ? p.longClosureMs : p.blinkMs;
      this.blinkDur = range[0] + rnd() * (range[1] - range[0]);
      this.blinkUntil = ts + this.blinkDur;
      const meanGap = 60000 / Math.max(0.5, p.blinkPerMin);
      this.nextBlinkAt = ts + this.blinkDur + meanGap * (0.65 + rnd() * 0.7);
    }
    const closing = ts < this.blinkUntil;

    // 哈欠调度
    if (p.yawnPerMin > 0 && ts >= this.nextYawnAt) {
      const dur = 2400 + rnd() * 1600;
      this.yawnStart = ts;
      this.yawnDur = dur;
      this.yawnUntil = ts + dur;
      this.nextYawnAt = ts + dur + (60000 / p.yawnPerMin) * (0.7 + rnd() * 0.6);
    }
    const yawning = ts < this.yawnUntil;

    // 点头调度
    if (p.nodPerMin > 0 && ts >= this.nextNodAt) {
      this.nodUntil = ts + 620;
      this.nodPhase = ts;
      this.nextNodAt = ts + 620 + (60000 / p.nodPerMin) * (0.6 + rnd() * 0.8);
    }
    const nodding = ts < this.nodUntil;

    // EAR 合成：余弦上升/下降沿模拟眼睑的加速-减速过程
    let ear = EAR_OPEN;
    if (closing) {
      const prog = 1 - (this.blinkUntil - ts) / Math.max(1, this.blinkDur);
      const edge = Math.min(0.28, 120 / Math.max(1, this.blinkDur));
      let k;
      if (prog < edge) k = prog / edge;
      else if (prog > 1 - edge) k = (1 - prog) / edge;
      else k = 1;
      k = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, k)));
      ear = EAR_OPEN + (EAR_CLOSED - EAR_OPEN) * k;
    }
    ear += (rnd() - 0.5) * 0.006;

    // MAR 合成：哈欠用钟形曲线拟合，保证超阈值持续 ≥1.2s
    let mar = MAR_CLOSED + Math.sin(elapsed / 900) * 0.012;
    if (yawning && this.yawnDur > 0) {
      const prog = clamp01((ts - this.yawnStart) / this.yawnDur);
      const bell = Math.sin(Math.PI * prog) ** 0.55;
      mar = MAR_CLOSED + (MAR_YAWN - MAR_CLOSED) * bell;
    }
    mar += (rnd() - 0.5) * 0.004;

    // 头部姿态合成
    const sway = p.headSway;
    let pitch = Math.sin(elapsed / 2600) * sway * 0.5;
    let yaw = Math.sin(elapsed / 3700 + 1.2) * sway;
    const roll = Math.sin(elapsed / 4300 + 0.5) * sway * 0.35;
    if (nodding) {
      // 点头：先快速下沉再回抬，产生俯仰角速度尖峰
      const prog = (ts - this.nodPhase) / 620;
      pitch += Math.sin(Math.PI * Math.min(1, prog)) * 22;
    }
    // 重度阶段头部持续下垂
    if (p.name === '重度疲劳') pitch += 8 + Math.sin(elapsed / 1800) * 4;

    const prevPitch = this._prevPitch;
    const prevTs = this._prevTs;
    let pitchVel = 0;
    if (prevPitch !== undefined && prevTs !== undefined && ts > prevTs) {
      pitchVel = ((pitch - prevPitch) * 1000) / (ts - prevTs);
    }
    this._prevPitch = pitch;
    this._prevTs = ts;

    // 语义通道（blendshape）合成
    const blinkScore = clamp01((EAR_OPEN - ear) / (EAR_OPEN - EAR_CLOSED)) * 0.95 + 0.03;
    const jawOpen = clamp01((mar - MAR_CLOSED) / (MAR_YAWN - MAR_CLOSED)) * 0.95;

    return {
      ok: true,
      ts,
      simulated: true,
      phase: p.name,
      landmarks: null,
      ear,
      earL: ear,
      earR: ear,
      earRaw: { l: ear, r: ear },
      mar,
      pitch,
      yaw,
      roll,
      pitchVel,
      poseSource: 'simulated',
      scale: 0.22,
      gaze: { h: 0, v: 0 },
      blend: { eyeBlinkLeft: blinkScore, eyeBlinkRight: blinkScore, jawOpen },
      blinkScore,
      squintScore: 0,
      browDown: 0,
      jawOpen,
    };
  }

  /** 与模拟驾驶员匹配的标定结果 */
  static calibration() {
    return {
      ok: true,
      simulated: true,
      quality: 1,
      qualityLabel: '模拟',
      sampleCount: 0,
      earBaseline: EAR_OPEN,
      earStdev: 0.004,
      earCloseThresh: EAR_OPEN * 0.72,
      earOpenThresh: EAR_OPEN * 0.8,
      marBaseline: MAR_CLOSED,
      marOpenThresh: MAR_CLOSED + 0.35,
      pitch0: 0,
      yaw0: 0,
      roll0: 0,
      scaleBaseline: 0.22,
      blinkScoreBaseline: 0.05,
      calibratedAt: new Date().toISOString(),
    };
  }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 确定性伪随机数发生器（固定种子，保证可复现） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
