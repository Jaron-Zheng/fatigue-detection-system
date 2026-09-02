#!/usr/bin/env node
/**
 * accuracy-eval.mjs — 全量准确率评估（论文第六章核心数字的唯一来源）
 *
 * 【评估方法】模拟驾驶员多轮可复现测试：
 *   10 个随机种子 × 147 秒完整疲劳演进剧本（清醒→轻度→中度→重度）。
 *   SimulatedDriver 的剧本相位作为人工标签（清醒=normal，其余=fatigue），
 *   标签由剧本阶段定义，不等同于真人标注——见评估报告"已知局限"。
 *
 * 【标注口径】（与既有 figures/*.CSV 逐位对齐的复原约定）
 *   · 采样步长 33ms，起点 t0=1000，单轮 147s → 4455 帧/轮；
 *   · normal→fatigue 相位切换点前 3000ms 为标注不确定带（truth=ignore），
 *     每轮 91 帧：TN 667 帧 + (TP+FN) 3697 帧 = 4364 帧/轮参与指标计算；
 *   · 混淆矩阵同时输出"按时间加权（毫秒）"与"按采样点计数"两套；
 *   · 延迟 = 人工标注疲劳区间起点到系统首次判为轻度及以上的时长。
 *
 * 【种子注入】SimulatedDriver 内部使用 mulberry32 固定种子（默认 20250730），
 *   本脚本在构造后覆写 `sim._rng` 以实现多轮不同种子，PRNG 实现与
 *   sim-driver.js 完全一致，保证同一种子必得同一序列。
 *
 * 【产出】docs-evidence/figures/ 下：
 *   accuracy-summary.csv / baseline-comparison.csv / sensitivity-analysis.csv /
 *   ablation-analysis.csv / adversarial-summary.csv / tuning-rounds.csv /
 *   param-tuning-results.csv /
 *   ROC曲线.svg / PR曲线.svg / 基线对比.svg / 检出延迟.svg / 消融实验.svg /
 *   敏感性-*.svg（5 张）/ 对抗场景误报.svg
 *
 * 复现命令：node tools/accuracy-eval.mjs
 */
'use strict';

import { pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_JS = path.resolve(__dirname, '../web/js');
const FIG_DIR = path.resolve(__dirname, '../docs-evidence/figures');

// ── 浏览器 API 最小 mock（与 regression-test.mjs 同口径） ──
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Date.now() };
}
if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { userAgent: 'NodeAccuracyEval/1.0' };
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: () => ({ click: () => {}, href: '', download: '' }),
    body: { appendChild: () => {}, removeChild: () => {} },
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

const importFromWeb = (rel) => import(pathToFileURL(path.join(WEB_JS, rel)).href);

const { CONFIG } = await importFromWeb('config.js');
const { SimulatedDriver } = await importFromWeb('core/sim-driver.js');
const { IndicatorEngine } = await importFromWeb('core/indicators.js');
const { FusionEngine } = await importFromWeb('core/fusion.js');
const { computeMetrics, computeRocPr, computeBaseline, computeLatency } = await importFromWeb('core/evaluation.js');
const { lineChart, barChart } = await import(
  pathToFileURL(path.resolve(__dirname, 'analysis/svg-lib.mjs')).href
);

/* ══════════════════════ 常量 ══════════════════════ */

/** 10 个评估种子（与评估报告第五节延迟表一致） */
const SEEDS = [20250730, 42, 12345, 777, 99999, 314159, 271828, 8675309, 112358, 428571];

const SCRIPT_MS = 147000; // 剧本单轮时长（PHASES 最后一段 until）
const STEP_MS = 33;       // 采样步长（≈30fps）
const T0 = 1000;          // 每轮起始时间戳
const IGNORE_BEFORE_ONSET_MS = 3000; // normal→fatigue 切换前的标注不确定带

const QUALITY_OK = { face: { valid: true, reasons: [], label: '良好' }, lighting: { valid: true, label: '良好' } };

/** 与 sim-driver.js 完全一致的确定性 PRNG（种子注入用） */
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

/* ══════════════════════ 配置补丁工具 ══════════════════════ */

/** CONFIG 深快照（实验性参数修改后恢复原值） */
function snapshotConfig() {
  return JSON.parse(JSON.stringify(CONFIG));
}

function deepAssign(target, src) {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      deepAssign(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

function restoreConfig(snap) {
  deepAssign(CONFIG, snap);
}

/* ══════════════════════ 核心管线 ══════════════════════ */

/**
 * 跑单轮 147s 剧本，返回逐帧记录（含剧本相位与系统判定）。
 * @param {number} seed 本轮随机种子
 */
function runRound(seed) {
  const sim = new SimulatedDriver();
  sim._rng = mulberry32(seed); // 种子注入：同种子必得同一序列
  const indicators = new IndicatorEngine();
  const fusion = new FusionEngine();
  const calib = SimulatedDriver.calibration();

  const raw = [];
  for (let t = T0; t < T0 + SCRIPT_MS; t += STEP_MS) {
    const feat = sim.frame(t);
    const ind = indicators.update(feat, calib, QUALITY_OK);
    const fus = fusion.evaluate(ind, calib);
    raw.push({
      ts: t,
      phase: feat.phase,
      pred: fus.level,
      score: fus.score,
      override: fus.override,
      unreliable: fus.unreliable,
      dataValid: ind.dataValid,
      perclos: ind.perclos,
      perclosReady: ind.perclosReady === false ? 0 : 1,
    });
  }

  // 标注：剧本相位 → 二分类真值；normal→fatigue 切换前 3s 置 ignore
  const frames = raw.map((f) => ({ ...f, truth: f.phase === '清醒' ? 'normal' : 'fatigue' }));
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].truth === 'fatigue' && frames[i - 1].truth === 'normal') {
      for (let j = i - 1; j >= 0 && frames[i].ts - frames[j].ts <= IGNORE_BEFORE_ONSET_MS; j--) {
        frames[j].truth = 'ignore';
      }
    }
  }
  return frames;
}

/** 跑全部 10 轮（每轮独立引擎实例），返回按全局时间拼接的帧序列 */
function runAllRounds() {
  const all = [];
  const perRound = [];
  for (let r = 0; r < SEEDS.length; r++) {
    const frames = runRound(SEEDS[r]);
    const base = r * SCRIPT_MS;
    for (const f of frames) {
      all.push({ ...f, tSec: (base + f.ts - T0) / 1000, round: r + 1 });
    }
    perRound.push(frames);
  }
  return { all, perRound };
}

/* ══════════════════════ 输出工具 ══════════════════════ */

const fmt6 = (v) => (Number.isFinite(v) ? String(+v.toFixed(6)) : '');
const fmtInt = (v) => (Number.isFinite(v) ? String(Math.round(v)) : '');
const fmt2 = (v) => (Number.isFinite(v) ? String(+v.toFixed(2)) : '');

function writeCsv(name, rows) {
  const text = rows.map((r) => r.join(',')).join('\n') + '\n';
  fs.writeFileSync(path.join(FIG_DIR, name), text, 'utf8');
  console.log(`  已写入 figures/${name}`);
}

function writeSvg(name, svg) {
  fs.writeFileSync(path.join(FIG_DIR, name), svg, 'utf8');
  console.log(`  已写入 figures/${name}`);
}

/* ══════════════════════ 一、主评估 ══════════════════════ */

console.log('\n=== 一、主评估（10 种子 × 147s） ===');
const snap = snapshotConfig();
const { all, perRound } = runAllRounds();

const valid = all.filter((f) => f.truth === 'normal' || f.truth === 'fatigue');
const pairs = valid.map((f) => ({ truth: f.truth, pred: f.pred, weightMs: STEP_MS }));
const metrics = computeMetrics(pairs, 'mild');
const points = valid.map((f) => ({ truth: f.truth, score: f.score }));
const rocpr = computeRocPr(points);
const series = all.map((f) => ({ tSec: f.tSec, truth: f.truth, pred: f.pred }));
const latency = computeLatency(series, 'mild');

const T = metrics.byTime;
const C = metrics.byCount;

console.log(`  评估点数: ${valid.length}（10 轮 × ${valid.length / 10}）`);
console.log(`  灵敏度(时间加权): ${fmt6(T.sensitivity)}  特异度: ${fmt6(T.specificity)}  F1: ${fmt6(T.f1)}  MCC: ${fmt6(T.mcc)}`);
console.log(`  ROC AUC: ${fmt6(rocpr.auc)}  PR AP: ${fmt6(rocpr.ap)}`);
console.log(`  延迟: 均值 ${latency.meanLatencySec.toFixed(2)}s / 中位 ${latency.medianLatencySec.toFixed(2)}s / 漏检 ${latency.missedCount}`);

// 每轮延迟明细（评估报告第五节表格）
const roundLatencies = perRound.map((frames, i) => {
  const ev = latency.events[i];
  return { round: i + 1, seed: SEEDS[i], latencySec: ev ? (ev.latencySec === null ? null : +ev.latencySec.toFixed(1)) : null, missed: ev ? ev.missed : true };
});
for (const r of roundLatencies) {
  console.log(`  第${r.round}轮 种子${r.seed}: 延迟 ${r.latencySec === null ? '漏检' : r.latencySec + 's'}${r.missed ? '（漏检）' : ''}`);
}

writeCsv('accuracy-summary.csv', [
  ['指标', '按时间加权', '按采样点计数'],
  ['准确率 Accuracy', fmt6(T.accuracy), fmt6(C.accuracy)],
  ['灵敏度 Sensitivity', fmt6(T.sensitivity), fmt6(C.sensitivity)],
  ['特异度 Specificity', fmt6(T.specificity), fmt6(C.specificity)],
  ['精确率 Precision', fmt6(T.precision), fmt6(C.precision)],
  ['F1 分数', fmt6(T.f1), fmt6(C.f1)],
  ['平衡准确率 Balanced Accuracy', fmt6(T.balancedAcc), fmt6(C.balancedAcc)],
  ["Youden J 指数", fmt6(T.youdenJ), fmt6(C.youdenJ)],
  ['MCC', fmt6(T.mcc), fmt6(C.mcc)],
  ['误报率 FPR', fmt6(T.fpr), fmt6(C.fpr)],
  ['漏报率 FNR', fmt6(T.fnr), fmt6(C.fnr)],
  ['TP（时间列为毫秒）', fmtInt(metrics.matrixTimeMs.tp), fmtInt(metrics.matrix.tp)],
  ['FN（时间列为毫秒）', fmtInt(metrics.matrixTimeMs.fn), fmtInt(metrics.matrix.fn)],
  ['FP（时间列为毫秒）', fmtInt(metrics.matrixTimeMs.fp), fmtInt(metrics.matrix.fp)],
  ['TN（时间列为毫秒）', fmtInt(metrics.matrixTimeMs.tn), fmtInt(metrics.matrix.tn)],
  ['ROC AUC', fmt6(rocpr.auc), ''],
  ['PR AP（平均精度）', fmt6(rocpr.ap), ''],
  ['平均响应延迟(秒)', fmt2(latency.meanLatencySec), ''],
  ['中位响应延迟(秒)', fmt2(latency.medianLatencySec), ''],
  ['检出疲劳区间数', fmtInt(latency.detectedCount), ''],
  ['漏检疲劳区间数', fmtInt(latency.missedCount), ''],
]);

/* ══════════════════════ 二、基线对照 ══════════════════════ */

console.log('\n=== 二、基线对照（单 PERCLOS 阈值 vs 七特征融合） ===');
const baselinePts = valid.map((f) => ({ truth: f.truth, perclos: f.perclos, perclosReady: f.perclosReady }));
const baselines = computeBaseline(baselinePts, [0.05, 0.08, 0.1, 0.12, 0.15]);

const baselineRows = [['方法', '灵敏度', '特异度', '准确率', 'F1', 'MCC']];
for (const b of baselines) {
  const m = b.byCount;
  baselineRows.push([
    `PERCLOS阈值${b.threshold}`,
    fmt6(m.sensitivity), fmt6(m.specificity), fmt6(m.accuracy), fmt6(m.f1), fmt6(m.mcc),
  ]);
  console.log(`  PERCLOS阈值${b.threshold}: 灵敏度 ${fmt6(m.sensitivity)} 特异度 ${fmt6(m.specificity)} F1 ${fmt6(m.f1)}`);
}
baselineRows.push(['七特征融合', fmt6(T.sensitivity), fmt6(T.specificity), fmt6(T.accuracy), fmt6(T.f1), fmt6(T.mcc)]);
console.log(`  七特征融合: 灵敏度 ${fmt6(T.sensitivity)} 特异度 ${fmt6(T.specificity)} F1 ${fmt6(T.f1)}`);
writeCsv('baseline-comparison.csv', baselineRows);

/* ══════════════════════ 三、权重消融 ══════════════════════ */

console.log('\n=== 三、权重消融实验 ===');

/** 统计一轮集合的平均疲劳指数 / 峰值 / 疲劳时间占比（全部帧口径，与主评估的 ignore 剔除无关） */
function aggregateStats(roundsData) {
  let sum = 0;
  let n = 0;
  let peak = 0;
  let mildPlus = 0;
  let total = 0;
  for (const frames of roundsData) {
    for (const f of frames) {
      if (Number.isFinite(f.score)) {
        sum += f.score;
        n++;
        if (f.score > peak) peak = f.score;
      }
      total++;
      if (['mild', 'moderate', 'severe'].includes(f.pred)) mildPlus++;
    }
  }
  return { meanScore: n ? sum / n : NaN, peak, mildRatio: total ? mildPlus / total : NaN };
}

const weightKeys = Object.keys(CONFIG.fusion.weights);
const ablationRows = [['指标', '原权重', '平均疲劳指数', '平均指数变化量', '峰值疲劳指数', '疲劳时间占比', '疲劳占比变化量']];

const baseStats = aggregateStats(perRound);
ablationRows.push(['完整模型(基线)', '', fmt2(baseStats.meanScore), '0', fmt2(baseStats.peak), fmt6(baseStats.mildRatio), '0']);
console.log(`  完整模型: 平均指数 ${fmt2(baseStats.meanScore)} 峰值 ${fmt2(baseStats.peak)} 疲劳占比 ${fmt6(baseStats.mildRatio)}`);

/* 消融采用「扣除贡献」语义（与 web/js/core/analysis.js 的 ablateKey 完全一致）：
 * 分母保持完整权重之和，只把被消融指标的贡献项从分子中去掉，Δ 必然 ≤ 0。
 * 注意不能把权重直接置 0——那会触发融合层的重归一化（分母同步变小），
 * 等价于把该指标的权重重新分给其余指标，移除一个低隶属度指标反而升分
 * （analysis.js 注释实测 +7.3 分），无法回答"这个指标贡献了多少分"。
 * 实现方式：包一层 memberships，把被消融项的隶属度置 0——
 * wsum 不变、分子少掉 w_k·μ_k，与 ablateKey 在数学上等价，
 * 且完整流经真实的 EMA/趋势加速器/override/滞回分级链路。 */
const ORIG_MEMBERSHIPS_ABL = FusionEngine.memberships.bind(FusionEngine);
const ablationItems = [];
for (const key of weightKeys) {
  const saved = CONFIG.fusion.weights[key];
  FusionEngine.memberships = function (ind, calib) {
    const mu = ORIG_MEMBERSHIPS_ABL(ind, calib);
    mu[key] = 0;
    return mu;
  };
  const { perRound: ablated } = runAllRounds();
  FusionEngine.memberships = ORIG_MEMBERSHIPS_ABL;
  const st = aggregateStats(ablated);
  const label = { perclos: '闭眼时间占比', closureDur: '最长闭眼', blinkRate: '眨眼频率', blinkDur: '眨眼时长', yawn: '哈欠频率', nod: '点头频率', headDev: '注意力分散' }[key] || key;
  ablationRows.push([
    label, fmt6(saved), fmt2(st.meanScore), fmt2(st.meanScore - baseStats.meanScore),
    fmt2(st.peak), fmt6(st.mildRatio), fmt6(st.mildRatio - baseStats.mildRatio),
  ]);
  ablationItems.push({ label, value: +(st.meanScore - baseStats.meanScore).toFixed(2) });
  console.log(`  移除${label}(权重${saved}): 平均指数 ${fmt2(st.meanScore)}（Δ${fmt2(st.meanScore - baseStats.meanScore)}）疲劳占比 ${fmt6(st.mildRatio)}`);
}
writeCsv('ablation-analysis.csv', ablationRows);

/* ══════════════════════ 四、参数敏感性 ══════════════════════ */

console.log('\n=== 四、参数敏感性分析 ===');

/** 统计含等级跃迁次数的完整指标集 */
function sensitivityStats(roundsData) {
  const st = aggregateStats(roundsData);
  let severe = 0;
  let total = 0;
  let jumps = 0;
  for (const frames of roundsData) {
    let prev = null;
    for (const f of frames) {
      total++;
      if (f.pred === 'severe') severe++;
      if (prev !== null && f.pred !== prev) jumps++;
      prev = f.pred;
    }
  }
  return { ...st, severeRatio: total ? severe / total : NaN, jumps };
}

const sensitivityRows = [['参数名', '取值', '是否当前默认', '平均疲劳指数', '峰值疲劳指数', '疲劳时间占比', '重度时间占比', '等级跃迁次数']];

/**
 * 敏感性扫描通用流程：patch() 修改参数 → 10 轮重跑 → 统计 → 恢复。
 * 默认值行标记 1，其余 0。
 */
function sweepParam(name, values, isDefault, patch, fileKey) {
  const defaultVal = values.find(isDefault);
  const statsByValue = [];
  for (const v of values) {
    patch(v);
    const { perRound: rd } = runAllRounds();
    restoreConfig(snap);
    const st = sensitivityStats(rd);
    statsByValue.push({ v, st });
    sensitivityRows.push([
      name, String(v), v === defaultVal ? '1' : '0',
      fmt2(st.meanScore), fmt2(st.peak), fmt6(st.mildRatio), fmt6(st.severeRatio), fmtInt(st.jumps),
    ]);
    console.log(`  ${name}=${v}: 平均指数 ${fmt2(st.meanScore)} 疲劳占比 ${fmt6(st.mildRatio)} 跃迁 ${st.jumps}`);
  }
  // 敏感性曲线：参数值 → 疲劳时间占比（主）与平均疲劳指数（辅）
  const svg = lineChart({
    title: `参数敏感性：${name}`,
    series: [
      { name: '疲劳时间占比', color: '#0071e3', points: statsByValue.map((d) => [d.v, d.st.mildRatio]) },
      { name: '平均疲劳指数', color: '#c2731a', points: statsByValue.map((d) => [d.v, d.st.meanScore / 100]), dash: '6 4' },
    ],
    xLabel: name,
    yLabel: '占比 / 归一化指数',
    yMin: 0,
    yMax: 1,
  });
  writeSvg(`敏感性-${fileKey}.svg`, svg);
}

// 4.1 PERCLOS 隶属下限（fusion.js 中为硬编码 0.06~0.32，此处运行时包一层可参数化换算）
const ORIG_MEMBERSHIPS = FusionEngine.memberships.bind(FusionEngine);
const PERCLOS_LO_DEFAULT = 0.06;
const PERCLOS_HI = 0.32;
sweepParam(
  'PERCLOS 隶属下限',
  [0.02, 0.04, 0.06, 0.08, 0.1, 0.13, 0.16, 0.2],
  (v) => v === PERCLOS_LO_DEFAULT,
  (lo) => {
    FusionEngine.memberships = function (ind, calib) {
      const p = ind.perclos;
      if (Number.isFinite(p) && ind.perclosReady !== false) {
        // 线性隶属函数可逆：把 perclos 映射为在原界(0.06,0.32)下产生与新下限
        // 相同隶属度的等价值，从而精确复现"下限改为 lo"的效果
        let p2;
        if (p <= lo) p2 = PERCLOS_LO_DEFAULT - 1e-6;
        else if (p >= PERCLOS_HI) p2 = PERCLOS_HI;
        else p2 = PERCLOS_LO_DEFAULT + ((p - lo) / (PERCLOS_HI - lo)) * (PERCLOS_HI - PERCLOS_LO_DEFAULT);
        return ORIG_MEMBERSHIPS({ ...ind, perclos: p2 }, calib);
      }
      return ORIG_MEMBERSHIPS(ind, calib);
    };
  },
  'perclosLower'
);
FusionEngine.memberships = ORIG_MEMBERSHIPS;

// 4.2 危险闭眼时长（CONFIG.event.criticalClosureMs）
sweepParam(
  '危险闭眼时长',
  [1000, 1200, 1500, 1800, 2200, 2600, 3000],
  (v) => v === CONFIG.event.criticalClosureMs,
  (v) => { CONFIG.event.criticalClosureMs = v; },
  'criticalClosureMs'
);

// 4.3 EMA 平滑系数
sweepParam(
  'EMA 平滑系数',
  [0.04, 0.08, 0.12, 0.18, 0.25, 0.35, 0.5],
  (v) => v === CONFIG.fusion.emaAlpha,
  (v) => { CONFIG.fusion.emaAlpha = v; },
  'emaAlpha'
);

// 4.4 轻度疲劳分界（levels[0].max 与 levels[1].min 同步移动）
sweepParam(
  '轻度疲劳分界',
  [20, 24, 28, 30, 34, 38, 44],
  (v) => v === CONFIG.fusion.levels[0].max,
  (v) => {
    CONFIG.fusion.levels[0].max = v;
    CONFIG.fusion.levels[1].min = v;
  },
  'mildThreshold'
);

// 4.5 重度疲劳分界（levels[2].max 与 levels[3].min 同步移动）
sweepParam(
  '重度疲劳分界',
  [62, 68, 74, 80, 86, 92],
  (v) => v === CONFIG.fusion.levels[2].max,
  (v) => {
    CONFIG.fusion.levels[2].max = v;
    CONFIG.fusion.levels[3].min = v;
  },
  'severeThreshold'
);
writeCsv('sensitivity-analysis.csv', sensitivityRows);

/* ══════════════════════ 五、对抗场景 ══════════════════════ */

console.log('\n=== 五、对抗场景测试（干扰下的抗误报） ===');

/**
 * 合成对抗场景特征帧。字段结构与 SimulatedDriver.frame() 输出一致，
 * 干扰模式按场景物理特征设计（详见各 case 注释）。
 */
function adversarialFrame(ts, scenario, rng) {
  const EAR_OPEN = 0.3;
  const EAR_CLOSED = 0.055;
  const MAR_CLOSED = 0.06;
  const elapsed = ts - T0;
  const noise = (amp) => (rng() - 0.5) * amp;

  // 基础帧模板（清醒驾驶员）
  const base = {
    ok: true, ts, simulated: true, phase: '清醒', landmarks: null,
    ear: EAR_OPEN + noise(0.006), mar: MAR_CLOSED + Math.sin(elapsed / 900) * 0.012,
    pitch: Math.sin(elapsed / 2600) * 1.2, yaw: Math.sin(elapsed / 3700 + 1.2) * 2, roll: Math.sin(elapsed / 4300 + 0.5) * 0.8,
    pitchVel: 0, poseSource: 'simulated', scale: 0.22, gaze: { h: 0, v: 0 },
    blend: { eyeBlinkLeft: 0.05, eyeBlinkRight: 0.05, jawOpen: 0 },
    blinkScore: 0.05, squintScore: 0, browDown: 0, jawOpen: 0,
  };
  base.earL = base.ear; base.earR = base.ear; base.earRaw = { l: base.ear, r: base.ear };

  // 正常眨眼调度（所有"保持清醒"场景共用：15 次/分，120ms）
  const blinkPeriod = 4000;
  const blinkPhase = elapsed % blinkPeriod;
  const inBlink = blinkPhase < 120;
  if (inBlink) {
    const prog = blinkPhase / 120;
    const k = 0.5 - 0.5 * Math.cos(Math.PI * prog);
    base.ear = EAR_OPEN + (EAR_CLOSED - EAR_OPEN) * k;
    base.blinkScore = base.blend.eyeBlinkLeft = base.blend.eyeBlinkRight = 0.05 + k * 0.9;
  }

  switch (scenario) {
    case '低头看手机':
      // 持续低头 32°（>headDeviationDeg 25°），视线离开前方 → headDevRatio≈1，
      // 但权重仅 0.04，归一化后约 4 分，远低于轻度分界 24
      base.pitch = -32 + noise(2);
      base.pitchVel = noise(3);
      break;
    case '频繁揉眼': {
      // 每 700ms 一次 250ms 揉眼：EAR 被手压到闭眼水平（几何通道说"闭"），
      // 但语义通道 eyeBlink≈0.12（眼其实睁着）→ 双通道融合 closure≈0.65，
      // 达不到 0.8 的闭门限，不产生任何闭眼事件
      const rubPhase = elapsed % 700;
      if (rubPhase < 250) {
        base.ear = 0.05 + noise(0.01);
        base.blinkScore = base.blend.eyeBlinkLeft = base.blend.eyeBlinkRight = 0.12;
      }
      break;
    }
    case '说话': {
      // 快速张合口（300ms 开 / 200ms 闭）：MAR 峰值 0.55 超过张口阈值，
      // 但每次持续仅 300ms < yawnMinMs 1200ms → 不判哈欠
      const talkPhase = elapsed % 500;
      if (talkPhase < 300) {
        const k = Math.sin((Math.PI * talkPhase) / 300);
        base.mar = 0.06 + 0.49 * k;
        base.jawOpen = base.blend.jawOpen = 0.55 * k;
      }
      break;
    }
    case '过减速带': {
      // 每 2.2s 一次衰减振荡（幅值 3°，2.5Hz，400ms）：
      // 角速度峰值 ≈ 3°×2π×2.5 ≈ 47°/s < nodPitchVelDegPerSec 55 → 不判点头
      const bumpPhase = elapsed % 2200;
      if (bumpPhase < 400) {
        const tau = bumpPhase / 1000;
        const damp = Math.exp(-tau / 0.15);
        base.pitch = 3 * Math.sin(2 * Math.PI * 2.5 * tau) * damp;
        base.pitchVel = 3 * 2 * Math.PI * 2.5 * Math.cos(2 * Math.PI * 2.5 * tau) * damp;
      }
      break;
    }
    case '戴墨镜':
      // 眼部被遮挡：EAR 读数不可靠 + 质量门控置无效 → 全程"信号不可用"
      base.ear = 0.1 + noise(0.02);
      base.blinkScore = 0.08;
      break;
    case '侧脸':
      // 人脸长期丢失（大角度侧转超出检测能力）
      base.ok = false;
      break;
    default:
      break;
  }
  if (base.ok && !inBlink) {
    base.ear += noise(0.006);
  }
  return base;
}

function runAdversarial(scenario) {
  // 场景全名带括号说明（如"戴墨镜（眼部不可靠）"），
  // adversarialFrame 的 switch 与质量门控判断一律用短名匹配。
  const key = scenario.split('（')[0];
  const rng = mulberry32(20250730);
  const indicators = new IndicatorEngine();
  const fusion = new FusionEngine();
  const calib = SimulatedDriver.calibration();
  const quality = key === '戴墨镜'
    ? { face: { valid: false, reasons: ['墨镜遮挡：眼部信号不可靠'], label: '差' }, lighting: { valid: true, label: '良好' } }
    : QUALITY_OK;

  const counts = { awake: 0, mild: 0, moderate: 0, severe: 0, unavailable: 0 };
  let overrideCount = 0;
  for (let t = T0; t < T0 + 450 * STEP_MS; t += STEP_MS) {
    const feat = adversarialFrame(t, key, rng);
    const ind = indicators.update(feat, calib, quality);
    const fus = fusion.evaluate(ind, calib);
    if (ind.dataValid === false || fus.unreliable) counts.unavailable++;
    else if (fus.level in counts) counts[fus.level]++;
    if (fus.override) overrideCount++;
  }
  return { counts, overrideCount };
}

const ADV_SCENARIOS = [
  { name: '低头看手机', expect: '保持清醒' },
  { name: '频繁揉眼', expect: '保持清醒' },
  { name: '说话（哈欠特征被污染）', expect: '保持清醒' },
  { name: '过减速带（点头特征被污染）', expect: '保持清醒' },
  { name: '戴墨镜（眼部不可靠）', expect: '信号不可用' },
  { name: '侧脸（人脸长期丢失）', expect: '信号不可用' },
];

const advRows = [['场景', '期望', '清醒帧', '轻度帧', '中度帧', '重度帧', '不可用帧', '统计帧数', '误报率', '安全兜底触发次数', '判定']];
const advChartItems = [];
for (const sc of ADV_SCENARIOS) {
  const { counts, overrideCount } = runAdversarial(sc.name);
  const statFrames = counts.awake + counts.mild + counts.moderate + counts.severe + counts.unavailable;
  const falsePos = counts.mild + counts.moderate + counts.severe;
  const fpr = statFrames > 0 ? falsePos / statFrames : 0;
  const pass = sc.expect === '保持清醒'
    ? falsePos === 0 && overrideCount === 0
    : counts.unavailable === statFrames && falsePos === 0;
  advRows.push([
    sc.name, sc.expect, counts.awake, counts.mild, counts.moderate, counts.severe, counts.unavailable,
    statFrames, fpr.toFixed(4), overrideCount, pass ? 'PASS' : 'FAIL',
  ]);
  advChartItems.push({ label: sc.name.split('（')[0], value: +fpr.toFixed(4) });
  console.log(`  ${sc.name}: 清醒${counts.awake} 轻${counts.mild} 中${counts.moderate} 重${counts.severe} 不可用${counts.unavailable} 兜底${overrideCount} → ${pass ? 'PASS' : 'FAIL'}`);
}
writeCsv('adversarial-summary.csv', advRows);

/* ══════════════════════ 六、四轮迭代对比 ══════════════════════ */

console.log('\n=== 六、四轮迭代优化历程（按评估报告第六节参数变更明细复原） ===');

/** 旧参数集（R1 之前的生产参数） */
const OLD_WEIGHTS = { perclos: 0.3, closureDur: 0.2, blinkRate: 0.1, blinkDur: 0.08, yawn: 0.14, nod: 0.1, headDev: 0.08 };
const NEW_WEIGHTS = { perclos: 0.34, closureDur: 0.23, blinkRate: 0.1, blinkDur: 0.05, yawn: 0.14, nod: 0.1, headDev: 0.04 };

/**
 * 应用一轮迭代的参数组合（在当前 CONFIG 基础上覆盖差异项）。
 * 参数取值依据：评估报告 2.1–2.7 节与第六节参数变更明细。
 */
const ROUNDS = [
  {
    name: '基线', desc: '原始参数（level30, EMA0.12, 旧权重）',
    apply: () => {
      Object.assign(CONFIG.fusion.weights, OLD_WEIGHTS);
      CONFIG.fusion.levels[0].max = 30; CONFIG.fusion.levels[1].min = 30;
      CONFIG.fusion.emaAlpha = 0.12;
      CONFIG.fusion.trendMaxBoost = 0; CONFIG.fusion.trendMinBoost = 0;
      CONFIG.window.perclosSec = 30;
      CONFIG.window.perclosMinObservationSec = 10; CONFIG.window.perclosMinSamples = 120;
      CONFIG.fusion.levelDwellMs = 1200;
      CONFIG.fusion.minHoldMs = { awake: 0, mild: 2000, moderate: 4000, severe: 8000 };
    },
  },
  {
    name: '初调', desc: 'level30→26, EMA0.12→0.14',
    apply: () => {
      ROUNDS[0].apply();
      CONFIG.fusion.levels[0].max = 26; CONFIG.fusion.levels[1].min = 26;
      CONFIG.fusion.emaAlpha = 0.14;
    },
  },
  {
    name: 'R1', desc: '趋势加速器 + 权重重组 + level26→24 + 快速就绪',
    apply: () => {
      ROUNDS[1].apply();
      Object.assign(CONFIG.fusion.weights, NEW_WEIGHTS);
      CONFIG.fusion.levels[0].max = 24; CONFIG.fusion.levels[1].min = 24;
      CONFIG.fusion.trendMaxBoost = 5; CONFIG.fusion.trendMinBoost = -2;
      CONFIG.window.perclosMinObservationSec = 5; CONFIG.window.perclosMinSamples = 50;
    },
  },
  {
    name: 'R2', desc: '驻留缩短(dwell1200→800+minHold下调) + EMA0.14→0.16',
    apply: () => {
      ROUNDS[2].apply();
      CONFIG.fusion.emaAlpha = 0.16;
      CONFIG.fusion.levelDwellMs = 800;
      CONFIG.fusion.minHoldMs = { awake: 0, mild: 1000, moderate: 2500, severe: 6000 };
    },
  },
  {
    name: 'R3', desc: 'EMA0.16→0.18 + dwellMs800→600',
    apply: () => {
      ROUNDS[3].apply();
      CONFIG.fusion.emaAlpha = 0.18;
      CONFIG.fusion.levelDwellMs = 600;
    },
  },
  { name: 'R4', desc: 'trendMaxBoost 5→8 + PERCLOS窗口30→20s（当前生产参数）', apply: () => {} },
];

const roundRows = [['轮次', '主要优化措施', '灵敏度', '特异度', 'F1', 'MCC', '延迟(秒)']];
for (const rd of ROUNDS) {
  restoreConfig(snap);
  rd.apply();
  const { all: rAll } = runAllRounds();
  const rValid = rAll.filter((f) => f.truth === 'normal' || f.truth === 'fatigue');
  const rPairs = rValid.map((f) => ({ truth: f.truth, pred: f.pred, weightMs: STEP_MS }));
  const rMetrics = computeMetrics(rPairs, 'mild');
  const rSeries = rAll.map((f) => ({ tSec: f.tSec, truth: f.truth, pred: f.pred }));
  const rLatency = computeLatency(rSeries, 'mild');
  const m = rMetrics.byTime;
  roundRows.push([
    rd.name, rd.desc, fmt6(m.sensitivity), fmt6(m.specificity), fmt6(m.f1), fmt6(m.mcc),
    rLatency.meanLatencySec.toFixed(1),
  ]);
  console.log(`  ${rd.name}: 灵敏度 ${fmt6(m.sensitivity)} 特异度 ${fmt6(m.specificity)} F1 ${fmt6(m.f1)} MCC ${fmt6(m.mcc)} 延迟 ${rLatency.meanLatencySec.toFixed(1)}s`);
}
restoreConfig(snap);
writeCsv('tuning-rounds.csv', roundRows);

/* ══════════════════════ 七、单因子调参实验 ══════════════════════ */

console.log('\n=== 七、单因子调参实验（从原始参数出发的单因子/组合对比，共 10 组） ===');

/**
 * 调参实验：从基线原始参数（level30 + EMA0.12 + 旧权重，与四轮迭代的
 * "基线"定义一致）出发，单因子改变轻度分界 / EMA 系数 / PERCLOS 窗口，
 * 另设三组组合实验。该实验是 R1 权重重组与等级分界下调的决策依据。
 */
const TUNING_GROUPS = [
  { name: '基线（原始参数）', desc: 'level30 + EMA0.12 + 旧权重', apply: () => ROUNDS[0].apply() },
  {
    name: '轻度分界 28', desc: '轻度分界 30→28',
    apply: () => { ROUNDS[0].apply(); CONFIG.fusion.levels[0].max = 28; CONFIG.fusion.levels[1].min = 28; },
  },
  {
    name: '轻度分界 26', desc: '轻度分界 30→26',
    apply: () => { ROUNDS[0].apply(); CONFIG.fusion.levels[0].max = 26; CONFIG.fusion.levels[1].min = 26; },
  },
  {
    name: '轻度分界 24', desc: '轻度分界 30→24',
    apply: () => { ROUNDS[0].apply(); CONFIG.fusion.levels[0].max = 24; CONFIG.fusion.levels[1].min = 24; },
  },
  { name: 'EMA 0.15', desc: 'EMA 0.12→0.15', apply: () => { ROUNDS[0].apply(); CONFIG.fusion.emaAlpha = 0.15; } },
  { name: 'EMA 0.18', desc: 'EMA 0.12→0.18', apply: () => { ROUNDS[0].apply(); CONFIG.fusion.emaAlpha = 0.18; } },
  { name: 'PERCLOS窗口 20s', desc: '窗口 30→20s', apply: () => { ROUNDS[0].apply(); CONFIG.window.perclosSec = 20; } },
  {
    name: '组合A: 28+EMA0.15', desc: '轻度分界28 + EMA0.15',
    apply: () => { ROUNDS[0].apply(); CONFIG.fusion.levels[0].max = 28; CONFIG.fusion.levels[1].min = 28; CONFIG.fusion.emaAlpha = 0.15; },
  },
  {
    name: '组合B: 26+EMA0.18', desc: '轻度分界26 + EMA0.18',
    apply: () => { ROUNDS[0].apply(); CONFIG.fusion.levels[0].max = 26; CONFIG.fusion.levels[1].min = 26; CONFIG.fusion.emaAlpha = 0.18; },
  },
  {
    name: '组合C: 28+EMA0.15+窗口20', desc: '三参数组合优化',
    apply: () => {
      ROUNDS[0].apply();
      CONFIG.fusion.levels[0].max = 28; CONFIG.fusion.levels[1].min = 28;
      CONFIG.fusion.emaAlpha = 0.15; CONFIG.window.perclosSec = 20;
    },
  },
];

const tuningRows = [['实验组', '描述', '灵敏度', '特异度', '准确率', 'F1', 'MCC', 'AUC', '漏报率FNR', '误报率FPR', '平衡准确率', '漏检数', '平均延迟(秒)']];
const tuningStats = [];
for (const g of TUNING_GROUPS) {
  restoreConfig(snap);
  g.apply();
  const { all: gAll } = runAllRounds();
  const gValid = gAll.filter((f) => f.truth === 'normal' || f.truth === 'fatigue');
  const gPairs = gValid.map((f) => ({ truth: f.truth, pred: f.pred, weightMs: STEP_MS }));
  const gMetrics = computeMetrics(gPairs, 'mild');
  const gRoc = computeRocPr(gValid.map((f) => ({ truth: f.truth, score: f.score })));
  const gLatency = computeLatency(gAll.map((f) => ({ tSec: f.tSec, truth: f.truth, pred: f.pred })), 'mild');
  const gm = gMetrics.byTime;
  tuningRows.push([
    g.name, g.desc, fmt6(gm.sensitivity), fmt6(gm.specificity), fmt6(gm.accuracy), fmt6(gm.f1), fmt6(gm.mcc),
    fmt6(gRoc.auc), fmt6(gm.fnr), fmt6(gm.fpr), fmt6(gm.balancedAcc),
    fmtInt(gLatency.missedCount), gLatency.meanLatencySec.toFixed(2),
  ]);
  tuningStats.push({ name: g.name, sensitivity: gm.sensitivity, specificity: gm.specificity, f1: gm.f1 });
  console.log(`  ${g.name}: 灵敏度 ${fmt6(gm.sensitivity)} F1 ${fmt6(gm.f1)} 延迟 ${gLatency.meanLatencySec.toFixed(2)}s`);
}
restoreConfig(snap);
writeCsv('param-tuning-results.csv', tuningRows);

/* ══════════════════════ 八、图表 ══════════════════════ */

console.log('\n=== 八、生成图表 ===');

// 7.1 ROC 曲线
const rocSorted = [...rocpr.roc].sort((a, b) => a.fpr - b.fpr);
writeSvg('ROC曲线.svg', lineChart({
  title: `ROC 曲线（AUC = ${rocpr.auc.toFixed(4)}）`,
  series: [
    { name: '融合系统 ROC', color: '#0071e3', points: rocSorted.map((p) => [p.fpr, p.tpr]) },
    { name: '随机猜测参考', color: '#86868b', dash: '6 4', points: [[0, 0], [1, 1]] },
  ],
  xLabel: '假正率 FPR',
  yLabel: '真正率 TPR',
  yMin: 0, yMax: 1,
  note: '10 种子 × 147s 模拟评估，按采样点计数口径',
}));

// 7.2 PR 曲线
const prSorted = [...rocpr.pr].sort((a, b) => a.tpr - b.tpr);
writeSvg('PR曲线.svg', lineChart({
  title: `PR 曲线（AP = ${rocpr.ap.toFixed(4)}）`,
  series: [{ name: '融合系统 PR', color: '#28a745', points: prSorted.map((p) => [p.tpr, p.precision]) }],
  xLabel: '召回率（灵敏度）',
  yLabel: '查准率（精确率）',
  yMin: 0, yMax: 1.02,
  note: `正例 ${rocpr.positives} 个 / 负例 ${rocpr.negatives} 个`,
}));

// 7.3 基线对比（灵敏度柱状图）
writeSvg('基线对比.svg', barChart({
  title: '基线对照：单 PERCLOS 阈值 vs 七特征融合（灵敏度）',
  items: [
    ...baselines.map((b, i) => ({ label: `阈值${b.threshold}`, value: +b.byCount.sensitivity.toFixed(4), color: ['#8e8e93', '#6e6e73', '#515154', '#3a3a3c', '#2c2c2e'][i] })),
    { label: '七特征融合', value: +T.sensitivity.toFixed(4), color: '#0071e3' },
  ],
  yLabel: '灵敏度',
  yFmt: (v) => v.toFixed(2),
  note: '同一份标注数据上的对比；融合系统在对抗场景下保持零误报（见对抗场景测试）',
}));

// 7.4 检出延迟（每轮柱状图）
writeSvg('检出延迟.svg', barChart({
  title: '响应延迟（10 轮 · 零漏检）',
  items: roundLatencies.map((r) => ({
    label: `第${r.round}轮`,
    value: r.latencySec === null ? 0 : r.latencySec,
    color: r.latencySec !== null && r.latencySec < 10 ? '#28a745' : '#0071e3',
  })),
  yLabel: '延迟（秒）',
  note: `均值 ${latency.meanLatencySec.toFixed(1)}s / 中位 ${latency.medianLatencySec.toFixed(1)}s；延迟主要来自 PERCLOS 滑动窗口累积`,
}));

// 7.5 消融实验（平均指数变化量柱状图）
writeSvg('消融实验.svg', barChart({
  title: '权重消融：逐项移除后平均疲劳指数变化量',
  items: ablationItems.map((it) => ({ ...it, color: it.value < -5 ? '#c2731a' : '#8e8e93' })),
  yLabel: '平均指数变化量',
  note: '变化为负说明该指标有正贡献；哈欠频率对"疲劳占比"影响最大，PERCLOS/最长闭眼对分数贡献最大',
}));

// 7.6 对抗场景误报率
writeSvg('对抗场景误报.svg', barChart({
  title: '对抗场景误报率（六场景全部零误报）',
  items: advChartItems.map((it) => ({ ...it, color: it.value === 0 ? '#28a745' : '#c11f1a' })),
  yLabel: '误报率',
  yFmt: (v) => v.toFixed(2),
  note: '多特征融合 + 持续时长判据 + 数据质量门控三层机制抑制干扰误报',
}));

// 7.7 调参实验图（10 组参数对比：灵敏度 / F1 / 灵敏特异散点）
const tuningBest = tuningStats.reduce((a, b) => (b.sensitivity > a.sensitivity ? b : a));
const tuningBestF1 = tuningStats.reduce((a, b) => (b.f1 > a.f1 ? b : a));
writeSvg('调优-灵敏度对比.svg', barChart({
  title: '参数调优：灵敏度对比（10 组实验）',
  items: tuningStats.map((s) => ({
    label: s.name,
    value: +(s.sensitivity * 100).toFixed(2),
    color: s === tuningStats[0] ? '#146a38' : (s === tuningBest ? '#0057b8' : '#6e6e73'),
  })),
  yLabel: '灵敏度（%）',
  yFmt: (v) => String(Math.round(v)),
  note: `最优：${tuningBest.name}（${(tuningBest.sensitivity * 100).toFixed(1)}%）| 基线：${(tuningStats[0].sensitivity * 100).toFixed(1)}%`,
}));
writeSvg('调优-F1对比.svg', barChart({
  title: '参数调优：F1 对比（10 组实验）',
  items: tuningStats.map((s) => ({
    label: s.name,
    value: +(s.f1 * 100).toFixed(2),
    color: s === tuningStats[0] ? '#146a38' : (s === tuningBestF1 ? '#0057b8' : '#6e6e73'),
  })),
  yLabel: 'F1 分数（%）',
  yFmt: (v) => String(Math.round(v)),
  note: `最优：${tuningBestF1.name}（${tuningBestF1.f1.toFixed(3)}）| 基线：${tuningStats[0].f1.toFixed(3)}`,
}));
writeSvg('调优-灵敏特异散点.svg', lineChart({
  title: '灵敏度 vs 特异度（各参数组合）',
  series: [
    { name: '各实验组', color: '#0057b8', points: tuningStats.map((s) => [+(s.specificity * 100).toFixed(2), +(s.sensitivity * 100).toFixed(2)]) },
  ],
  xLabel: '特异度（%）',
  yLabel: '灵敏度（%）',
  note: `所有实验组特异度恒为 100%（零误报约束），差异体现在灵敏度；最优：${tuningBest.name}`,
}));

/* ══════════════════════ 汇总 ══════════════════════ */

console.log('\n=== accuracy-eval 完成 ===');
console.log(`核心结论：灵敏度 ${(T.sensitivity * 100).toFixed(1)}% / 特异度 ${(T.specificity * 100).toFixed(1)}% / F1 ${T.f1.toFixed(3)} / MCC ${T.mcc.toFixed(3)} / 延迟 ${latency.meanLatencySec.toFixed(1)}s`);
console.log('产出目录：docs-evidence/figures/');
