/**
 * sim-driver.js — 模拟驾驶员（合成特征发生器）
 *
 * 【为什么需要它】
 * 1. 答辩演示：不可能要求答辩现场真的睡着一次。打开模拟模式后，
 *    系统会按一条预设的"疲劳演进剧本"生成面部特征，完整走通
 *    清醒 → 打哈欠 → 眨眼变慢 → 长时闭眼 → 重度报警 的全过程。
 * 2. 回归测试：自动化测试没有真实人脸可用，注入合成特征即可
 *    验证「指标层 → 融合层 → 报警 → 报告」整条链路是否正确。
 * 3. 参数调试：想验证某个阈值改动的效果，用可复现的合成信号比
 *    反复录制真人视频高效得多。
 *
 * 【剧本设计】按真实嗜睡的生理演进顺序编排，而不是随机噪声：
 *   0–12s   清醒：眨眼 15 次/分，时长 ~120ms，头部微动
 *   12–30s  轻度：出现哈欠，眨眼频率升高（代偿性唤醒）
 *   30–52s  中度：眨眼变慢变长，开始点头，出现 0.6~1.0s 闭眼
 *   52–75s  重度：多次 >2s 长闭眼（微睡眠），头部大幅下沉
 *   75s+    循环回到清醒，便于长时间演示
 */

/**
 * 各阶段参数由目标 PERCLOS 反推，而不是凭感觉填：
 *
 *   PERCLOS ≈ 平均闭眼时长 / (平均闭眼时长 + 平均睁眼间隔)
 *   平均闭眼时长 = P(长闭眼)·均值(长闭眼) + P(眨眼)·均值(眨眼)
 *   平均睁眼间隔 = 60000 / 闭眼事件频率
 *
 * 目标值取自疲劳检测领域常用的分级参考：
 *   清醒 ~3% · 轻度 ~11% · 中度 ~22% · 重度 ~43%
 *
 * 每个阶段的时长都设得长于 PERCLOS 统计窗口，
 * 否则窗口会同时覆盖两个阶段，指标被稀释、无法达到稳态。
 */
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
    // 期望 PERCLOS ≈ 120/(120+4000) = 2.9%
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
    // 平均闭眼 = 0.35·755 + 0.65·220 = 407ms；间隔 2308ms
    // 注意：EAR 有上升/下降沿，真正"深度闭合(closure≥0.8)"约占闭眼时长 60%，
    // 故实际 PERCLOS ≈ 0.407·0.6/(0.407+2.308) ≈ 9%（与实测一致）
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
    // 平均闭眼 = 0.5·1050 + 0.5·340 = 695ms；间隔 2500ms → PERCLOS ≈ 21.8%
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
    // 平均闭眼 = 0.7·2700 + 0.3·440 = 2022ms；间隔 2727ms → PERCLOS ≈ 42.6%
  },
];

const CYCLE_MS = PHASES[PHASES.length - 1].until;

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
    this._rng = mulberry32(20250730); // 固定种子：结果可复现，便于对比实验
  }

  currentPhase(elapsed) {
    const t = elapsed % CYCLE_MS;
    for (const p of PHASES) if (t < p.until) return { p, t };
    return { p: PHASES[PHASES.length - 1], t };
  }

  /**
   * 生成一帧合成特征，字段与 FeatureExtractor.extract 的输出保持一致，
   * 因此下游指标层/融合层完全不需要感知数据来源。
   */
  frame(ts) {
    if (this.t0 === null) {
      this.t0 = ts;
      this.nextBlinkAt = ts + 800;
    }
    const elapsed = ts - this.t0;
    const { p, t } = this.currentPhase(elapsed);
    this.phaseName = p.name;
    this.phaseElapsed = t;

    const rnd = this._rng;

    /* ---- 眨眼 / 闭眼调度 ---- */
    if (ts >= this.nextBlinkAt) {
      const isLong = rnd() < p.longClosureChance;
      const range = isLong ? p.longClosureMs : p.blinkMs;
      this.blinkDur = range[0] + rnd() * (range[1] - range[0]);
      this.blinkUntil = ts + this.blinkDur;
      const meanGap = 60000 / Math.max(0.5, p.blinkPerMin);
      // 间隔加 ±35% 抖动，避免生成过于机械的周期信号
      this.nextBlinkAt = ts + this.blinkDur + meanGap * (0.65 + rnd() * 0.7);
    }
    const closing = ts < this.blinkUntil;

    /* ---- 哈欠调度 ---- */
    if (p.yawnPerMin > 0 && ts >= this.nextYawnAt) {
      const dur = 2400 + rnd() * 1600;
      this.yawnStart = ts;
      this.yawnDur = dur;
      this.yawnUntil = ts + dur;
      this.nextYawnAt = ts + dur + (60000 / p.yawnPerMin) * (0.7 + rnd() * 0.6);
    }
    const yawning = ts < this.yawnUntil;

    /* ---- 点头调度 ---- */
    if (p.nodPerMin > 0 && ts >= this.nextNodAt) {
      this.nodUntil = ts + 620;
      this.nodPhase = ts;
      this.nextNodAt = ts + 620 + (60000 / p.nodPerMin) * (0.6 + rnd() * 0.8);
    }
    const nodding = ts < this.nodUntil;

    /* ---- EAR 合成 ----
     * 眼睑运动不是方波：用余弦上升/下降沿模拟眼睑的加速-减速过程，
     * 这样 EAR 波形与真实录制数据的形态接近，指标层的滞回逻辑才受到真实考验。 */
    let ear = EAR_OPEN;
    if (closing) {
      const prog = 1 - (this.blinkUntil - ts) / Math.max(1, this.blinkDur);
      const edge = Math.min(0.28, 120 / Math.max(1, this.blinkDur)); // 上升/下降沿占比
      let k;
      if (prog < edge) k = prog / edge;
      else if (prog > 1 - edge) k = (1 - prog) / edge;
      else k = 1;
      k = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, k)));
      ear = EAR_OPEN + (EAR_CLOSED - EAR_OPEN) * k;
    }
    // 叠加微小抖动，模拟关键点定位噪声
    ear += (rnd() - 0.5) * 0.006;

    /* ---- MAR 合成 ----
     * 哈欠是"缓慢张大—保持—缓慢闭合"的过程，用钟形曲线拟合。
     * 关键是要让 MAR 超过张口阈值的持续时间达到 1.2s 以上，
     * 这样才能被哈欠判定逻辑与"说话"区分开。 */
    let mar = MAR_CLOSED + Math.sin(elapsed / 900) * 0.012;
    if (yawning && this.yawnDur > 0) {
      const prog = clamp01((ts - this.yawnStart) / this.yawnDur);
      // sin 半周期的钟形：两端为 0，中段饱和，保证高幅值有足够持续时间
      const bell = Math.sin(Math.PI * prog) ** 0.55;
      mar = MAR_CLOSED + (MAR_YAWN - MAR_CLOSED) * bell;
    }
    mar += (rnd() - 0.5) * 0.004;

    /* ---- 头部姿态合成 ---- */
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

    /* ---- 语义通道（blendshape）合成 ---- */
    const blinkScore = clamp01((EAR_OPEN - ear) / (EAR_OPEN - EAR_CLOSED)) * 0.95 + 0.03;
    const jawOpen = clamp01((mar - MAR_CLOSED) / (MAR_YAWN - MAR_CLOSED)) * 0.95;

    return {
      ok: true,
      ts,
      simulated: true,
      phase: p.name,
      landmarks: null, // 模拟模式不产生关键点，叠加层会显示提示
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

  /** 与模拟驾驶员匹配的标定结果（跳过真实标定流程） */
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

/** 确定性伪随机数发生器：同一种子必得同一序列，保证实验可复现 */
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
