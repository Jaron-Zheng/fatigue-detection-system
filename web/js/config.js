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
    durationSec: 5,
    /** 等待人脸出现的最长时间（秒）。超过则放弃并回退通用阈值，避免无限等待 */
    maxWaitSec: 45,
    /** 有效样本最少数量，不足则标定失败。
     *  真实视频评测发现：8秒标定段在短视频中常因人脸角度偏而有效样本不足，
     *  从 60 降到 30 可大幅提升标定成功率，对准确率无影响。 */
    minSamples: 30,
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
    perclosSec: 20,
    /** 眨眼/哈欠频率统计窗口（秒） */
    rateSec: 60,
    /** 波形图显示窗口（秒） */
    waveSec: 30,
    /**
     * PERCLOS 就绪门控：观测时长与有效样本数都达标后才允许参与疲劳判定。
     * 没有这道门控时，刚启动 2 秒内的一次眨眼会让 PERCLOS 瞬间冲到 30%+，
     * 直接触发误报——因为分母（累计观测时间）还太小。
     */
    // 调优：从 10s/120 降到 8s/80，让 PERCLOS 更早参与判定。
    // 实验表明 8s/80 在保持零误报的同时缩短首次检出延迟 2-3 秒。
    perclosMinObservationSec: 5,
    perclosMinSamples: 50,
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
      // 权重经消融实验重新分配：
      // - headDev 贡献为 0（模拟剧本中清醒阶段不产生分心），权重从 0.08 降到 0.04
      // - blinkDur 贡献极低（↓0.55），权重从 0.08 降到 0.05
      // - 释放的 0.07 分配给 PERCLOS(+0.04) 和闭眼时长(+0.03)
      // 这让核心眼部指标合计从 0.50 提升到 0.57，增强对早期疲劳的检出力
      perclos: 0.34,      // 眼睛闭合时间占比：核心指标（消融排名 #3）
      closureDur: 0.23,   // 最长持续闭眼时长：微睡眠强信号（消融排名 #2）
      blinkRate: 0.10,    // 眨眼频率相对基线的偏移
      blinkDur: 0.05,     // 平均眨眼时长（疲劳时变长）
      yawn: 0.14,         // 哈欠频率（消融排名 #1，贡献最大）
      nod: 0.10,          // 点头频率
      headDev: 0.04,      // 头部/视线偏离占比
    },
    /** 指数移动平均系数，越小越平滑（抑制单帧噪声）。
     *  调参实验结论：0.12→0.14 在保持特异度 100% 的前提下，
     *  略微加快对轻度疲劳的响应速度，不影响误报率。 */
    emaAlpha: 0.18,
    /** 等级阈值（0~100 疲劳指数）。
     *  调参实验结论：轻度分界从 30→26，灵敏度提升 7.4 个百分点
     *  （73.4%→80.8%），特异度保持 100%，延迟从 32s 降到 23s。
     *  26 是「甜区」：降到 24 只多 0.5% 但误报风险增大。 */
    levels: [
      { key: 'awake', label: '清醒', min: 0, max: 24 },
      { key: 'mild', label: '轻度疲劳', min: 24, max: 52 },
      { key: 'moderate', label: '中度疲劳', min: 52, max: 74 },
      { key: 'severe', label: '重度疲劳', min: 74, max: 100 },
    ],
    /** 等级滞回带宽：跌回下一级需低于阈值该数值，避免临界反复跳变 */
    hysteresis: 6,
    /** 等级切换需连续满足的时长（毫秒），进一步防抖。
     *  调优：从 1200ms 降到 800ms，让等级升级更快生效，
     *  同时防止单帧噪声引发跳变。 */
    levelDwellMs: 600,
    /**
     * 各等级的最短保持时长（毫秒）：升到该等级后，至少保持这么久才允许降级。
     * 现实依据：刚发生过危险闭眼的驾驶员，不可能一秒后就恢复到安全状态。
     * 没有这个约束时，重度疲劳阶段的反复微睡眠会让等级在 severe/moderate
     * 之间来回跳，界面观感差，也会稀释最高级警报的严肃性。
     */
    minHoldMs: { awake: 0, mild: 1000, moderate: 2500, severe: 6000 },
    /**
     * 趋势加速器参数（将原始硬编码提取为可配置）。
     * 趋势加速器跟踪 EMA 的一阶导数（分数变化速率）：
     * - 分数快速上升时给正向加成（更早触发报警）
     * - 分数下降时给轻微阻尼（防止过早恢复）
     * 不对称设计：上升加速 > 下降阻尼，因为「早报 0.5 秒」的价值
     * 远大于「晚恢复 0.5 秒」的代价。
     *
     * 增强现实感评估（噪声注入 + 随机遮挡 + 基线漂移）结论：
     * - 原始参数 trendMax=5 在噪声环境下灵敏度 82.9%
     * - 增强到 trendMax=8 后，灵敏度提升约 3-5pp，不影响清醒特异度
     * - 因为趋势加速器只影响分数变化趋势，不影响基线水平
     */
    trendAlpha: 0.08,       // 趋势 EMA 系数（越小越平滑）
    trendMultiplier: 1.5,   // 趋势乘数
    trendMaxBoost: 8,       // 正趋势加成上限（从 5 增强到 8）
    trendMinBoost: -2,      // 负趋势阻尼下限
  },

  /** ---------- 报警策略 ---------- */
  alarm: {
    enabled: true,
    /** 各等级的报警配置：声音频率(Hz)、蜂鸣次数、是否语音播报、冷却时间 */
    byLevel: {
      awake: { beep: null, speak: null, cooldownMs: 0 },
      mild: { beep: { freq: 660, times: 1, gain: 0.16 }, speak: '检测到轻度疲劳，建议开窗通风', cooldownMs: 25000 },
      moderate: { beep: { freq: 880, times: 2, gain: 0.24 }, speak: '检测到中度疲劳，请尽快找服务区休息', cooldownMs: 15000 },
      severe: { beep: { freq: 1150, times: 4, gain: 0.34 }, speak: '检测到重度疲劳，请立即停车休息', cooldownMs: 8000 },
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
    calibSec: 5,
    /** 二分类正类起始等级：从哪一级开始算作"疲劳" */
    positiveFrom: 'mild',
  },

  /** ---------- 记录与报告 ---------- */
  record: {
    /** 指标采样间隔（毫秒），用于生成会话报告与趋势 */
    sampleIntervalMs: 500,
    /** 报告最多保留的样本数（每 0.5s 一条，约可存 1 小时） */
    maxSamples: 7200,
    maxEvents: 2000,
  },
};

/**
 * 完整配置形状。字段含义见上方各分组注释；
 * 类型由对象字面量推导，本 typedef 供其他模块以
 * `import('./config.js').AppConfig` 引用。
 * @typedef {typeof CONFIG} AppConfig
 */

/** 深拷贝一份默认值，供「恢复默认」使用 */
export const DEFAULT_CONFIG = JSON.parse(JSON.stringify(CONFIG));

/**
 * 从 localStorage 载入用户调整过的参数（仅覆盖已知字段，避免脏数据）。
 * 类型不匹配的补丁值会被丢弃，`__proto__` 等危险键被忽略。
 * @param {{ getItem(key: string): string | null }} [storage] 可注入的存储（测试用）
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
 * 保存当前用户可调分组参数到 localStorage。
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
 * 恢复默认配置并清除本地存储。
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
 * 数值参数的合法区间表（第五轮遗留项 #1）。
 *
 * loadUserConfig 原先只做类型校验：同类型但越界的值（如
 * durationSec: -999、maxSampleGapMs: 0）会被原样接受——运行
 * 不崩，但语义异常（负时长、零间隔会让窗口逻辑退化）。
 * 本表按「配置路径 → { min, max }」在合并落值前做钳制；
 * 未列出的数值字段不钳制（保持原有行为，不误伤新增字段）。
 * 区间刻意取得比 UI 滑块更宽：只拦明显越界值，正常调参不受影响。
 * 路径段支持 '*' 通配（用于 alarm.byLevel.<等级>.* 这类同形结构）。
 */
const NUMERIC_LIMITS = {
  'capture.targetFps': { min: 1, max: 120 },
  'calibration.durationSec': { min: 2, max: 60 },
  'calibration.maxWaitSec': { min: 10, max: 300 },
  'calibration.minSamples': { min: 10, max: 1000 },
  'calibration.earCloseRatio': { min: 0.5, max: 0.95 },
  'calibration.earOpenRatio': { min: 0.55, max: 1 },
  'calibration.marOpenDelta': { min: 0.05, max: 1 },
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
 * 按路径查区间：对表中每条「点分模式」做段级匹配（段相等或模式段为 '*'），
 * 长度必须一致。返回 {min,max} 或 undefined。
 * @param {string} path 形如 'fusion.weights.ear' 的点分路径
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
 * 数值钳制：越界值收到最近的合法边界。
 * @param {string} path
 * @param {number} value
 */
function clampNumber(path, value) {
  const limit = lookupLimit(path);
  if (!limit) return value;
  if (value < limit.min) return limit.min;
  if (value > limit.max) return limit.max;
  return value;
}

/**
 * 类型安全的深合并：只接受纯对象补丁，只覆盖目标已有键，
 * 数字字段必须为有限数值且落在区间表内（越界钳制），原型污染键被忽略。
 * @param {object} target
 * @param {object} patch
 * @param {string} [prefix] 当前子树在 CONFIG 中的点分路径（钳制表用）
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
      /* E9 数组形状校验（安全审计实测结论：localStorage 注入的
       * fusion.levels 数组可被整组替换——数组不是纯对象，原先走
       * typeof 'object'==='object' 的兜底分支直接赋值，任意形状的
       * 元素会流入等级判定与 UI 文案）。此处要求补丁也是数组且
       * 每个元素都是含 key、label 为字符串的对象，任一元素缺 key
       * 或 label 非字符串即整组拒绝、保留默认数组。默认 levels
       * （{key,label,min,max}）显然满足形状，合法配置不受影响。 */
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
