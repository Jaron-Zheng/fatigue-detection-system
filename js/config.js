/**
 * config.js — 疲劳检测系统参数中枢
 *
 * 所有算法阈值、融合权重、报警策略集中于此，大部分可在 UI 中实时调节。
 */

export const CONFIG = {
  /* ---------- 采集与推理 ---------- */
  capture: {
    width: 640,
    height: 480,
    targetFps: 24,
    delegate: 'GPU',
    facingMode: 'user',
  },

  /* ---------- 个性化标定 ---------- */
  calibration: {
    /** 标定累计有效时长（秒），只有检测到人脸的帧才计入 */
    durationSec: 5,
    /** 等待人脸出现的最长时间（秒），超时则放弃并回退通用阈值 */
    maxWaitSec: 45,
    /** 有效样本最少数量，不足则标定失败 */
    minSamples: 30,
    /** 闭眼阈值 = 睁眼基线 EAR × 该系数 */
    earCloseRatio: 0.72,
    /** 睁眼恢复阈值系数（高于闭眼阈值，形成滞回防抖） */
    earOpenRatio: 0.80,
    /** MAR 张口阈值 = 基线 MAR + 该增量 */
    marOpenDelta: 0.25,
    /** 兜底阈值（标定失败时使用的通用固定值） */
    fallback: { earClose: 0.21, earOpen: 0.25, marOpen: 0.55 },
    /** 睁眼 EAR 基线下限，低于此值视为异常并回退通用阈值 */
    minEarBaseline: 0.12,
  },

  /* ---------- 数据质量门控 ---------- */
  quality: {
    enabled: true,
    minFaceWidthRatio: 0.16,
    maxFaceWidthRatio: 0.92,
    maxCenterOffset: 0.34,
    maxYawDeg: 38,
    maxRollDeg: 28,
    /** 语义否决阈值：闭眼期间 blendshape 闭合度低于此值时强制判为睁眼 */
    semanticOpenVeto: 0.40,
    /** 质量不合格时是否暂停疲劳判定 */
    gateFatigueJudgement: true,
    /** 连续多少毫秒质量不合格才提示 */
    warnAfterMs: 1500,
    lightingEnabled: true,
    lightingIntervalMs: 500,
  },

  /* ---------- 指标计算窗口 ---------- */
  window: {
    /** PERCLOS 滑动窗口（秒） */
    perclosSec: 20,
    /** 眨眼/哈欠频率统计窗口（秒） */
    rateSec: 60,
    /** 波形图显示窗口（秒） */
    waveSec: 30,
    /** PERCLOS 就绪门控：观测时长达标后才参与疲劳判定 */
    perclosMinObservationSec: 5,
    perclosMinSamples: 50,
    /** 允许的最大采样间隔（毫秒），超过即视为观测间断 */
    maxSampleGapMs: 400,
  },

  /* ---------- 事件判定阈值 ---------- */
  event: {
    /** 眼睛状态机闭合度阈值（≥ eyeCloseOn 判闭，≤ eyeCloseOff 判开） */
    eyeCloseOn: 0.75,
    eyeCloseOff: 0.6,
    /** 一次有效眨眼的最短/最长持续时间（毫秒） */
    blinkMinMs: 60,
    blinkMaxMs: 500,
    /** 闭眼超过该时长判为微睡眠（毫秒） */
    microsleepMs: 500,
    /** 闭眼超过该时长立即触发最高级报警（毫秒） */
    criticalClosureMs: 1800,
    /** 哈欠：MAR 超阈值需持续的时长（毫秒） */
    yawnMinMs: 1200,
    /** 两次哈欠之间的最小间隔（毫秒） */
    yawnRefractoryMs: 3000,
    /** 人脸丢失需连续多久才上报事件（毫秒） */
    faceLostReportMs: 400,
    /** 点头：pitch 角速度阈值（度/秒） */
    nodPitchVelDegPerSec: 55,
    nodRefractoryMs: 900,
    /** 头部偏离角度阈值（度） */
    headDeviationDeg: 25,
    /** 偏离持续超过该时长才计入分心事件（毫秒） */
    distractionMinMs: 1500,
  },

  /* ---------- 多特征融合权重（归一化后合计为 1） ---------- */
  fusion: {
    /** 频率类指标的就绪门控（毫秒） */
    rateReadyMs: 15000,
    weights: {
      perclos: 0.34,
      closureDur: 0.23,
      blinkRate: 0.08,
      blinkDur: 0.04,
      yawn: 0.21,
      nod: 0.08,
      headDev: 0.02,
    },
    /** EMA 平滑系数，越小越平滑 */
    emaAlpha: 0.18,
    /** 等级阈值（0~100 疲劳指数） */
    levels: [
      { key: 'awake', label: '清醒', min: 0, max: 24 },
      { key: 'mild', label: '轻度疲劳', min: 24, max: 52 },
      { key: 'moderate', label: '中度疲劳', min: 52, max: 74 },
      { key: 'severe', label: '重度疲劳', min: 74, max: 100 },
    ],
    /** 等级滞回带宽 */
    hysteresis: 6,
    /** 等级切换需连续满足的时长（毫秒） */
    levelDwellMs: 600,
    /** 各等级最短保持时长（毫秒） */
    minHoldMs: { awake: 0, mild: 1000, moderate: 2500, severe: 6000 },
    /** 趋势加速器参数 */
    trendAlpha: 0.08,
    trendMultiplier: 1.5,
    trendMaxBoost: 8,
    trendMinBoost: -2,
    /** 人脸连续丢失超过该时长即判「不可靠」（毫秒） */
    faceLostGateMs: 3000,
  },

  /* ---------- 报警策略 ---------- */
  alarm: {
    enabled: true,
    byLevel: {
      awake: { beep: null, speak: null, cooldownMs: 0 },
      mild: { beep: { freq: 660, times: 1, gain: 0.16 }, speak: '检测到轻度疲劳，建议开窗通风', cooldownMs: 25000 },
      moderate: { beep: { freq: 880, times: 2, gain: 0.24 }, speak: '检测到中度疲劳，请尽快找服务区休息', cooldownMs: 15000 },
      severe: { beep: { freq: 1150, times: 4, gain: 0.34 }, speak: '检测到重度疲劳，请立即停车休息', cooldownMs: 8000 },
    },
    speechEnabled: true,
    flashEnabled: true,
  },

  /* ---------- 可视化 ---------- */
  render: {
    showMesh: true,
    showContours: true,
    showIris: true,
    showMetricsHud: true,
    mirror: true,
  },

  /* ---------- 视频离线评测 ---------- */
  evaluation: {
    /** 采样步长（毫秒） */
    stepMs: 100,
    /** 用于个性化标定的视频开头时长（秒），0 表示跳过标定 */
    calibSec: 5,
    /** 二分类正类起始等级 */
    positiveFrom: 'mild',
  },

  /* ---------- 记录与报告 ---------- */
  record: {
    /** 指标采样间隔（毫秒） */
    sampleIntervalMs: 500,
    /** 报告最多保留的样本数 */
    maxSamples: 7200,
    maxEvents: 2000,
  },
};

/**
 * 完整配置类型定义
 * @typedef {typeof CONFIG} AppConfig
 */

/** 深拷贝一份默认值，供「恢复默认」使用 */
export const DEFAULT_CONFIG = JSON.parse(JSON.stringify(CONFIG));

/**
 * 从 localStorage 载入用户调整过的参数（仅覆盖已知字段）
 * @param {{ getItem(key: string): string | null }} [storage]
 * @returns {void}
 */
export function loadUserConfig(storage = globalThis.localStorage) {
  try {
    const raw = storage && storage.getItem('fatigue.config.v1');
    if (!raw) return;
    const patch = JSON.parse(raw);
    if (isPlainObject(patch)) deepMerge(CONFIG, patch);
  } catch {
    /* 忽略损坏的本地配置 */
  }
}

/**
 * 保存当前用户可调分组参数到 localStorage
 * @returns {void}
 */
export function saveUserConfig() {
  try {
    localStorage.setItem(
      'fatigue.config.v1',
      JSON.stringify({
        calibration: CONFIG.calibration,
        window: CONFIG.window,
        event: CONFIG.event,
        fusion: CONFIG.fusion,
        alarm: CONFIG.alarm,
        render: CONFIG.render,
      })
    );
  } catch {
    /* 存储不可用时静默降级 */
  }
}

/**
 * 恢复默认配置并清除本地存储
 * @returns {void}
 */
export function resetConfig() {
  deepMerge(CONFIG, DEFAULT_CONFIG);
  try {
    localStorage.removeItem('fatigue.config.v1');
  } catch {
    /* noop */
  }
}

/**
 * 数值参数的合法区间表，在合并落值前做钳制
 * 路径段支持 '*' 通配
 */
/** 主循环帧率下限（fps）：PERCLOS 等按帧统计的指标在过低采样率下会失真，低于该值的配置无意义 */
export const MIN_CAPTURE_FPS = 8;

/** PERCLOS 隶属度区间（在线融合 fusion.js 与离线重算 analysis.js 的唯一来源）：低于下限不计入疲劳贡献，达到上限满贡献 */
export const PERCLOS_MU_LO = 0.06;
export const PERCLOS_MU_HI = 0.32;

const NUMERIC_LIMITS = {
  'capture.targetFps': { min: MIN_CAPTURE_FPS, max: 120 },
  'calibration.durationSec': { min: 2, max: 60 },
  'calibration.maxWaitSec': { min: 10, max: 300 },
  'calibration.minSamples': { min: 10, max: 1000 },
  'calibration.earCloseRatio': { min: 0.5, max: 0.95 },
  'calibration.earOpenRatio': { min: 0.55, max: 1 },
  'calibration.marOpenDelta': { min: 0.05, max: 1 },
  'calibration.minEarBaseline': { min: 0.05, max: 0.3 },
  'quality.minFaceWidthRatio': { min: 0.05, max: 0.6 },
  'quality.maxFaceWidthRatio': { min: 0.5, max: 1 },
  'quality.maxCenterOffset': { min: 0.1, max: 1 },
  'quality.maxYawDeg': { min: 10, max: 90 },
  'quality.maxRollDeg': { min: 5, max: 90 },
  'quality.semanticOpenVeto': { min: 0, max: 1 },
  'quality.warnAfterMs': { min: 100, max: 10000 },
  'quality.lightingIntervalMs': { min: 100, max: 5000 },
  'window.perclosSec': { min: 10, max: 300 },
  'window.rateSec': { min: 10, max: 300 },
  'window.waveSec': { min: 5, max: 120 },
  'window.perclosMinObservationSec': { min: 2, max: 60 },
  'window.perclosMinSamples': { min: 10, max: 2000 },
  'window.maxSampleGapMs': { min: 50, max: 2000 },
  'event.eyeCloseOn': { min: 0.5, max: 0.95 },
  'event.eyeCloseOff': { min: 0.3, max: 0.8 },
  'event.blinkMinMs': { min: 20, max: 500 },
  'event.blinkMaxMs': { min: 100, max: 2000 },
  'event.microsleepMs': { min: 100, max: 5000 },
  'event.criticalClosureMs': { min: 500, max: 10000 },
  'event.yawnMinMs': { min: 200, max: 5000 },
  'event.yawnRefractoryMs': { min: 500, max: 30000 },
  'event.faceLostReportMs': { min: 100, max: 5000 },
  'event.nodPitchVelDegPerSec': { min: 10, max: 200 },
  'event.nodRefractoryMs': { min: 200, max: 10000 },
  'event.headDeviationDeg': { min: 5, max: 90 },
  'event.distractionMinMs': { min: 200, max: 10000 },
  'fusion.rateReadyMs': { min: 2000, max: 60000 },
  'fusion.faceLostGateMs': { min: 500, max: 30000 },
  'fusion.weights.*': { min: 0, max: 1 },
  'fusion.emaAlpha': { min: 0.001, max: 1 },
  'fusion.hysteresis': { min: 0, max: 30 },
  'fusion.levelDwellMs': { min: 0, max: 10000 },
  'fusion.minHoldMs.*': { min: 0, max: 60000 },
  'alarm.byLevel.*.cooldownMs': { min: 0, max: 120000 },
  'alarm.byLevel.*.beep.freq': { min: 200, max: 4000 },
  'alarm.byLevel.*.beep.times': { min: 1, max: 10 },
  'alarm.byLevel.*.beep.gain': { min: 0, max: 1 },
  'record.sampleIntervalMs': { min: 100, max: 5000 },
  'record.maxSamples': { min: 100, max: 50000 },
  'record.maxEvents': { min: 100, max: 20000 },
  'evaluation.stepMs': { min: 20, max: 1000 },
  'evaluation.calibSec': { min: 0, max: 60 },
};

/**
 * 按路径查区间：段级匹配（段相等或模式段为 '*'）
 * @param {string} path
 * @returns {{min:number,max:number}|undefined}
 */
function lookupLimit(path) {
  const parts = path.split('.');
  for (const [pattern, limit] of Object.entries(NUMERIC_LIMITS)) {
    const segs = pattern.split('.');
    if (segs.length !== parts.length) continue;
    if (segs.every((s, i) => s === '*' || s === parts[i])) return limit;
  }
  return undefined;
}

/**
 * 数值钳制：越界值收到最近的合法边界
 * @param {string} path
 * @param {number} value
 * @returns {number}
 */
function clampNumber(path, value) {
  const limit = lookupLimit(path);
  if (!limit) return value;
  if (value < limit.min) return limit.min;
  if (value > limit.max) return limit.max;
  return value;
}

/**
 * 类型安全的深合并：只接受纯对象补丁，只覆盖目标已有键
 * 数字字段做区间钳制，原型污染键被忽略
 * @param {object} target
 * @param {object} patch
 * @param {string} [prefix] 当前子树路径
 * @returns {void}
 */
function deepMerge(target, patch, prefix = '') {
  if (!isPlainObject(target) || !isPlainObject(patch)) return;
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (!Object.prototype.hasOwnProperty.call(target, k) || isUnsafeKey(k)) continue;
    const current = target[k];
    const path = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(current)) {
      if (!isPlainObject(v)) continue;
      deepMerge(target[k], v, path);
    } else if (Array.isArray(current)) {
      /** 数组形状校验：要求补丁也是数组且元素含 key 和字符串 label */
      if (
        Array.isArray(v) &&
        v.every(
          (item) =>
            isPlainObject(item) && item.key != null && typeof item.label === 'string'
        )
      ) {
        target[k] = v;
      }
    } else if (typeof current === typeof v && (typeof v !== 'number' || Number.isFinite(v))) {
      target[k] = typeof v === 'number' ? clampNumber(path, v) : v;
    }
  }
}

/** @param {unknown} value */
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** @param {string} key */
function isUnsafeKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}
