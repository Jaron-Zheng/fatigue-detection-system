/**
 * config.js — 系统参数中枢
 *
 * 所有算法阈值、融合权重、报警策略集中于此，且大部分在 UI 中可实时调节。
 * 这样做的意义：论文中做「消融实验 / 参数敏感性分析」时，无需改代码即可复现。
 *
 * 参数取值依据（写论文可引用的方向）：
 * - PERCLOS P80 判据：Wierwille 等提出的 PERCLOS 是目前公认与主观嗜睡量表
 *   相关性最高的单一生理指标，工程上常以 0.15 / 0.30 作为轻/重度分界。
 * - EAR 阈值：Soukupová & Čech (2016) 的眼纵横比方法，固定阈值常取 0.20~0.25；
 *   本系统改为「按个体基线自适应」，解决不同人眼型差异导致的误判。
 * - 微睡眠（microsleep）：单次闭眼 ≥ 0.5s 属异常，≥ 1.5~2s 视为高危。
 * - 正常成人自发眨眼频率约 12~20 次/分；疲劳早期升高、深度疲劳时下降且时长变长。
 */

export const CONFIG = {
  /** ---------- 采集与推理 ---------- */
  capture: {
    width: 640,
    height: 480,
    /** 推理目标帧率上限（降低可省电，过低会影响 PERCLOS 精度） */
    targetFps: 24,
    /** 优先使用 GPU 委托（WebGL），失败自动回退 CPU */
    delegate: 'GPU',
    facingMode: 'user',
  },

  /** ---------- 个性化标定 ---------- */
  calibration: {
    /**
     * 标定时长（秒）：请求驾驶员正视镜头、自然睁眼。
     * 注意这是「累计有效时长」而非墙上时间——只有真正检测到人脸的帧才计入，
     * 人脸不在画面里时倒计时暂停。否则用户还没坐到摄像头前，
     * 8 秒就已经走完并判定标定失败了。
     */
    durationSec: 8,
    /** 等待人脸出现的最长时间（秒）。超过则放弃并回退通用阈值，避免无限等待 */
    maxWaitSec: 45,
    /** 有效样本最少数量，不足则标定失败 */
    minSamples: 60,
    /** 闭眼阈值 = 睁眼基线 EAR × 该系数（经验值 0.68~0.78） */
    earCloseRatio: 0.72,
    /** 睁眼恢复阈值系数（高于闭眼阈值，形成滞回，抗抖动） */
    earOpenRatio: 0.80,
    /** MAR 张口阈值 = 基线 MAR + 该增量 */
    marOpenDelta: 0.35,
    /** 兜底阈值（标定失败时使用的通用固定值） */
    fallback: { earClose: 0.21, earOpen: 0.25, marOpen: 0.55 },
  },

  /** ---------- 数据质量门控 ---------- */
  quality: {
    enabled: true,
    /** 人脸包围盒宽度占画面比例的有效区间（过小=太远，过大=太近） */
    minFaceWidthRatio: 0.16,
    maxFaceWidthRatio: 0.92,
    /** 人脸中心偏离画面中心的最大距离（归一化） */
    maxCenterOffset: 0.34,
    /** 侧转 / 侧倾角上限（度，相对标定零点）。
     *  注意：不设 pitch 上限——低头是疲劳信号，不能当坏数据丢弃 */
    maxYawDeg: 38,
    maxRollDeg: 28,
    /**
     * 语义否决阈值：闭眼状态期间，若 blendshape 语义闭合度低于此值，
     * 立即判为睁眼，不再听几何通道（EAR）。
     *
     * 【为什么需要，以及这个数是怎么定的】
     * EAR 由二维投影关键点算出，头部后仰时眼睛在竖直方向被压缩，
     * EAR 会系统性下降。实测（单被试）仰头超过校准零点约 14° 后，
     * 60 帧里有 56 帧的 EAR 低于闭眼线（低头 −37° 时是 0/53，低头不受影响）。
     * 由于几何通道在跌破闭眼线后饱和为 1，融合值下界正好等于退出阈值 0.60，
     * 状态机会永久卡在"闭眼"——一次 300ms 的眨眼被记成 3.9 秒持续闭眼。
     *
     * 取值依据（同一被试的实测分离度）：
     *   真实闭眼期间语义闭合度   0.61 ~ 0.74
     *   姿态假阳性期间           0.08 ~ 0.41（且随时间回落）
     * 取 0.40：真实闭眼一侧留 0.21 余量；同时与进入条件所需的 0.50
     * 形成 0.10 的滞回带，避免在边界反复开合。
     *
     * 局限：这是单被试标定值，跨人群适用性需要多被试标注数据验证，
     * 论文中应作为已知局限如实说明。
     */
    semanticOpenVeto: 0.40,
    /** 质量不合格时是否暂停疲劳判定（true = 更保守，宁可说"测不准"） */
    gateFatigueJudgement: true,
    /** 连续多少毫秒质量不合格才提示，避免瞬时抖动刷屏 */
    warnAfterMs: 1500,
    /** 光照评估 */
    lightingEnabled: true,
    lightingIntervalMs: 500,
  },

  /** ---------- 指标计算窗口 ---------- */
  window: {
    /**
     * PERCLOS 滑动窗口（秒）。
     * 文献常用 1 分钟，但工程上 30s 在灵敏度与稳定性之间更平衡：
     * 窗口越长越平滑但响应越迟钝，越短越灵敏但易受单次长眨眼影响。
     */
    perclosSec: 30,
    /** 眨眼/哈欠频率统计窗口（秒） */
    rateSec: 60,
    /** 波形图显示窗口（秒） */
    waveSec: 30,
    /**
     * PERCLOS 就绪门控：观测时长与有效样本数都达标后才允许参与疲劳判定。
     * 没有这道门控时，刚启动 2 秒内的一次眨眼会让 PERCLOS 瞬间冲到 30%+，
     * 直接触发误报——因为分母（累计观测时间）还太小。
     */
    perclosMinObservationSec: 10,
    perclosMinSamples: 120,
    /**
     * 允许的最大采样间隔（毫秒）。超过即视为观测间断，
     * 丢弃未闭合的时间区间而不是假设状态延续。
     */
    maxSampleGapMs: 400,
  },

  /** ---------- 事件判定阈值 ---------- */
  event: {
    /** 一次有效眨眼的最短/最长持续时间（毫秒），用于过滤噪声 */
    blinkMinMs: 60,
    blinkMaxMs: 500,
    /** 闭眼超过该时长即判为「微睡眠」 */
    microsleepMs: 500,
    /** 闭眼超过该时长立即触发最高级报警（绕过融合平滑，安全优先） */
    criticalClosureMs: 1800,
    /** 哈欠：MAR 超阈值需持续该时长才算一次哈欠（区别于说话） */
    yawnMinMs: 1200,
    /** 两次哈欠之间的最小间隔，避免同一次哈欠被重复计数 */
    yawnRefractoryMs: 3000,
    /**
     * 人脸丢失需连续多久才上报事件（毫秒）。
     * 只影响事件与时间轴，不影响内部处理——第一个丢帧就会冻结眼睛状态机、
     * 中断 PERCLOS 累积。取 400ms 是因为检测器在大角度侧转时会逐帧闪烁，
     * 实测一次 6 秒的转头会产生 8 组丢失/恢复事件，把时间轴刷满。
     */
    faceLostReportMs: 400,
    /** 点头：pitch 角速度阈值（度/秒）与最小间隔 */
    nodPitchVelDegPerSec: 55,
    nodRefractoryMs: 900,
    /** 头部偏离：|yaw| 或 |pitch| 超过该角度（度）视为视线离开前方 */
    headDeviationDeg: 25,
    /** 偏离持续超过该时长才计入分心事件 */
    distractionMinMs: 1500,
  },

  /** ---------- 多特征融合权重（归一化后合计为 1） ---------- */
  fusion: {
    weights: {
      perclos: 0.30,      // 眼睛闭合时间占比：核心指标
      closureDur: 0.20,   // 最长持续闭眼时长：微睡眠强信号
      blinkRate: 0.10,    // 眨眼频率相对基线的偏移
      blinkDur: 0.08,     // 平均眨眼时长（疲劳时变长）
      yawn: 0.14,         // 哈欠频率
      nod: 0.10,          // 点头频率
      headDev: 0.08,      // 头部/视线偏离占比
    },
    /** 指数移动平均系数，越小越平滑（抑制单帧噪声） */
    emaAlpha: 0.12,
    /** 等级阈值（0~100 疲劳指数） */
    levels: [
      { key: 'awake', label: '清醒', min: 0, max: 30 },
      { key: 'mild', label: '轻度疲劳', min: 30, max: 52 },
      { key: 'moderate', label: '中度疲劳', min: 52, max: 74 },
      { key: 'severe', label: '重度疲劳', min: 74, max: 100 },
    ],
    /** 等级滞回带宽：跌回下一级需低于阈值该数值，避免临界反复跳变 */
    hysteresis: 6,
    /** 等级切换需连续满足的时长（毫秒），进一步防抖 */
    levelDwellMs: 1200,
    /**
     * 各等级的最短保持时长（毫秒）：升到该等级后，至少保持这么久才允许降级。
     * 现实依据：刚发生过危险闭眼的驾驶员，不可能一秒后就恢复到安全状态。
     * 没有这个约束时，重度疲劳阶段的反复微睡眠会让等级在 severe/moderate
     * 之间来回跳，界面观感差，也会稀释最高级警报的严肃性。
     */
    minHoldMs: { awake: 0, mild: 2000, moderate: 4000, severe: 8000 },
  },

  /** ---------- 报警策略 ---------- */
  alarm: {
    enabled: true,
    /** 各等级的报警配置：声音频率(Hz)、蜂鸣次数、是否语音播报、冷却时间 */
    byLevel: {
      awake: { beep: null, speak: null, cooldownMs: 0 },
      mild: { beep: { freq: 660, times: 1, gain: 0.16 }, speak: '注意，检测到轻度疲劳，建议开窗通风', cooldownMs: 25000 },
      moderate: { beep: { freq: 880, times: 2, gain: 0.24 }, speak: '中度疲劳，请尽快找服务区休息', cooldownMs: 15000 },
      severe: { beep: { freq: 1150, times: 4, gain: 0.34 }, speak: '危险！重度疲劳，请立即停车休息', cooldownMs: 8000 },
    },
    /** 语音播报开关（浏览器 SpeechSynthesis） */
    speechEnabled: true,
    /** 视觉闪烁强度（0 关闭） */
    flashEnabled: true,
  },

  /** ---------- 可视化 ---------- */
  render: {
    showMesh: true,        // 面部网格（稀疏点云）
    showContours: true,    // 眼/嘴/脸廓轮廓
    showIris: true,        // 虹膜
    showMetricsHud: true,  // 视频左上角浮层数值
    mirror: true,          // 镜像显示（符合照镜子直觉）
  },

  /** ---------- 视频离线评测 ---------- */
  evaluation: {
    /**
     * 采样步长（毫秒）。必须小于 window.maxSampleGapMs，否则每帧都被判为观测间断。
     * 100ms 相当于 10Hz：正常眨眼（100~400ms）多数能被采到，
     * PERCLOS 与长闭眼完全可靠；步长越小越精确但评测耗时越长。
     */
    stepMs: 100,
    /** 用于个性化标定的视频开头时长（秒）。0 表示跳过标定、使用通用阈值 */
    calibSec: 8,
    /** 二分类正类起始等级：从哪一级开始算作"疲劳" */
    positiveFrom: 'mild',
  },

  /** ---------- 记录与报告 ---------- */
  record: {
    /** 指标采样间隔（毫秒），用于生成会话报告与趋势 */
    sampleIntervalMs: 500,
    /** 报告最多保留的样本数（约 1 小时 @0.5s） */
    maxSamples: 7200,
    maxEvents: 2000,
  },
};

/** 深拷贝一份默认值，供「恢复默认」使用 */
export const DEFAULT_CONFIG = JSON.parse(JSON.stringify(CONFIG));

/** 从 localStorage 载入用户调整过的参数（仅覆盖已知字段，避免脏数据） */
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

export function resetConfig() {
  deepMerge(CONFIG, DEFAULT_CONFIG);
  try {
    localStorage.removeItem('fatigue.config.v1');
  } catch {
    /* noop */
  }
}

function deepMerge(target, patch) {
  if (!isPlainObject(target) || !isPlainObject(patch)) return;
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (!Object.prototype.hasOwnProperty.call(target, k) || isUnsafeKey(k)) continue;
    const current = target[k];
    if (isPlainObject(current)) {
      if (!isPlainObject(v)) continue;
      deepMerge(target[k], v);
    } else if (typeof current === typeof v && (typeof v !== 'number' || Number.isFinite(v))) {
      target[k] = v;
    }
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isUnsafeKey(key) {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}
