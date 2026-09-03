/**
 * evaluation.js — 准确率评估：混淆矩阵与标准指标
 *
 * 这是把系统从"算法逻辑正确"推进到"检测有效"的关键一环。
 * 输入是逐采样点的（人工标签, 系统判定）配对，输出混淆矩阵与标准指标。
 *
 * 【为什么用二分类】
 * 系统内部输出四级（清醒/轻度/中度/重度），但评估用二分类
 * （正常 vs 疲劳），原因是主观自评难以可靠区分"轻度"与"中度"，
 * 四分类会引入大量标注噪声，反而让指标失去意义。
 * 二分类的判据明确（"当时困不困"），标注一致性高。
 * 系统侧的映射：清醒→正常，轻度及以上→疲劳（阈值可调，见 positiveFrom）。
 *
 * 【为什么灵敏度比准确率重要】
 * 疲劳检测是典型的类别不平衡问题：正常状态占绝大多数时间。
 * 一个"永远输出正常"的系统在清醒为主的数据集上准确率也能很高，
 * 但它毫无用处。因此必须同时报告灵敏度（召回率，漏报的反面）与
 * 特异度（误报的反面），并以灵敏度为主要目标——
 * 漏报一次真实疲劳的代价远高于误报一次。
 */

/** 系统等级 → 二分类正类（疲劳）的映射阈值 */
export const POSITIVE_FROM = {
  mild: ['mild', 'moderate', 'severe'],
  moderate: ['moderate', 'severe'],
  severe: ['severe'],
};

/**
 * 计算混淆矩阵与各项指标。
 *
 * @param {{truth:string, pred:string, weightMs:number}[]} pairs
 *        truth: 'normal' | 'fatigue'
 *        pred:  系统等级 'awake'|'mild'|'moderate'|'severe'
 *        weightMs: 该采样点代表的时间长度（用于时间加权统计）
 * @param {string} positiveFrom 'mild'|'moderate'|'severe' 从哪一级起算作疲劳
 */
export function computeMetrics(pairs, positiveFrom = 'mild') {
  const posLevels = POSITIVE_FROM[positiveFrom] || POSITIVE_FROM.mild;
  const isPos = (level) => posLevels.includes(level);

  // 同时统计"按采样点计数"与"按时间加权"两套结果。
  // 按时间加权更贴近真实占比（采样点可能疏密不均），按点计数便于与文献对照。
  const m = { tp: 0, fp: 0, tn: 0, fn: 0 };
  const mt = { tp: 0, fp: 0, tn: 0, fn: 0 };
  let ignored = 0;
  let unlabeled = 0;

  for (const p of pairs) {
    if (p.truth === 'ignore') {
      ignored++;
      continue;
    }
    if (p.truth !== 'normal' && p.truth !== 'fatigue') {
      unlabeled++;
      continue;
    }
    const truthPos = p.truth === 'fatigue';
    const predPos = isPos(p.pred);
    const w = Number.isFinite(p.weightMs) ? p.weightMs : 0;

    if (truthPos && predPos) {
      m.tp++;
      mt.tp += w;
    } else if (!truthPos && predPos) {
      m.fp++;
      mt.fp += w;
    } else if (!truthPos && !predPos) {
      m.tn++;
      mt.tn += w;
    } else {
      m.fn++;
      mt.fn += w;
    }
  }

  return {
    matrix: m,
    matrixTimeMs: mt,
    counts: { evaluated: m.tp + m.fp + m.tn + m.fn, ignored, unlabeled, total: pairs.length },
    byCount: derive(m),
    byTime: derive(mt),
    positiveFrom,
  };
}

/** 由混淆矩阵导出各项标准指标 */
function derive({ tp, fp, tn, fn }) {
  const total = tp + fp + tn + fn;
  const safe = (num, den) => (den > 0 ? num / den : NaN);

  const accuracy = safe(tp + tn, total);
  const sensitivity = safe(tp, tp + fn); // 召回率 / 真正率：能抓到多少真实疲劳
  const specificity = safe(tn, tn + fp); // 真负率：正常状态不被误报的比例
  const precision = safe(tp, tp + fp); // 查准率：报警中有多少是真的
  const npv = safe(tn, tn + fn); // 负预测值
  const f1 = Number.isFinite(precision) && Number.isFinite(sensitivity) && precision + sensitivity > 0
    ? (2 * precision * sensitivity) / (precision + sensitivity)
    : NaN;
  const balancedAcc = Number.isFinite(sensitivity) && Number.isFinite(specificity)
    ? (sensitivity + specificity) / 2
    : NaN;
  const fpr = safe(fp, fp + tn); // 误报率
  const fnr = safe(fn, fn + tp); // 漏报率

  /**
   * Youden's J = 灵敏度 + 特异度 − 1。
   * 取值 0 表示与随机猜测无异，1 表示完美。
   * 它对类别不平衡不敏感，比准确率更适合本场景。
   */
  const youdenJ = Number.isFinite(sensitivity) && Number.isFinite(specificity)
    ? sensitivity + specificity - 1
    : NaN;

  /**
   * Matthews 相关系数（MCC）：−1 ~ 1，综合四格且对不平衡稳健，
   * 是二分类里公认最稳的单一指标之一。
   */
  const denom = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn));
  const mcc = denom > 0 ? (tp * tn - fp * fn) / denom : NaN;

  return {
    total, accuracy, sensitivity, specificity, precision, npv,
    f1, balancedAcc, fpr, fnr, youdenJ, mcc,
  };
}

/**
 * 扫描"从哪一级起算疲劳"这个映射阈值，给出三种取法的对比。
 * 用于回答：把轻度也算作疲劳更合适，还是只把中度以上算作疲劳更合适。
 */
export function sweepPositiveThreshold(pairs) {
  return ['mild', 'moderate', 'severe'].map((k) => {
    const r = computeMetrics(pairs, k);
    return {
      positiveFrom: k,
      label: { mild: '轻度及以上', moderate: '中度及以上', severe: '仅重度' }[k],
      ...r.byTime,
      matrix: r.matrixTimeMs,
    };
  });
}

/**
 * ROC 与 PR 曲线：以连续疲劳指数为判别分数扫描阈值。
 *
 * 【为什么还要 ROC/PR】computeMetrics 只评估系统当前的工作点
 * （实际的等级分界），ROC/PR 回答的是另一个问题：分数本身有多大
 * 判别力、工作点选得合不合理。AUC 可与文献中的其他方法直接对比，
 * 是"检测有效性"最标准的报告方式。
 *
 * 口径：按采样点计数，与混淆矩阵图的"按采样点计数"列一致。
 *
 * @param {{truth:string, score:number}[]} points 逐采样点（ignore/未标注自动剔除）
 * @param {object} [opts]
 * @param {number} [opts.step=1] 阈值步长（分）；1 分步长 → 101 个工作点
 */
export function computeRocPr(points, opts = {}) {
  const step = opts.step ?? 1;
  const valid = points.filter((p) => p.truth === 'normal' || p.truth === 'fatigue');
  const P = valid.filter((p) => p.truth === 'fatigue').length;
  const N = valid.length - P;

  if (P === 0 || N === 0) {
    return { roc: [], pr: [], auc: NaN, ap: NaN, positives: P, negatives: N, usable: false };
  }

  const roc = [];
  const pr = [];
  for (let th = 100; th >= 0; th -= step) {
    let tp = 0;
    let fp = 0;
    for (const p of valid) {
      if (p.score >= th) {
        if (p.truth === 'fatigue') tp++;
        else fp++;
      }
    }
    const tpr = tp / P;
    const fpr = fp / N;
    // 预测正例数为 0 时查准率按惯例记 1（PR 曲线左端点）
    const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
    roc.push({ threshold: th, tpr, fpr });
    pr.push({ threshold: th, tpr, precision });
  }

  // AUC：ROC 按 FPR 升序做梯形积分
  roc.sort((a, b) => a.fpr - b.fpr || a.tpr - b.tpr);
  let auc = 0;
  for (let i = 1; i < roc.length; i++) {
    auc += ((roc[i].fpr - roc[i - 1].fpr) * (roc[i].tpr + roc[i - 1].tpr)) / 2;
  }

  // AP（平均精度）：按召回增量加权查准率（阶跃式，信息检索标准口径）
  pr.sort((a, b) => a.tpr - b.tpr);
  let ap = 0;
  for (let i = 1; i < pr.length; i++) {
    ap += (pr[i].tpr - pr[i - 1].tpr) * pr[i].precision;
  }

  return { roc, pr, auc, ap, positives: P, negatives: N, usable: true };
}

/**
 * 基线对照：单一 PERCLOS 阈值判疲劳（文献经典方法）。
 *
 * 【为什么必须做】"七特征融合"的价值需要参照物来证明。PERCLOS
 * 阈值法是疲劳检测文献最常用的单一特征基线（阈值多取 0.08–0.15）。
 * 同一份标注数据上同时跑基线与融合系统，指标差值即融合的净贡献，
 * 直接回应"为什么不用简单阈值就够"。
 *
 * @param {{truth:string, perclos:number, perclosReady?:number}[]} points
 * @param {number[]} [thresholds] 待扫描的 PERCLOS 阈值（0–1 闭眼时间占比）
 */
export function computeBaseline(points, thresholds = [0.05, 0.08, 0.10, 0.12, 0.15]) {
  return thresholds.map((t) => {
    const pairs = points.map((p) => ({
      truth: p.truth,
      // PERCLOS 未就绪（窗口仍在累积）时按清醒处理，与融合系统同口径
      pred: p.perclosReady === 0 ? 'awake' : p.perclos >= t ? 'mild' : 'awake',
      // 基线对照只看按采样点计数口径，权重取 1 仅为满足 computeMetrics 的入参约定
      weightMs: 1,
    }));
    const r = computeMetrics(pairs, 'mild');
    return { threshold: t, byCount: r.byCount, matrix: r.matrix };
  });
}

/**
 * 评估响应延迟：人工标注的疲劳区间开始后，系统需要多久才判为疲劳。
 *
 * 这个指标对疲劳检测特别重要——一个准确但滞后 60 秒的系统，
 * 在实际驾驶中可能已经来不及预警。PERCLOS 的滑动窗口本身会带来
 * 固有延迟，因此需要如实测量并在论文中报告。
 *
 * @param {{tSec:number, truth:string, pred:string}[]} series 按时间升序
 * @param {string} positiveFrom
 */
export function computeLatency(series, positiveFrom = 'mild') {
  const posLevels = POSITIVE_FROM[positiveFrom] || POSITIVE_FROM.mild;
  const isPos = (l) => posLevels.includes(l);
  const events = [];

  let i = 0;
  while (i < series.length) {
    // 找到人工标注由非疲劳转入疲劳的时刻
    if (series[i].truth === 'fatigue' && (i === 0 || series[i - 1].truth !== 'fatigue')) {
      const onsetT = series[i].tSec;
      // 该疲劳区间的结束位置
      let j = i;
      while (j < series.length && series[j].truth === 'fatigue') j++;
      const endT = series[j - 1].tSec;
      // 在区间内寻找系统首次判为疲劳的时刻
      let detectT = null;
      for (let k = i; k < j; k++) {
        if (isPos(series[k].pred)) {
          detectT = series[k].tSec;
          break;
        }
      }
      events.push({
        onsetSec: onsetT,
        intervalEndSec: endT,
        intervalLenSec: endT - onsetT,
        detectedSec: detectT,
        latencySec: detectT === null ? null : detectT - onsetT,
        missed: detectT === null,
      });
      i = j;
    } else {
      i++;
    }
  }

  const latencies = events.filter((e) => e.latencySec !== null).map((e) => e.latencySec);
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    events,
    detectedCount: latencies.length,
    missedCount: events.filter((e) => e.missed).length,
    meanLatencySec: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : NaN,
    medianLatencySec: sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN,
    maxLatencySec: sorted.length ? sorted[sorted.length - 1] : NaN,
  };
}

/** 格式化为百分比字符串 */
export const pct = (v, d = 1) => (Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '--');
/** 格式化为定点小数 */
export const num = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '--');

/**
 * 生成一段自然语言结论，供论文与答辩直接引用。
 * 刻意强调灵敏度与漏报，因为这是安全相关系统的核心关切。
 */
export function summarize(metrics, latency) {
  const t = metrics.byTime;
  const lines = [];
  const evaluatedSec = (metrics.matrixTimeMs.tp + metrics.matrixTimeMs.fp + metrics.matrixTimeMs.tn + metrics.matrixTimeMs.fn) / 1000;

  lines.push(
    `共评估 ${evaluatedSec.toFixed(1)} 秒有效标注数据（${metrics.counts.evaluated} 个采样点）。` +
      `按时间加权计算：准确率 ${pct(t.accuracy)}，灵敏度 ${pct(t.sensitivity)}，特异度 ${pct(t.specificity)}。`
  );
  lines.push(
    `平衡准确率 ${pct(t.balancedAcc)}，Youden's J = ${num(t.youdenJ)}，MCC = ${num(t.mcc)}。` +
      `后两项对类别不平衡不敏感，比单纯的准确率更能反映真实判别能力。`
  );

  if (Number.isFinite(t.fnr)) {
    lines.push(
      `漏报率 ${pct(t.fnr)}、误报率 ${pct(t.fpr)}。` +
        (t.fnr > t.fpr
          ? '漏报高于误报，对安全相关系统而言更需要关注，可考虑下调等级分界或提高眼部指标权重。'
          : '误报高于漏报，说明系统偏保守；在疲劳检测场景中这一取向可以接受，但过高会导致使用者忽略报警。')
    );
  }

  if (latency && latency.detectedCount) {
    lines.push(
      `在 ${latency.events.length} 个人工标注的疲劳区间中，系统检出 ${latency.detectedCount} 个、漏检 ${latency.missedCount} 个；` +
        `平均响应延迟 ${latency.meanLatencySec.toFixed(1)} 秒，中位数 ${latency.medianLatencySec.toFixed(1)} 秒，最大 ${latency.maxLatencySec.toFixed(1)} 秒。` +
        `延迟主要来自 PERCLOS 的滑动窗口累积，属方法固有特性。`
    );
  }

  lines.push(
    '说明：标签由被试本人主观自评给出（等价于 KSS 嗜睡量表的简化二分），' +
      '样本量与被试数量有限，结论不能外推为普适准确率，仅用于验证本系统在受控条件下的可用性。'
  );
  return lines;
}
