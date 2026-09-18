/**
 * fusion.js — 融合层：多特征模糊加权综合评价
 *
 * 算法流程：
 *   ① 模糊化：每个指标经分段线性隶属函数 → [0,1] 疲劳贡献度
 *   ② 加权综合：F = Σ wᵢ·μᵢ / Σ wᵢ × 100
 *   ③ 时序平滑：EMA 低通滤波 + 趋势加速器
 *   ④ 安全兜底：持续闭眼超过临界时长直接钳制为重度
 *   ⑤ 分级：四级（清醒/轻度/中度/重度），滞回 + 驻留双重防抖
 */

import { CONFIG, PERCLOS_MU_LO, PERCLOS_MU_HI } from '../config.js';
import { membership, membershipTwoSided, clamp, Ema } from '../util/math.js';

/** 指标中文名与单位，供 UI 展示贡献度明细 */
export const INDICATOR_META = {
  perclos: { label: '闭眼时间占比', unit: '%', desc: 'PERCLOS（P80）：窗口内眼睛闭合的时间比例' },
  closureDur: { label: '最长闭眼', unit: '秒', desc: '窗口内单次最长闭眼时长' },
  blinkRate: { label: '眨眼频率', unit: '次/分', desc: '偏离正常区间的程度' },
  blinkDur: { label: '眨眼时长', unit: '毫秒', desc: '平均单次眨眼持续时间' },
  yawn: { label: '哈欠频率', unit: '次/分', desc: '单位时间哈欠次数' },
  nod: { label: '点头频率', unit: '次/分', desc: '俯仰角速度尖峰次数' },
  headDev: { label: '注意力分散', unit: '%', desc: '头部偏离前方的时间占比' },
};

/**
 * 趋势加速器状态推进（在线与离线共享）
 * @param {number} trendEma 上一帧的趋势 EMA 值
 * @param {number} raw 本帧原始分数
 * @param {number} prevRaw 上一帧原始分数
 * @returns {{ trendEma: number, boost: number }}
 */
export function advanceTrend(trendEma, raw, prevRaw) {
  const alpha = CONFIG.fusion.trendAlpha ?? 0.08;
  const next = trendEma + alpha * ((raw - prevRaw) - trendEma);
  const multiplier = CONFIG.fusion.trendMultiplier ?? 1.5;
  const max = CONFIG.fusion.trendMaxBoost ?? 5;
  const min = CONFIG.fusion.trendMinBoost ?? -2;
  return { trendEma: next, boost: clamp(next * multiplier, min, max) };
}

/**
 * 可靠性判定（在线与离线共享）
 * 双臂判定：连续丢失超时 或 累计丢失比过半
 * @param {object} ind 指标快照
 * @returns {{ unreliable: boolean, reason: string|null }}
 */
export function assessUnreliable(ind) {
  const gateMs = CONFIG.fusion.faceLostGateMs ?? 3000;
  const faceLostTooLong =
    ind.facePresent === false &&
    ((ind.faceLostMs ?? 0) > gateMs || (ind.faceLostRatio ?? 0) > 0.5);
  const qualityBlocked =
    ind.dataValid === false &&
    ind.facePresent !== false &&
    (ind.qualityBadMs ?? 0) > CONFIG.quality.warnAfterMs;
  const reason = faceLostTooLong
    ? '未检测到有效人脸'
    : qualityBlocked
    ? (ind.quality && ind.quality.reasons && ind.quality.reasons[0]) || '数据质量不足'
    : null;
  return { unreliable: faceLostTooLong || qualityBlocked, reason };
}

export class FusionEngine {
  constructor() {
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
   * 计算各指标的隶属度（疲劳贡献度 0~1）
   * PERCLOS：6% 起计入，32% 达到满贡献，就绪门控不足时为 0
   * 最长闭眼：300ms 内正常眨眼，1500ms 已是微睡眠
   * 眨眼频率：正常 12~22 次/分，过高或过低都异常
   * 眨眼时长：>400ms 显著异常
   * 哈欠：0.4 次/分开始计入，2.2 次/分为强信号
   * 点头：0.8 次/分开始，5.0 次/分为强信号
   * 视线偏离：10% 以内正常，>45% 明显分心
   */
  static memberships(ind, calib) {
    const mPerclos = ind.perclosReady === false ? 0 : membership(ind.perclos, PERCLOS_MU_LO, PERCLOS_MU_HI);
    const mClosure = membership(ind.maxClosureMs, 300, 1500);
    const rateReady = ind.observedMs > (CONFIG.fusion.rateReadyMs ?? 15000);
    const mBlinkRate = rateReady
      ? membershipTwoSided(ind.blinkRate, 12, 22, 4, 45)
      : 0;
    const mBlinkDur = Number.isFinite(ind.avgBlinkMs) ? membership(ind.avgBlinkMs, 200, 450) : 0;
    const mYawn = rateReady ? membership(ind.yawnRate, 0.4, 2.2) : 0;
    const mNod = rateReady ? membership(ind.nodRate, 0.8, 5.0) : 0;
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

  /** 主入口：输入指标快照，输出疲劳指数与等级 */
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
    for (const k of Object.keys(contrib)) {
      contrib[k].points = wsum > 0 ? (contrib[k].weight * contrib[k].membership / wsum) * 100 : 0;
    }

    // EMA 平滑 + 趋势加速器
    let score = this.ema.push(raw);
    const trend = advanceTrend(this.trendEma, raw, this.prevRaw);
    this.trendEma = trend.trendEma;
    this.prevRaw = raw;
    score += trend.boost;

    // 安全兜底：持续闭眼超过临界时长直接判重度
    let override = null;
    const crit = CONFIG.event.criticalClosureMs;
    if (ind.currentClosureMs >= crit) {
      score = Math.max(score, 92);
      override = 'critical_closure';
      if (this.ema.value === null || this.ema.value < 68) this.ema.value = 68;
    } else if (ind.currentClosureMs >= crit * 0.6) {
      score = Math.max(score, 68);
      override = 'long_closure';
      if (this.ema.value === null || this.ema.value < 50) this.ema.value = 50;
    }

    // 可靠性标记
    const { unreliable, reason: unreliableReason } = assessUnreliable(ind);

    score = clamp(score, 0, 100);

    // 分级（滞回 + 驻留）
    const target = FusionEngine.scoreToLevel(score);
    const level = this._applyHysteresis(target, score, ind.ts, override !== null);

    // 统计累计（unreliable 期间不累计）
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
      unreliableMs: this.unreliableMs,
      scoreCount: this.scoreCount,
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
   *   ① 降级滞回带宽：降级时需低于当前等级下界减 hysteresis
   *   ② 驻留时间：目标等级需连续满足 levelDwellMs
   *   ③ 逐级降级：一次最多降一级
   *   ④ 最短保持：升到某等级后至少保持 minHoldMs
   * override 时升级立即生效——安全优先
   */
  _applyHysteresis(target, score, ts, immediate) {
    const cfg = CONFIG.fusion;
    const curIdx = FusionEngine.levelIndex(this.level);
    let tgtIdx = FusionEngine.levelIndex(target);

    if (tgtIdx < 0) tgtIdx = 0;
    if (tgtIdx < curIdx - 1) tgtIdx = curIdx - 1;
    const effectiveTarget = (cfg.levels[tgtIdx] || cfg.levels[0]).key;

    if (effectiveTarget === this.level) {
      this.pendingLevel = null;
      return this.level;
    }

    if (tgtIdx < curIdx) {
      const hold = (cfg.minHoldMs && cfg.minHoldMs[this.level]) || 0;
      if (ts - this.levelSince < hold) {
        this.pendingLevel = null;
        return this.level;
      }
      const curLo = cfg.levels[curIdx].min;
      if (score > curLo - cfg.hysteresis) {
        this.pendingLevel = null;
        return this.level;
      }
    }

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

  /** 生成一句人类可读的判定理由 */
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
      return `闭眼占比统计预热中（${sec.toFixed(0)} / ${need} 秒），预热完成前这一项不计分，其余指标已在监测。`;
    }
    if (!detail.topFactors.length) return '各项指标均在正常范围内，驾驶状态良好。';
    const parts = detail.topFactors.map((f) => {
      switch (f.key) {
        case 'perclos': return `眼睛闭合时间占比 ${(ind.perclos * 100).toFixed(1)}%`;
        case 'closureDur': return `最长闭眼 ${(ind.maxClosureMs / 1000).toFixed(2)} 秒`;
        case 'blinkRate': return `眨眼频率 ${ind.blinkRate.toFixed(1)} 次/分`;
        case 'blinkDur': return `平均眨眼时长 ${Number.isFinite(ind.avgBlinkMs) ? ind.avgBlinkMs.toFixed(0) : '--'} 毫秒`;
        case 'yawn': return `哈欠 ${ind.yawnRate.toFixed(1)} 次/分`;
        case 'nod': return `点头 ${ind.nodRate.toFixed(1)} 次/分`;
        case 'headDev': return `头部偏离前方 ${(ind.headDevRatio * 100).toFixed(0)}%`;
        default: return INDICATOR_META[f.key] ? INDICATOR_META[f.key].label : f.key;
      }
    });
    return `主要依据：${parts.join('、')}。`;
  }
}
