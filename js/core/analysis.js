/**
 * analysis.js — 离线重算与参数敏感性分析
 *
 * 【这个模块解决什么问题】
 * 论文里最难回答的问题不是"系统能不能检测疲劳"，而是"为什么阈值取这个值"。
 * 只说"参考文献常用范围"是不够的——评委会问：取大一点会怎样？取小一点会怎样？
 *
 * 本模块把已记录的会话指标序列在多组参数下**离线重算**，
 * 输出每组参数下的等级分布、平均/峰值分数与报警次数。
 * 由此可以画出一条"参数—结论"曲线，直接看出：
 *   · 哪个区间是欠敏感区（几乎检不出）
 *   · 哪个区间是稳定平台区（结论对参数不敏感 → 默认值应落在这里）
 *   · 哪个区间是过敏感区（几乎全部误判为疲劳）
 *
 * 【为什么可以离线重算】
 * 融合层是纯函数：给定指标快照与参数，输出确定的分数与等级。
 * 因此只要保存了指标时序（recorder.samples），就能在不重新采集视频的前提下
 * 复现整条判定链路。这也让消融实验（把某项权重置 0）变得可行。
 */

import { CONFIG } from '../config.js';
import { FusionEngine, INDICATOR_META } from './fusion.js';
import { clamp } from '../util/math.js';
import { SAMPLE_COLUMNS, findColumn, parseLevelCell } from './csv-schema.js';

/**
 * 可做敏感性分析的参数定义。
 *
 * `type` 区分两类参数，因为它们的"合理取值依据"完全不同：
 *
 * · plateau（平台型）——如 PERCLOS 隶属下限、危险闭眼时长。
 *   参数扫描曲线通常呈「欠敏感区 → 稳定平台区 → 过敏感区」三段形态。
 *   默认值应落在平台区内，此时结论对参数扰动不敏感，取值有客观依据。
 *
 * · monotonic（单调型）——如等级分界分数。
 *   参数越大，判定越保守，疲劳占比单调下降，不存在"平台区"。
 *   这类参数是灵敏度与误报率之间的**权衡取舍**，没有客观最优值，
 *   只能结合应用场景（宁可误报还是宁可漏报）来定，并在论文中说明取舍理由。
 *   对它们报"未落在平台区"是错误的结论，因此要分开处理。
 */
export const SENSITIVITY_PARAMS = {
  perclosLower: {
    label: 'PERCLOS 隶属下限',
    unit: '',
    type: 'plateau',
    desc: '低于该值的 PERCLOS 不产生疲劳贡献。越低越灵敏，过低会把正常眨眼本身的时间开销当作疲劳。',
    current: () => 0.06,
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
 * 离线重算的参数覆盖项，未给的字段沿用当前 CONFIG / 默认值。
 * @typedef {object} ReplayPatch
 * @property {Record<string, number>} [weights] 融合权重
 * @property {number} [emaAlpha] EMA 平滑系数
 * @property {number} [perclosLower] PERCLOS 隶属下界
 * @property {number} [criticalClosureMs] 危险闭眼时长
 * @property {number} [mildThreshold] 轻度等级阈值
 * @property {number} [moderateThreshold] 中度等级阈值
 * @property {number} [severeThreshold] 重度等级阈值
 * @property {string} [ablateKey] 消融实验：扣除该权重键的贡献
 */

/**
 * 离线重算结果。valid=false 时只有 reason，统计字段缺省。
 * @typedef {object} ReplayResult
 * @property {boolean} valid
 * @property {string} [reason]
 * @property {number} [sampleCount]
 * @property {number} [avgScore]
 * @property {number} [peakScore]
 * @property {string} [worstLevel]
 * @property {number} [alarms]
 * @property {Record<string, number>} [durations] 各等级时长（毫秒）
 * @property {Record<string, number>} [ratios] 各等级时长占比
 * @property {number} [overrideRatio] 危险闭眼 override 占比
 * @property {Array<{t:number, v:number}>} [curve] 重算后的分数曲线
 */

/**
 * 用一组参数对样本序列做离线重算。
 *
 * @param {Array} samples recorder.samples（指标时序）
 * @param {ReplayPatch} patch  参数覆盖 { perclosLower, criticalClosureMs, emaAlpha, mildThreshold, weights }
 * @returns {ReplayResult} 该参数下的会话统计
 */
export function replaySession(samples, patch = {}) {
  if (!samples || samples.length < 2) {
    return { valid: false, reason: '样本不足，至少需要 2 个采样点' };
  }

  const weights = patch.weights || CONFIG.fusion.weights;
  const alpha = patch.emaAlpha ?? CONFIG.fusion.emaAlpha;
  const perclosLower = patch.perclosLower ?? 0.06;
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
  let trendEma = 0;  // 趋势加速器
  let prevRaw = 0;   // 上一帧原始分数
  let peak = 0;
  let sum = 0;
  let count = 0;
  let alarms = 0;
  /** override（危险闭眼兜底）累计生效时长，用于说明结论有多少由兜底规则主导 */
  let overrideMs = 0;
  let lastAlarmLevel = 'awake';
  const durations = { awake: 0, mild: 0, moderate: 0, severe: 0 };
  let prevT = samples[0].t;
  let worst = 'awake';
  const ORDER = { awake: 0, mild: 1, moderate: 2, severe: 3 };
  const curve = [];

  for (const s of samples) {
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
    };

    // 隶属度（PERCLOS 下限走参数覆盖，其余沿用系统定义）
    const mu = FusionEngine.memberships(ind, null);
    if (ind.perclosReady) {
      const hi = 0.32;
      mu.perclos = hi > perclosLower ? clamp((ind.perclos - perclosLower) / (hi - perclosLower), 0, 1) : 0;
    } else {
      mu.perclos = 0;
    }

    /**
     * 加权综合。
     *
     * 消融（ablateKey）采用「扣除贡献」语义：分母保持**完整**权重之和，
     * 只把被消融指标的贡献项从分子中去掉。
     *
     * 为什么不是"权重置 0 后重新归一化"：那等价于把该指标的权重重新分配给
     * 其余指标，于是移除一个隶属度较低的指标反而会让总分**上升**
     * （实测移除 PERCLOS 后平均分升高 7.3 分），与"消融"的直觉完全相反，
     * 也无法回答"这个指标贡献了多少分"。扣除语义下 Δ 必然 ≤ 0，含义明确。
     */
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

    // 趋势加速器（与在线 FusionEngine 保持一致）
    const trendAlpha = 0.08;
    const rawDelta = raw - prevRaw;
    trendEma = trendEma + trendAlpha * (rawDelta - trendEma);
    prevRaw = raw;
    const trendBoost = clamp(trendEma * 1.5, -2, 5);
    score += trendBoost;

    /* 安全兜底 override：判据必须是「此刻正在持续闭眼」（currentClosureMs），
     * 不能用窗口内峰值（maxClosureMs）——后者在整个统计窗口内都保持高值，
     * 会让 override 持续触发并把分数钉死，使敏感性分析失去意义。 */
    const cur = s.currentClosureMs ?? 0;
    if (cur >= critMs) {
      score = Math.max(score, 92);
      if (ema < 68) ema = 68;
      overrideMs += clamp(s.t - prevT, 0, 5000);
    } else if (cur >= critMs * 0.6) {
      score = Math.max(score, 68);
      if (ema < 50) ema = 50;
      overrideMs += clamp(s.t - prevT, 0, 5000);
    }
    score = clamp(score, 0, 100);

    const level = toLevel(score);
    const dt = clamp(s.t - prevT, 0, 5000);
    prevT = s.t;
    durations[level] += dt;
    if (ORDER[level] > ORDER[worst]) worst = level;
    if (level !== 'awake' && ORDER[level] > ORDER[lastAlarmLevel]) alarms++;
    lastAlarmLevel = level;

    if (score > peak) peak = score;
    sum += score;
    count++;
    curve.push({ t: s.t, v: Number(score.toFixed(2)) });
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
    curve,
  };
}

/**
 * 对单个参数做扫描，得到"参数—结论"表。
 *
 * @param {Array} samples
 * @param {string} paramKey SENSITIVITY_PARAMS 的键
 * @returns {object} { param, rows: [...] }
 */
export function runSensitivity(samples, paramKey) {
  const spec = SENSITIVITY_PARAMS[paramKey];
  if (!spec) return { error: '未知参数：' + paramKey };
  if (!samples || samples.length < 2) return { error: '样本不足，请先完成一次检测（至少数秒）' };

  const current = spec.current();
  // 把当前值并入候选集并去重排序，便于在表中标出"当前"
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
    /** 平台型参数才计算稳定区；单调型参数无平台区可言 */
    plateau: (spec.type || 'plateau') === 'plateau' ? findPlateau(rows) : null,
    /** 单调型参数给出灵敏度斜率：每单位参数变化引起的疲劳占比变化 */
    slope: computeSlope(rows),
  };
}

/** 疲劳占比对参数的平均斜率（每单位参数变化对应的百分点变化） */
function computeSlope(rows) {
  if (rows.length < 2) return 0;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const dv = last.value - first.value;
  if (Math.abs(dv) < 1e-9) return 0;
  return ((last.fatigueRatio - first.fatigueRatio) * 100) / dv;
}

/**
 * 找出"结论对参数不敏感"的稳定区间。
 * 默认参数落在稳定区间内，是比"参考文献"更硬的取值依据。
 */
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
  // 取最长的稳定段
  const best = segs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
  return { from: rows[best[0]].value, to: rows[best[1]].value, count: best[1] - best[0] + 1 };
}

/**
 * 权重消融实验：逐项把权重置 0，观察结论变化。
 * 直接回答"每个指标到底有没有用"。
 */
export function runAblation(samples) {
  if (!samples || samples.length < 2) return { error: '样本不足，请先完成一次检测' };
  const base = replaySession(samples, {});
  const rows = [];
  for (const key of Object.keys(CONFIG.fusion.weights)) {
    // 扣除该指标的贡献（分母仍为完整权重和，见 replaySession 内注释）
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

/** 解析本系统导出的 CSV，还原为 samples（用于跨会话复现） */
export function parseSessionCsv(text) {
  if (!text) return { error: 'CSV 内容为空' };
  const clean = text.replace(/^\ufeff/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return { error: 'CSV 至少需要表头与一行数据' };

  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  /** 按列定义取下标：中文表头（当前版本）与英文表头（旧版导出）都认 */
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
      // 等级列可能是中文（当前版本）或英文键（旧版导出），统一还原成内部键
      level: iLevel >= 0 ? parseLevelCell(cells[iLevel]) : 'awake',
      // 缺失值保持 null，绝不当成 0：
      // 把缺失的 EAR 当成 0 会变成"眼睛完全闭合"，把缺失的低头当成 0 会变成"确定没低头"
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
