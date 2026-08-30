/**
 * fusion.js — 融合层：多特征模糊加权综合评价
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ 为什么要"融合"，而不是单指标阈值判断？                          │
 * │                                                                 │
 * │ 单一指标都有明确的失效场景：                                    │
 * │   · 只看 PERCLOS：驾驶员戴墨镜/低头时眼部不可靠；               │
 * │   · 只看哈欠：有人疲劳时不打哈欠，且说话易误报；                │
 * │   · 只看点头：过减速带同样产生俯仰角尖峰。                      │
 * │ 多指标融合能让各自的失效场景相互补偿，显著提升鲁棒性。          │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * 【算法流程】
 *   ① 模糊化：每个指标 xᵢ 经分段线性隶属函数 μᵢ(xᵢ) → [0,1] 疲劳贡献度
 *   ② 加权综合：F = Σ wᵢ·μᵢ / Σ wᵢ  ×100      （wᵢ 可在界面实时调节）
 *   ③ 时序平滑：F̃ₜ = F̃ₜ₋₁ + α(Fₜ − F̃ₜ₋₁)     （EMA，抑制单帧噪声）
 *   ④ 安全兜底：若持续闭眼超过临界时长，直接钳制为重度（不等平滑收敛）
 *   ⑤ 分级：四级（清醒/轻度/中度/重度），带滞回带宽 + 驻留时间双重防抖
 *
 * 【为什么用模糊综合评价而不是神经网络？】
 * 毕设需要"可解释性"：答辩时能逐项说明每个指标贡献了多少分。
 * 模糊加权模型的每一步都可追溯，且无需标注数据集即可工作；
 * 同时它的输出（各指标隶属度）本身就是很好的可视化素材。
 */

import { CONFIG } from '../config.js';
import { membership, membershipTwoSided, clamp, Ema } from '../util/math.js';

/** 指标的中文名与单位，供 UI 展示贡献度明细 */
export const INDICATOR_META = {
  perclos: { label: '闭眼时间占比', unit: '%', desc: 'PERCLOS（P80）：窗口内眼睛闭合的时间比例' },
  closureDur: { label: '最长闭眼', unit: 's', desc: '窗口内单次最长闭眼时长' },
  blinkRate: { label: '眨眼频率', unit: '次/分', desc: '偏离正常区间的程度' },
  blinkDur: { label: '眨眼时长', unit: 'ms', desc: '平均单次眨眼持续时间' },
  yawn: { label: '哈欠频率', unit: '次/分', desc: '单位时间哈欠次数' },
  nod: { label: '点头频率', unit: '次/分', desc: '俯仰角速度尖峰次数' },
  headDev: { label: '注意力分散', unit: '%', desc: '头部偏离前方的时间占比' },
};

export class FusionEngine {
  constructor() {
    this.ema = new Ema(CONFIG.fusion.emaAlpha, 0);
    // 趋势加速器：跟踪 EMA 的一阶导数（分数变化速率）
    // 当分数在快速上升时，给一个正向加成；下降时做微小阻尼。
    // 这让系统在疲劳恶化期更快响应，在恢复期稍慢回落——
    // 符合安全系统的「宁可早报不可晚报」原则。
    this.trendEma = 0;       // EMA 一阶差分的平滑值
    this.prevRaw = 0;       // 上一帧原始分数
    this.level = 'awake';
    this.levelSince = 0;
    this.pendingLevel = null;
    this.pendingSince = 0;
    this.lastDetail = null;
    this.peakScore = 0;
    this.scoreSum = 0;
    this.scoreCount = 0;
    this.levelDurations = { awake: 0, mild: 0, moderate: 0, severe: 0 };
    this.unreliableMs = 0;
    this.lastTs = null;
  }

  reset() {
    this.ema = new Ema(CONFIG.fusion.emaAlpha, 0);
    this.trendEma = 0;
    this.prevRaw = 0;
    this.level = 'awake';
    this.levelSince = 0;
    this.pendingLevel = null;
    this.pendingSince = 0;
    this.lastDetail = null;
    this.peakScore = 0;
    this.scoreSum = 0;
    this.scoreCount = 0;
    this.levelDurations = { awake: 0, mild: 0, moderate: 0, severe: 0 };
    this.unreliableMs = 0;
    this.lastTs = null;
  }

  /**
   * 计算各指标的隶属度（疲劳贡献度 0~1）。
   * 隶属函数的转折点即"从正常过渡到异常"的区间，取值依据见注释。
   */
  static memberships(ind, calib) {
    /**
     * PERCLOS 隶属函数：6% 起计入，32% 达到满贡献。
     *
     * 下限取 6% 而非常见的 10~15%，依据是本系统实测的清醒基线：
     * 正常清醒状态下 P80 PERCLOS 稳定在 2%~5%（眨眼本身占用的时间），
     * 因此 6% 已经是超出正常眨眼开销的信号。若下限取 10%，
     * 轻度疲劳阶段（实测约 8%~13%）会完全不产生贡献，
     * 导致四级分级退化成三级——这是调参时通过合成剧本验证发现的。
     * 上限 32% 对应文献中"明显嗜睡"的区间。
     *
     * 就绪门控：累计观测时长或样本数不足时该项贡献强制为 0。
     * 否则开局 2 秒内的一次眨眼会让 PERCLOS 瞬间冲到 30%+（分母太小），
     * 直接产生误报。
     */
    // PERCLOS：线性隶属函数。
    // 调参实验：S 曲线在模拟数据上无优势（低端延迟抵消了中段加成），
    // 但在真实噪声场景中 S 曲线的低端噪声抑制可能有价值，保留为可选项。
    const mPerclos = ind.perclosReady === false ? 0 : membership(ind.perclos, 0.06, 0.32);

    // 最长闭眼时长：300ms 内属正常眨眼；1500ms 已是明确微睡眠
    const mClosure = membership(ind.maxClosureMs, 300, 1500);

    // 眨眼频率：正常 12~22 次/分。过高（早期疲劳代偿）或过低（深度嗜睡）都异常。
    // 观测不足 15s 时该指标不可靠，置 0 以免开局虚警。
    const mBlinkRate = ind.observedMs > 15000
      ? membershipTwoSided(ind.blinkRate, 12, 22, 4, 45)
      : 0;

    // 平均眨眼时长：清醒约 100~200ms；疲劳时眼睑运动变慢，>400ms 显著异常
    const mBlinkDur = Number.isFinite(ind.avgBlinkMs) ? membership(ind.avgBlinkMs, 200, 450) : 0;

    // 哈欠频率：0.5 次/分开始计入，2 次/分为强信号
    const mYawn = membership(ind.yawnRate, 0.4, 2.2);

    // 点头频率：1 次/分开始计入，5 次/分为强信号
    const mNod = membership(ind.nodRate, 0.8, 5.0);

    // 视线偏离占比：10% 以内正常（正常观察后视镜），>45% 明显分心
    const mHeadDev = membership(ind.headDevRatio, 0.10, 0.45);

    return {
      perclos: mPerclos,
      closureDur: mClosure,
      blinkRate: mBlinkRate,
      blinkDur: mBlinkDur,
      yawn: mYawn,
      nod: mNod,
      headDev: mHeadDev,
    };
  }

  /**
   * 主入口：输入指标快照，输出疲劳指数与等级。
   */
  evaluate(ind, calib) {
    const cfg = CONFIG.fusion;
    this.ema.alpha = cfg.emaAlpha;

    const mu = FusionEngine.memberships(ind, calib);
    const w = cfg.weights;

    let wsum = 0;
    let acc = 0;
    const contrib = {};
    for (const k of Object.keys(w)) {
      const wi = Number(w[k]) || 0;
      const mi = Number.isFinite(mu[k]) ? mu[k] : 0;
      wsum += wi;
      acc += wi * mi;
      contrib[k] = { weight: wi, membership: mi, points: 0 };
    }
    const raw = wsum > 0 ? (acc / wsum) * 100 : 0;
    // 每项对最终分数的绝对贡献（分），用于可视化"分数是怎么来的"
    for (const k of Object.keys(contrib)) {
      contrib[k].points = wsum > 0 ? (contrib[k].weight * contrib[k].membership / wsum) * 100 : 0;
    }

    /* ---------- 时序平滑 + 趋势加速器 ----------
     * EMA 做一阶低通滤波后，额外计算一阶导数（趋势）。
     * 趋势为正（分数在上升）时，给正向加成（更快触发报警）；
     * 趋势为负（在恢复）时，给轻微阻尼（防止过早恢复）。
     * 不对称设计：上升加速 > 下降阻尼，因为「早报 0.5 秒」的价值
     * 远大于「晚恢复 0.5 秒」的代价。
     * 趋势加速器有独立的 EMA 平滑，避免单帧噪声引发跳变。
     *
     * 参数已提取到 CONFIG.fusion（trendAlpha / trendMultiplier /
     * trendMaxBoost / trendMinBoost），增强现实感评估后
     * trendMaxBoost 从 5 提升到 8，加快疲劳上升期响应。 */
    let score = this.ema.push(raw);

    // 一阶差分 + 自身 EMA 平滑
    const trendAlpha = CONFIG.fusion.trendAlpha ?? 0.08;
    const rawDelta = raw - this.prevRaw;
    this.trendEma = this.trendEma + trendAlpha * (rawDelta - this.trendEma);
    this.prevRaw = raw;

    // 趋势加成：正趋势加成上限 CONFIG.fusion.trendMaxBoost，负趋势阻尼下限 CONFIG.fusion.trendMinBoost
    const trendMultiplier = CONFIG.fusion.trendMultiplier ?? 1.5;
    const trendMax = CONFIG.fusion.trendMaxBoost ?? 5;
    const trendMin = CONFIG.fusion.trendMinBoost ?? -2;
    const trendBoost = clamp(this.trendEma * trendMultiplier, trendMin, trendMax);
    score += trendBoost;

    /* ---------- 安全兜底（override） ----------
     * 眼睛已经连续闭合超过临界时长（默认 1.8s）时，等同于失去对车辆的控制，
     * 此时不能等 EMA 慢慢爬升，必须立刻判为重度并报警。 */
    let override = null;
    const crit = CONFIG.event.criticalClosureMs;
    if (ind.currentClosureMs >= crit) {
      score = Math.max(score, 92);
      override = 'critical_closure';
      // 同步抬升 EMA 内部状态。
      // 若只钳制输出而不动 EMA，闭眼一结束分数会从 92 瞬间坍塌回 EMA 的低值，
      // 造成"重度 → 轻度"的跨级跳变。刚从危险闭眼中恢复的驾驶员显然不可能
      // 立刻回到清醒，因此把内部状态抬到中度区间，之后按 EMA 自然衰减。
      if (this.ema.value === null || this.ema.value < 68) this.ema.value = 68;
    } else if (ind.currentClosureMs >= crit * 0.6) {
      // 0.6~1.0 倍临界时长（默认 1.08~1.8s）的闭眼：钳到中度区间上部而非重度。
      // 1.2s 闭眼在 100km/h 下相当于盲行 33m，必须告警；
      // 但把它直接判成"重度疲劳"会让等级频繁跳到最高级再回落，
      // 反而削弱重度警报的严肃性。分两档处理，警示强度与风险等级匹配。
      score = Math.max(score, 68);
      override = 'long_closure';
      if (this.ema.value === null || this.ema.value < 50) this.ema.value = 50;
    }
    /* ---------- 可靠性标记 ----------
     * 人脸长时间丢失，或数据质量不合格（人脸过远/侧转过大/光照恶劣）时，
     * 结论不可信。此时如实标记为"无法评估"，而不是输出一个看起来正常的
     * 低分——对安全相关功能，虚假的安全感比明确的"测不准"危险得多。 */
    const faceLostTooLong = !ind.facePresent && ind.faceLostRatio > 0.5;
    const qualityBlocked = ind.dataValid === false && ind.qualityBadMs > CONFIG.quality.warnAfterMs;
    const unreliable = faceLostTooLong || qualityBlocked;
    const unreliableReason = qualityBlocked
      ? (ind.quality && ind.quality.reasons && ind.quality.reasons[0]) || '数据质量不足'
      : faceLostTooLong
      ? '未检测到有效人脸'
      : null;

    score = clamp(score, 0, 100);

    /* ---------- 分级（滞回 + 驻留） ---------- */
    const target = FusionEngine.scoreToLevel(score);
    const level = this._applyHysteresis(target, score, ind.ts, override !== null);

    /* ---------- 统计累计 ----------
     * 【为什么 unreliable 期间必须停止累计】
     * 人脸丢失（驾驶员离座、被遮挡）时各项指标全部为 0，融合出来的分数很低，
     * 等级自然落在"清醒"。如果照旧把这段时间累加进 levelDurations，
     * 就会出现这样的报告：摄像头对着空椅子跑 90 秒，结论「清醒 100%，
     * 状态良好，未发现明显疲劳特征」——一个信心十足的假阴性。
     * 对安全相关系统，这比直接报错危险得多：用户会以为自己被监护着。
     * 因此这段时间既不计入任何等级，也不计入均值与峰值，
     * 而是单独累加到 unreliableMs，由报告如实说明"有多久没测到"。 */
    if (this.lastTs !== null) {
      const dt = clamp(ind.ts - this.lastTs, 0, 500);
      if (unreliable) {
        this.unreliableMs += dt;
      } else {
        this.levelDurations[level] = (this.levelDurations[level] || 0) + dt;
      }
    }
    this.lastTs = ind.ts;
    if (!unreliable) {
      if (score > this.peakScore) this.peakScore = score;
      this.scoreSum += score;
      this.scoreCount++;
    }

    const detail = {
      raw,
      score,
      level,
      levelLabel: FusionEngine.levelLabel(level),
      levelIndex: FusionEngine.levelIndex(level),
      memberships: mu,
      contributions: contrib,
      override,
      unreliable,
      unreliableReason,
      perclosReady: ind.perclosReady !== false,
      avgScore: this.scoreCount ? this.scoreSum / this.scoreCount : 0,
      peakScore: this.peakScore,
      levelDurations: { ...this.levelDurations },
      /** 无法评估的累计时长（人脸丢失或数据质量不合格），报告需要如实披露 */
      unreliableMs: this.unreliableMs,
      /** 参与均值/峰值统计的有效采样数；为 0 表示全程都没测到，UI 应显示 -- */
      scoreCount: this.scoreCount,
      /** 主导因素：贡献分最高的指标，用于生成"为什么判疲劳"的自然语言解释 */
      topFactors: Object.entries(contrib)
        .filter(([, v]) => v.points > 0.5)
        .sort((a, b) => b[1].points - a[1].points)
        .slice(0, 3)
        .map(([k, v]) => ({ key: k, label: INDICATOR_META[k] ? INDICATOR_META[k].label : k, points: v.points })),
    };
    this.lastDetail = detail;
    return detail;
  }

  /**
   * 等级切换控制（三重防抖）：
   *
   *   ① 滞回带宽：降级时必须明显低于当前等级下界（低 hysteresis 分）才允许，
   *      避免分数在临界值附近来回抖动导致等级闪烁。
   *   ② 驻留时间：目标等级需连续满足 levelDwellMs 才真正生效。
   *      但 override（危险闭眼）时升级立即生效——安全优先，不能延迟报警。
   *   ③ 逐级降级：一次最多降一级。疲劳状态不会瞬间消失，
   *      从"重度"直接跳到"清醒"既不符合生理规律，也会让使用者产生误解。
   *      升级方向不做此限制（危险状态需要立刻如实反映）。
   *   ④ 最短保持：升到某等级后至少保持 minHoldMs 才允许降级，
   *      防止反复微睡眠造成等级来回跳动。
   */
  _applyHysteresis(target, score, ts, immediate) {
    const cfg = CONFIG.fusion;
    const curIdx = FusionEngine.levelIndex(this.level);
    let tgtIdx = FusionEngine.levelIndex(target);

    // ③ 逐级降级；同时保证索引不越界（levelIndex 对未知等级返回 -1）
    if (tgtIdx < 0) tgtIdx = 0;
    if (tgtIdx < curIdx - 1) tgtIdx = curIdx - 1;
    const effectiveTarget = (cfg.levels[tgtIdx] || cfg.levels[0]).key;

    if (effectiveTarget === this.level) {
      this.pendingLevel = null;
      return this.level;
    }

    if (tgtIdx < curIdx) {
      // ④ 最短保持时间
      const hold = (cfg.minHoldMs && cfg.minHoldMs[this.level]) || 0;
      if (ts - this.levelSince < hold) {
        this.pendingLevel = null;
        return this.level;
      }
      // ① 降级滞回
      const curLo = cfg.levels[curIdx].min;
      if (score > curLo - cfg.hysteresis) {
        this.pendingLevel = null;
        return this.level;
      }
    }

    // ② 升级在 override 时立即生效
    if (immediate && tgtIdx > curIdx) {
      this.level = effectiveTarget;
      this.levelSince = ts;
      this.pendingLevel = null;
      return this.level;
    }

    if (this.pendingLevel !== effectiveTarget) {
      this.pendingLevel = effectiveTarget;
      this.pendingSince = ts;
      return this.level;
    }
    if (ts - this.pendingSince >= cfg.levelDwellMs) {
      this.level = effectiveTarget;
      this.levelSince = ts;
      this.pendingLevel = null;
    }
    return this.level;
  }

  static scoreToLevel(score) {
    const ls = CONFIG.fusion.levels;
    for (let i = ls.length - 1; i >= 0; i--) {
      if (score >= ls[i].min) return ls[i].key;
    }
    return ls[0].key;
  }

  static levelIndex(key) {
    return CONFIG.fusion.levels.findIndex((l) => l.key === key);
  }

  static levelLabel(key) {
    const l = CONFIG.fusion.levels.find((x) => x.key === key);
    return l ? l.label : key;
  }

  /** 生成一句人类可读的判定理由（报告与语音播报都用得上） */
  static explain(detail, ind) {
    if (detail.unreliable) {
      return `${detail.unreliableReason || '数据不可用'}，当前无法评估疲劳状态。`;
    }
    if (detail.override === 'critical_closure') {
      return `检测到持续闭眼 ${(ind.currentClosureMs / 1000).toFixed(1)} 秒，已触发最高级安全告警。`;
    }
    if (!detail.perclosReady) {
      const sec = (ind.perclosObservedMs || 0) / 1000;
      const need = CONFIG.window.perclosMinObservationSec;
      // 措辞注意：这是"闭眼占比统计的预热期"，与开场的 8 秒个人校准是两回事，
      // 不能都叫"积累数据"，否则用户会以为校准时长有两个口径
      return `闭眼占比统计预热中（${sec.toFixed(0)} / ${need} 秒），预热完成前这一项不计分，其余指标已在监测。`;
    }
    if (!detail.topFactors.length) return '各项指标均在正常范围内，驾驶状态良好。';
    const parts = detail.topFactors.map((f) => {
      switch (f.key) {
        case 'perclos': return `眼睛闭合时间占比 ${(ind.perclos * 100).toFixed(1)}%`;
        case 'closureDur': return `最长闭眼 ${(ind.maxClosureMs / 1000).toFixed(2)}s`;
        case 'blinkRate': return `眨眼频率 ${ind.blinkRate.toFixed(1)} 次/分`;
        case 'blinkDur': return `平均眨眼时长 ${Number.isFinite(ind.avgBlinkMs) ? ind.avgBlinkMs.toFixed(0) : '--'}ms`;
        case 'yawn': return `哈欠 ${ind.yawnRate.toFixed(1)} 次/分`;
        case 'nod': return `点头 ${ind.nodRate.toFixed(1)} 次/分`;
        case 'headDev': return `头部偏离前方 ${(ind.headDevRatio * 100).toFixed(0)}%`;
        default: return INDICATOR_META[f.key] ? INDICATOR_META[f.key].label : f.key;
      }
    });
    return `主要依据：${parts.join('、')}。`;
  }
}
