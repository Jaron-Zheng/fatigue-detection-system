#!/usr/bin/env node
/**
 * gen-fixtures.mjs — 生成论文图表脚本的示例输入（合成演示数据）
 *
 * 第三轮角色十。四类图表脚本需要真实格式的 CSV 才能验证，
 * 本脚本用与产品完全相同的管线（SimulatedDriver → IndicatorEngine →
 * FusionEngine → SessionRecorder → runSensitivity / runAblation / computeMetrics）
 * 跑一段 150s 的演示剧本，产出格式与界面导出**逐字节一致**的示例文件：
 *
 *   fixtures/session-demo.csv       疲劳检测指标 CSV（会话时序）
 *   fixtures/session-demo.json      完整会话 JSON（含事件，供图中标报警点）
 *   fixtures/sensitivity-demo.csv   参数敏感性分析 CSV（5 个参数合并）
 *   fixtures/ablation-demo.csv      权重消融实验 CSV
 *   fixtures/eval-metrics-demo.csv  视频评测指标汇总 CSV
 *   fixtures/eval-points-demo.csv   视频评测逐点数据 CSV
 *
 * 评测的"人工标注"由剧本阶段名机械映射（清醒=正常，其余=疲劳），
 * 因此评测结果是**合成演示数据**，只用于打通脚本链路，不代表真实准确率。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_JS = path.resolve(__dirname, '../../web/js');
const OUT = path.join(__dirname, 'fixtures');
fs.mkdirSync(OUT, { recursive: true });

// ── 浏览器 API 最小 mock（与 regression-test.mjs 同款） ──
if (typeof globalThis.performance === 'undefined') globalThis.performance = { now: () => Date.now() };
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { userAgent: 'NodeFixtureGen/1.0' };
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

const importFromWeb = (rel) => import(pathToFileURL(path.join(WEB_JS, rel)).href);

const { CONFIG } = await importFromWeb('config.js');
const { SimulatedDriver } = await importFromWeb('core/sim-driver.js');
const { IndicatorEngine } = await importFromWeb('core/indicators.js');
const { FusionEngine } = await importFromWeb('core/fusion.js');
const { SessionRecorder, csvCell } = await importFromWeb('core/recorder.js');
const { SENSITIVITY_PARAMS, runSensitivity, runAblation } = await importFromWeb('core/analysis.js');
const { computeMetrics } = await importFromWeb('core/evaluation.js');
const { AlarmSystem } = await importFromWeb('core/alarm.js');
const { SAMPLE_COLUMNS, EVAL_SAMPLE_COLUMNS, LEVEL_KEY_TO_ZH, TRUTH_KEY_TO_ZH } = await importFromWeb('core/csv-schema.js');

const LEVEL_LABEL = { awake: '清醒', mild: '轻度', moderate: '中度', severe: '重度' };

/* ==================== 1. 跑 150s 演示会话 ==================== */
const driver = new SimulatedDriver();
const indicators = new IndicatorEngine();
const fusion = new FusionEngine();
const alarm = new AlarmSystem();
alarm.setMuted(true); // 生成器静音，避免无人值守时鸣响
const recorder = new SessionRecorder();
const calib = SimulatedDriver.calibration();
recorder.begin(calib, { simulated: true });

const DURATION_MS = 150000;
const t0 = 1000;

for (let t = t0; t < t0 + DURATION_MS; t += 33) {
  const feat = driver.frame(t);
  const ind = indicators.update(feat, calib);
  const fus = fusion.evaluate(ind, calib);
  recorder.sample(ind, fus, feat);
  const evts = indicators.drainNewEvents();
  if (evts.length) recorder.addEvents(evts);
  // 与 app.js 同款接线：报警事件同样入库，供图中标注报警触发点
  const alarmEv = alarm.update(fus.level, t, fus.override === 'critical_closure' ? '持续闭眼' : '');
  if (alarmEv) recorder.addEvent(alarmEv);
}

const lastInd = indicators.update({ ok: false, ts: t0 + DURATION_MS }, calib);
const lastFus = fusion.evaluate(lastInd, calib);
recorder.end();

fs.writeFileSync(path.join(OUT, 'session-demo.csv'), recorder.toCSV(), 'utf8');
fs.writeFileSync(
  path.join(OUT, 'session-demo.json'),
  JSON.stringify(recorder.toJSON(lastInd, lastFus, null), null, 2),
  'utf8'
);
console.log(`✓ session-demo.csv/json（${recorder.samples.length} 个采样点，${recorder.events.length} 个事件）`);

/* ==================== 2. 敏感性分析 CSV（5 参数合并，与导出格式一致） ==================== */
{
  const rows = [['参数名', '取值', '是否当前默认值(1=是)', '会话结论', '平均疲劳指数', '峰值疲劳指数', '疲劳时间占比', '重度时间占比', '等级跃迁次数']];
  for (const key of Object.keys(SENSITIVITY_PARAMS)) {
    const r = runSensitivity(recorder.samples, key);
    if (r.error) throw new Error(r.error);
    for (const x of r.rows) {
      rows.push([
        r.label,
        x.value,
        x.isCurrent ? 1 : 0,
        LEVEL_LABEL[x.worstLevel] || x.worstLevel,
        Number(x.avgScore.toFixed(2)),
        Number(x.peakScore.toFixed(2)),
        Number(x.fatigueRatio.toFixed(4)),
        Number(x.ratios.severe.toFixed(4)),
        x.alarms,
      ]);
    }
  }
  const csv = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  fs.writeFileSync(path.join(OUT, 'sensitivity-demo.csv'), csv, 'utf8');
  console.log(`✓ sensitivity-demo.csv（${rows.length - 1} 行）`);
}

/* ==================== 3. 权重消融 CSV ==================== */
{
  const r = runAblation(recorder.samples);
  if (r.error) throw new Error(r.error);
  const rows = [['被扣除的指标', '原权重', '平均疲劳指数', '平均指数变化量', '峰值疲劳指数', '疲劳时间占比', '疲劳占比变化量', '会话结论']];
  rows.push([
    '完整模型(基线)',
    '',
    Number(r.base.avgScore.toFixed(2)),
    0,
    Number(r.base.peakScore.toFixed(2)),
    Number((1 - r.base.ratios.awake).toFixed(4)),
    0,
    LEVEL_LABEL[r.base.worstLevel] || r.base.worstLevel,
  ]);
  for (const x of r.rows) {
    rows.push([
      x.label,
      x.weight,
      Number(x.avgScore.toFixed(2)),
      Number(x.deltaAvg.toFixed(2)),
      Number(x.peakScore.toFixed(2)),
      Number(x.fatigueRatio.toFixed(4)),
      Number(x.deltaFatigueRatio.toFixed(4)),
      LEVEL_LABEL[x.worstLevel] || x.worstLevel,
    ]);
  }
  const csv = '\ufeff' + rows.map((r2) => r2.map(csvCell).join(',')).join('\r\n');
  fs.writeFileSync(path.join(OUT, 'ablation-demo.csv'), csv, 'utf8');
  console.log(`✓ ablation-demo.csv（${rows.length - 1} 行）`);
}

/* ==================== 4. 视频评测：合成标注 → 指标汇总 + 逐点 ==================== */
{
  // 重新跑一遍同样的剧本拿逐帧相位（SimulatedDriver 固定种子，完全可复现）
  const driver2 = new SimulatedDriver();
  const phases = []; // {ts, phase}
  for (let t = t0; t < t0 + DURATION_MS; t += 33) {
    driver2.frame(t);
    phases.push({ ts: t, phase: driver2.phaseName });
  }
  const phaseAtTs = (ts) => {
    let lo = 0;
    let hi = phases.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (phases[mid].ts <= ts) lo = mid;
      else hi = mid - 1;
    }
    return phases[lo].phase;
  };

  const pairs = [];
  const evalSamples = [];
  for (let i = 0; i < recorder.samples.length; i++) {
    const s = recorder.samples[i];
    const ts = (recorder.startedPerf || 0) + s.t;
    const truth = phaseAtTs(ts) === '清醒' ? 'normal' : 'fatigue';
    pairs.push({ truth, pred: s.level, weightMs: CONFIG.record.sampleIntervalMs });
    evalSamples.push({ ...s, truth, tsAbs: ts });
  }
  const metrics = computeMetrics(pairs, 'mild');

  // 指标汇总 CSV（与界面导出格式一致）
  const t = metrics.byTime;
  const c = metrics.byCount;
  const mt = metrics.matrixTimeMs;
  const rows = [['指标', '按时间加权', '按采样点计数']];
  const numOrBlank = (v) => (Number.isFinite(v) ? Number(v.toFixed(6)) : '');
  const add = (k, a, b) => rows.push([k, numOrBlank(a), numOrBlank(b)]);
  add('准确率 Accuracy', t.accuracy, c.accuracy);
  add('灵敏度/召回率 Sensitivity', t.sensitivity, c.sensitivity);
  add('特异度 Specificity', t.specificity, c.specificity);
  add('精确率 Precision', t.precision, c.precision);
  add('阴性预测值 NPV', t.npv, c.npv);
  add('F1 分数', t.f1, c.f1);
  add('平衡准确率 Balanced Accuracy', t.balancedAcc, c.balancedAcc);
  add('Youden J 指数', t.youdenJ, c.youdenJ);
  add("马修斯相关系数 MCC", t.mcc, c.mcc);
  add('误报率 FPR', t.fpr, c.fpr);
  add('漏报率 FNR', t.fnr, c.fnr);
  rows.push(['真阳例 TP（时间列为毫秒）', Math.round(mt.tp), metrics.matrix.tp]);
  rows.push(['真阴例 TN（时间列为毫秒）', Math.round(mt.tn), metrics.matrix.tn]);
  rows.push(['假阳例 FP（时间列为毫秒）', Math.round(mt.fp), metrics.matrix.fp]);
  rows.push(['假阴例 FN（时间列为毫秒）', Math.round(mt.fn), metrics.matrix.fn]);
  fs.writeFileSync(
    path.join(OUT, 'eval-metrics-demo.csv'),
    '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'),
    'utf8'
  );

  // 逐点数据 CSV
  const lines = [EVAL_SAMPLE_COLUMNS.map((col) => col.zh).map(csvCell).join(',')];
  for (const s of evalSamples) {
    const row = {
      tSec: Number(((s.tsAbs - t0) / 1000).toFixed(1)),
      truth: TRUTH_KEY_TO_ZH[s.truth],
      pred: LEVEL_KEY_TO_ZH[s.level] || s.level,
      score: s.score,
      raw: s.raw,
      perclos: s.perclos,
      perclosReady: s.perclosReady ? 1 : 0,
      maxClosureMs: s.maxClosureMs,
      currentClosureMs: s.currentClosureMs,
      blinkRate: s.blinkRate,
      avgBlinkMs: s.avgBlinkMs ?? '',
      yawnRate: s.yawnRate,
      nodRate: s.nodRate,
      headDevRatio: s.headDevRatio,
      ear: s.ear ?? '',
      mar: s.mar ?? '',
      pitch: s.pitch ?? '',
      yaw: s.yaw ?? '',
      facePresent: s.facePresent,
      dataValid: s.dataValid,
    };
    lines.push(EVAL_SAMPLE_COLUMNS.map((col) => csvCell(row[col.key])).join(','));
  }
  fs.writeFileSync(path.join(OUT, 'eval-points-demo.csv'), '\ufeff' + lines.join('\r\n'), 'utf8');
  console.log(`✓ eval-metrics-demo.csv / eval-points-demo.csv（合成标注，仅打通链路）`);
}

console.log('\n全部示例数据生成完毕 → tools/analysis/fixtures/');
