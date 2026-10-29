/**
 * analysis.js — 离线重算与参数敏感性分析
 *
 * 把已记录的会话指标序列在多组参数下离线重算，输出每组参数下的等级分布、
 * 平均/峰值分数与报警次数。由此可以画出"参数—结论"曲线，直接看出：
 *   · 欠敏感区（几乎检不出）
 *   · 稳定平台区（结论对参数不敏感 → 默认值应落在这里）
 *   · 过敏感区（几乎全部误判为疲劳）
 *
 * 融合层是纯函数：给定指标快照与参数，输出确定的分数与等级。
 * 因此只要保存了指标时序，就能不重新采集视频而复现整条判定链路。
 */

import { CONFIG, PERCLOS_MU_LO, PERCLOS_MU_HI } from '../config.js';
import { FusionEngine, INDICATOR_META, advanceTrend, assessUnreliable } from './fusion.js';
import { clamp } from '../util/math.js';
import { SAMPLE_COLUMNS, findColumn, parseLevelCell } from './csv-schema.js';

/**
 * 可做敏感性分析的参数定义。
 * type 区分两类：
 *   plateau（平台型）——扫描曲线呈「欠敏感→稳定平台→过敏感」三段形态
 *   monotonic（单调型）——参数越大判定越保守，疲劳占比单调下降
 */
export const SENSITIVITY_PARAMS = {
  perclosLower: {
    label: 'PERCLOS 隶属下限',
    unit: '',
    type: 'plateau',
    desc: '低于该值的 PERCLOS 不产生疲劳贡献。越低越灵敏，过低会把正常眨眼本身的时间开销当作疲劳。',
    current: () => PERCLOS_MU_LO,
    candidates: [0.02, 0.04, 0.06, 0.08, 0.10, 0.13, 0.16, 0.20],
    apply: (v, patch) => (patch.perclosLower = v),
  },
  criticalClosureMs: {
    label: '危险闭眼时长',
    unit: 'ms',
    type: 'plateau',
    desc: '持续闭眼达到该时长立即判为重度并触发最高级报警。越短越安全，但会把长眨眼误判为微睡眠。',
    current: () => CONFIG.event.criticalClosureMs,
    candidates: [1000, 1200, 1500, 1800, 2200, 2600, 3000],
    apply: (v, patch) => (patch.criticalClosureMs = v),
  },
  emaAlpha: {
    label: 'EMA 平滑系数',
    unit: '',
    type: 'plateau',
    desc: '越小越平滑但响应越迟钝，越大越灵敏但分数抖动越明显。',
    current: () => CONFIG.fusion.emaAlpha,
    candidates: [0.04, 0.08, 0.12, 0.18, 0.25, 0.35, 0.5],
    apply: (v, patch) => (patch.emaAlpha = v),
  },
  mildThreshold: {
    label: '轻度疲劳分界',
    unit: '分',
    type: 'monotonic',
    desc: '疲劳指数达到该值判为轻度。这是灵敏度与误报率的权衡：阈值越低预警越早，虚警也越多。',
    current: () => CONFIG.fusion.levels[1].min,
    candidates: [20, 24, 28, 30, 34, 38, 44],
    apply: (v, patch) => (patch.mildThreshold = v),
  },
  severeThreshold: {
    label: '重度疲劳分界',
    unit: '分',
    type: 'monotonic',
    desc: '疲劳指数达到该值判为重度并触发最高级报警。决定最严厉警报的触发门槛。',
    current: () => CONFIG.fusion.levels[3].min,
    candidates: [62, 68, 74, 80, 86, 92],
    apply: (v, patch) => (patch.severeThreshold = v),
  },
};

/**
 * 用一组参数对样本序列做离线重算。
 * @param samples recorder.samples（指标时序）
 * @param patch  参数覆盖
 * @returns 该参数下的会话统计
 */
export function replaySession(samples, patch = {}) {
  if (!samples || samples.length < 2) {
    return { valid: false, reason: '样本不足，至少需要 2 个采样点' };
  }

  const weights = patch.weights || CONFIG.fusion.weights;
  const alpha = patch.emaAlpha ?? CONFIG.fusion.emaAlpha;
  const perclosLower = patch.perclosLower ?? PERCLOS_MU_LO;
  const critMs = patch.criticalClosureMs ?? CONFIG.event.criticalClosureMs;
  const mildMin = patch.mildThreshold ?? CONFIG.fusion.levels[1].min;
  const modMin = patch.moderateThreshold ?? CONFIG.fusion.levels[2].min;
  const sevMin = patch.severeThreshold ?? CONFIG.fusion.levels[3].min;

  const levels = [
    { key: 'awake', min: 0 },
    { key: 'mild', min: mildMin },
    { key: 'moderate', min: modMin },
    { key: 'severe', min: sevMin },
  ];
  const toLevel = (score) => {
    for (let i = levels.length - 1; i >= 0; i--) if (score >= levels[i].min) return levels[i].key;
    return 'awake';
  };

  let ema = 0;
  let trendEma = 0;
  let prevRaw = 0;
  let peak = 0;
  let sum = 0;
  let count = 0;
  let alarms = 0;
  let overrideMs = 0;
  let unreliableMs = 0;
  let lastAlarmLevel = 'awake';
  const durations = { awake: 0, mild: 0, moderate: 0, severe: 0 };
  let prevT = samples[0].t;
  let worst = 'awake';
  const ORDER = { awake: 0, mild: 1, moderate: 2, severe: 3 };
  const curve = [];
  // CSV 行只有 0/1 标志，可靠性门控需要的"连续丢失时长"从相邻行时间戳重建
  let faceLostStreakMs = 0;
  let qualityBadStreakMs = 0;
  let lostAccumMs = 0;
  const t0 = samples[0].t;

  for (const s of samples) {
    const dt = clamp(s.t - prevT, 0, 5000);
    if (s.facePresent === 0) {
      faceLostStreakMs += dt;
      lostAccumMs += dt;
      qualityBadStreakMs = 0;
    } else if (s.dataValid === 0) {
      qualityBadStreakMs += dt;
      faceLostStreakMs = 0;
    } else {
      faceLostStreakMs = 0;
      qualityBadStreakMs = 0;
    }

    // 用样本重建融合层需要的指标快照
    const ind = {
      ts: s.t,
      perclos: s.perclos ?? 0,
      perclosReady: s.perclosReady !== false,
      maxClosureMs: s.maxClosureMs ?? 0,
      currentClosureMs: s.currentClosureMs ?? 0,
      blinkRate: s.blinkRate ?? 0,
      avgBlinkMs: s.avgBlinkMs,
      yawnRate: s.yawnRate ?? 0,
      nodRate: s.nodRate ?? 0,
      headDevRatio: s.headDevRatio ?? 0,
      observedMs: s.t,
      facePresent: s.facePresent !== 0,
      dataValid: s.dataValid !== 0,
      faceLostMs: faceLostStreakMs,
      qualityBadMs: qualityBadStreakMs,
      faceLostRatio: s.t > t0 ? lostAccumMs / (s.t - t0) : 0,
    };

    // 隶属度（PERCLOS 下限走参数覆盖）
    const mu = FusionEngine.memberships(ind, null);
    if (ind.perclosReady) {
      const hi = PERCLOS_MU_HI;
      mu.perclos = hi > perclosLower ? clamp((ind.perclos - perclosLower) / (hi - perclosLower), 0, 1) : 0;
    } else {
      mu.perclos = 0;
    }

    // 加权综合：消融采用"扣除贡献"语义（分母保持完整权重和，只从分子中去掉被消融指标）
    let wsum = 0;
    let acc = 0;
    for (const k of Object.keys(weights)) {
      const wi = Number(weights[k]) || 0;
      wsum += wi;
      if (patch.ablateKey === k) continue;
      acc += wi * (Number.isFinite(mu[k]) ? mu[k] : 0);
    }
    const raw = wsum > 0 ? (acc / wsum) * 100 : 0;

    ema = ema + alpha * (raw - ema);
    let score = ema;

    // 趋势加速器（与在线 FusionEngine 共享同一实现 advanceTrend）
    const trend = advanceTrend(trendEma, raw, prevRaw);
    trendEma = trend.trendEma;
    prevRaw = raw;
    score += trend.boost;

    // 安全兜底 override：判据用 currentClosureMs（此刻正在闭眼），不用 maxClosureMs
    const cur = s.currentClosureMs ?? 0;
    if (cur >= critMs) {
      score = Math.max(score, 92);
      if (ema < 68) ema = 68;
    } else if (cur >= critMs * 0.6) {
      score = Math.max(score, 68);
      if (ema < 50) ema = 50;
    }
    score = clamp(score, 0, 100);

    const level = toLevel(score);
    prevT = s.t;
    curve.push({ t: s.t, v: Number(score.toFixed(2)) });

    // 不可靠样本剔除（与在线融合层同口径）
    const rel = assessUnreliable(ind);
    if (rel.unreliable) {
      unreliableMs += dt;
      continue;
    }

    if (cur >= critMs * 0.6) overrideMs += dt;
    durations[level] += dt;
    if (ORDER[level] > ORDER[worst]) worst = level;
    if (level !== 'awake' && ORDER[level] > ORDER[lastAlarmLevel]) alarms++;
    lastAlarmLevel = level;

    if (score > peak) peak = score;
    sum += score;
    count++;
  }

  const total = Object.values(durations).reduce((a, b) => a + b, 0) || 1;
  return {
    valid: true,
    sampleCount: count,
    avgScore: count ? sum / count : 0,
    peakScore: peak,
    worstLevel: worst,
    alarms,
    durations,
    ratios: Object.fromEntries(Object.entries(durations).map(([k, v]) => [k, v / total])),
    overrideRatio: overrideMs / total,
    unreliableMs,
    curve,
  };
}

/** 对单个参数做扫描，得到"参数—结论"表 */
export function runSensitivity(samples, paramKey) {
  const spec = SENSITIVITY_PARAMS[paramKey];
  if (!spec) return { error: '未知参数：' + paramKey };
  if (!samples || samples.length < 2) return { error: '样本不足，请先完成一次检测（至少数秒）' };

  const current = spec.current();
  const candidates = [...new Set([...spec.candidates, current])].sort((a, b) => a - b);

  const rows = candidates.map((v) => {
    const patch = {};
    spec.apply(v, patch);
    const r = replaySession(samples, patch);
    return {
      value: v,
      isCurrent: Math.abs(v - current) < 1e-9,
      avgScore: r.valid ? r.avgScore : NaN,
      peakScore: r.valid ? r.peakScore : NaN,
      worstLevel: r.valid ? r.worstLevel : '--',
      alarms: r.valid ? r.alarms : 0,
      ratios: r.valid ? r.ratios : { awake: 0, mild: 0, moderate: 0, severe: 0 },
      fatigueRatio: r.valid ? 1 - r.ratios.awake : 0,
      overrideRatio: r.valid ? r.overrideRatio : 0,
    };
  });

  return {
    param: paramKey,
    label: spec.label,
    unit: spec.unit,
    desc: spec.desc,
    type: spec.type || 'plateau',
    current,
    rows,
    plateau: (spec.type || 'plateau') === 'plateau' ? findPlateau(rows) : null,
    slope: computeSlope(rows),
  };
}

/** 疲劳占比对参数的平均斜率 */
function computeSlope(rows) {
  if (rows.length < 2) return 0;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const dv = last.value - first.value;
  if (Math.abs(dv) < 1e-9) return 0;
  return ((last.fatigueRatio - first.fatigueRatio) * 100) / dv;
}

/** 找出"结论对参数不敏感"的稳定区间 */
function findPlateau(rows) {
  const segs = [];
  let start = 0;
  for (let i = 1; i < rows.length; i++) {
    const d = Math.abs(rows[i].fatigueRatio - rows[i - 1].fatigueRatio);
    if (d > 0.04) {
      if (i - start >= 2) segs.push([start, i - 1]);
      start = i;
    }
  }
  if (rows.length - start >= 2) segs.push([start, rows.length - 1]);
  if (!segs.length) return null;
  const best = segs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
  return { from: rows[best[0]].value, to: rows[best[1]].value, count: best[1] - best[0] + 1 };
}

/** 权重消融实验：逐项扣除权重，观察结论变化 */
export function runAblation(samples) {
  if (!samples || samples.length < 2) return { error: '样本不足，请先完成一次检测' };
  const base = replaySession(samples, {});
  const rows = [];
  for (const key of Object.keys(CONFIG.fusion.weights)) {
    const r = replaySession(samples, { ablateKey: key });
    rows.push({
      key,
      label: INDICATOR_META[key] ? INDICATOR_META[key].label : key,
      weight: CONFIG.fusion.weights[key],
      avgScore: r.avgScore,
      peakScore: r.peakScore,
      worstLevel: r.worstLevel,
      alarms: r.alarms,
      deltaAvg: r.avgScore - base.avgScore,
      deltaPeak: r.peakScore - base.peakScore,
      fatigueRatio: 1 - r.ratios.awake,
      deltaFatigueRatio: (1 - r.ratios.awake) - (1 - base.ratios.awake),
    });
  }
  rows.sort((a, b) => a.deltaAvg - b.deltaAvg);
  return { base, rows };
}

/** 解析本系统导出的 CSV，还原为 samples */
export function parseSessionCsv(text) {
  if (!text) return { error: 'CSV 内容为空' };
  const clean = text.replace(/^\ufeff/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return { error: 'CSV 至少需要表头与一行数据' };

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const col = (key) => {
    const spec = SAMPLE_COLUMNS.find((c) => c.key === key);
    return spec ? findColumn(header, spec) : -1;
  };
  const iT = col('t');
  if (iT < 0) {
    return { error: '找不到时间列（时间(毫秒) / t_ms），这个文件可能不是本系统导出的会话数据' };
  }

  const num = (arr, i) => {
    if (i < 0 || i >= arr.length) return null;
    const raw = String(arr[i]).replace(/^'/, '').trim();
    if (raw === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };

  const map = {
    t: iT, score: col('score'), raw: col('raw'), perclos: col('perclos'),
    perclosReady: col('perclosReady'), closure: col('closure'),
    maxClosureMs: col('maxClosureMs'), currentClosureMs: col('currentClosureMs'),
    blinkRate: col('blinkRate'), avgBlinkMs: col('avgBlinkMs'),
    yawnRate: col('yawnRate'), nodRate: col('nodRate'),
    headDevRatio: col('headDevRatio'), ear: col('ear'), mar: col('mar'),
    pitch: col('pitch'), yaw: col('yaw'), roll: col('roll'),
    facePresent: col('facePresent'), dataValid: col('dataValid'),
  };
  const iLevel = col('level');

  const samples = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const t = num(cells, map.t);
    if (t === null) {
      skipped++;
      continue;
    }
    samples.push({
      t,
      score: num(cells, map.score) ?? 0,
      raw: num(cells, map.raw) ?? 0,
      level: iLevel >= 0 ? parseLevelCell(cells[iLevel]) : 'awake',
      perclos: num(cells, map.perclos) ?? 0,
      perclosReady: map.perclosReady >= 0 ? num(cells, map.perclosReady) !== 0 : true,
      closure: num(cells, map.closure) ?? 0,
      maxClosureMs: num(cells, map.maxClosureMs) ?? 0,
      currentClosureMs: num(cells, map.currentClosureMs) ?? 0,
      blinkRate: num(cells, map.blinkRate) ?? 0,
      avgBlinkMs: num(cells, map.avgBlinkMs),
      yawnRate: num(cells, map.yawnRate) ?? 0,
      nodRate: num(cells, map.nodRate) ?? 0,
      headDevRatio: num(cells, map.headDevRatio) ?? 0,
      ear: num(cells, map.ear),
      mar: num(cells, map.mar),
      pitch: num(cells, map.pitch),
      yaw: num(cells, map.yaw),
      roll: num(cells, map.roll),
      facePresent: num(cells, map.facePresent) ?? 1,
      dataValid: num(cells, map.dataValid) ?? 1,
    });
  }
  if (!samples.length) return { error: '未解析到有效数据行' };
  return { samples, skipped, columns: header.length };
}

/** 最小 CSV 行解析：支持引号包裹与双写引号转义 */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuote = false;
      } else cur += c;
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}
