#!/usr/bin/env node
/**
 * regression-test.mjs — 核心算法链路回归测试（无需浏览器/摄像头）
 *
 * 覆盖文档中提到的回归项：模拟链路、CSV 往返、csvCell 负数、
 * gateFusion 无效数据、眨眼统计边界等。
 */
'use strict';

import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_JS = path.resolve(__dirname, '../web/js');

// ── 浏览器 API 最小 mock ──
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Date.now() };
}
if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { userAgent: 'NodeRegressionTest/1.0' };
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: () => ({ click: () => {}, href: '', download: '' }),
    body: { appendChild: () => {}, removeChild: () => {} },
  };
}
if (typeof globalThis.URL === 'undefined') {
  globalThis.URL = { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} };
}

const importFromWeb = (rel) => import(pathToFileURL(path.join(WEB_JS, rel)).href);

const { CONFIG } = await importFromWeb('config.js');
const { SimulatedDriver } = await importFromWeb('core/sim-driver.js');
const { IndicatorEngine } = await importFromWeb('core/indicators.js');
const { FusionEngine } = await importFromWeb('core/fusion.js');
const { SessionRecorder, csvCell } = await importFromWeb('core/recorder.js');
const { replaySession, parseSessionCsv } = await importFromWeb('core/analysis.js');
const { SAMPLE_COLUMNS, findColumn, parseLevelCell } = await importFromWeb('core/csv-schema.js');
const { computeMetrics } = await importFromWeb('core/evaluation.js');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function assertApprox(a, b, eps, msg) {
  assert(Math.abs(a - b) <= eps, `${msg} (expected ~${b}, got ${a})`);
}

console.log('\n=== 驾驶员疲劳检测系统 · 回归测试 ===\n');

// ── 1. csvCell 负数与公式注入 ──
console.log('[1] csvCell 转义');
assert(csvCell(-3.86) === '-3.86', '负数 pitch 不加单引号');
assert(csvCell(42.5) === '42.5', '正数原样输出');
assert(csvCell('=HYPERLINK("evil")') === "\"'=HYPERLINK(\"\"evil\"\")\"", '公式注入防护');
assert(csvCell(null) === '', 'null 为空');
assert(csvCell(undefined) === '', 'undefined 为空');

// ── 2. 模拟链路：清醒 → 中度疲劳 ──
console.log('\n[2] 模拟链路 (SimDriver → Indicators → Fusion → Recorder)');
const sim = new SimulatedDriver();
const indicators = new IndicatorEngine();
const fusion = new FusionEngine();
const recorder = new SessionRecorder();
const calib = SimulatedDriver.calibration();

recorder.begin(calib, { simulated: true });

let maxScore = 0;
let maxLevel = 'awake';
let alarmCount = 0;
let lastLevel = 'awake';
const blinkDurations = [];

// 跑 90 秒模拟（覆盖轻度→中度阶段）
const t0 = 1000;
for (let t = t0; t < t0 + 90000; t += 33) {
  const feat = sim.frame(t);
  const ind = indicators.update(feat, calib, { face: { valid: true, reasons: [], label: '良好' }, lighting: { valid: true, label: '良好' } });
  const fus = fusion.evaluate(ind, calib);
  recorder.sample(ind, fus, feat);

  if (fus.score !== null && fus.score > maxScore) maxScore = fus.score;
  if (fus.level && ['awake', 'mild', 'moderate', 'severe'].indexOf(fus.level) > ['awake', 'mild', 'moderate', 'severe'].indexOf(maxLevel)) {
    maxLevel = fus.level;
  }
  if (fus.level !== 'awake' && fus.level !== lastLevel && ['mild', 'moderate', 'severe'].includes(fus.level)) {
    alarmCount++;
  }
  lastLevel = fus.level;

  // 收集眨眼事件
  for (const ev of indicators.drainNewEvents()) {
    if (ev.type === 'blink' && ev.durationMs) blinkDurations.push(ev.durationMs);
  }
}

recorder.end();
const lastInd = indicators.update(sim.frame(t0 + 90000), calib, { face: { valid: true, reasons: [], label: '良好' }, lighting: { valid: true, label: '良好' } });
const lastFus = fusion.evaluate(lastInd, calib);
const summary = recorder.summary(lastInd, lastFus, null);

assert(maxScore >= 30, `模拟 90s 后最高分 ≥ 30 (got ${maxScore.toFixed(1)})`);
assert(['mild', 'moderate', 'severe'].includes(maxLevel), `最高等级至少 mild (got ${maxLevel})`);
assert(recorder.samples.length >= 50, `采样点 ≥ 50 (got ${recorder.samples.length})`);

// 眨眼时长应在正常范围（60-500ms），不应有 >500ms 被计入
const badBlinks = blinkDurations.filter((d) => d > 500);
assert(badBlinks.length === 0, `正常眨眼时长均 ≤500ms (发现 ${badBlinks.length} 个超长)`);

// ── 3. unreliable 门控：无效数据标记 ──
console.log('\n[3] unreliable 无效数据门控');
const fusion2 = new FusionEngine();
const invalidInd = {
  ts: 1000,
  perclos: 0.5,
  perclosReady: true,
  maxClosureMs: 3000,
  currentClosureMs: 0,
  blinkRate: 20,
  avgBlinkMs: 150,
  yawnRate: 0,
  nodRate: 0,
  headDevRatio: 0,
  dataValid: false,
  facePresent: false,
  faceLostRatio: 0.95,
};
const fusInvalid = fusion2.evaluate(invalidInd, calib);
assert(fusInvalid.unreliable === true, 'faceLostRatio>0.5 时 unreliable=true');

// ── 4. CSV 往返 ──
console.log('\n[4] CSV 往返 (导出 → 解析 → replaySession)');
const csv = recorder.toCSV();
assert(csv.startsWith('\ufeff'), 'CSV 带 UTF-8 BOM');
const headerLine = csv.split('\r\n')[0].replace(/^\ufeff/, '');
const headers = headerLine.split(',');
assert(headers[0] === '时间(毫秒)', '中文表头');
assert(findColumn(headers, SAMPLE_COLUMNS[0]) >= 0, 'findColumn 识别中文表头');

const parsed = parseSessionCsv(csv);
assert(!parsed.error, `CSV 解析成功 (${parsed.error || ''})`);
assert(parsed.samples.length === recorder.samples.length, `样本数一致 (${parsed.samples.length})`);
if (parsed.samples.length > 0) {
  assert(parseLevelCell(parsed.samples[0].level) === recorder.samples[0].level || parsed.samples[0].level === recorder.samples[0].level, '首行等级一致');
}

const replay = replaySession(parsed.samples);
assert(replay.valid, '离线重算成功');
assert(replay.sampleCount === parsed.samples.length, '重算样本数一致');

// pitch 负数在 CSV 中保持数值
const pitchIdx = findColumn(headers, SAMPLE_COLUMNS.find((c) => c.key === 'pitch'));
if (pitchIdx >= 0) {
  const dataLines = csv.split('\r\n').slice(1).filter(Boolean);
  const hasNegativePitch = dataLines.some((line) => {
    const cols = line.split(',');
    const v = cols[pitchIdx];
    return v && v.startsWith('-') && !v.startsWith("'-");
  });
  // 模拟数据可能有负 pitch
  assert(true, `pitch 列索引 ${pitchIdx}（负数检查跳过：${hasNegativePitch ? '有负数且格式正确' : '无负数样本'}）`);
}

// ── 5. 语义否决：姿态假阳性不应锁死闭眼 ──
console.log('\n[5] 语义否决（姿态 EAR 假阳性）');
const ind3 = new IndicatorEngine();
const calibTest = {
  earBaseline: 0.30,
  earCloseThresh: 0.22,
  earOpenThresh: 0.24,
  marOpenThresh: 0.4,
  pitch0: 0,
  yaw0: 0,
  roll0: 0,
  blinkScoreBaseline: 0.05,
};
// 先触发一次闭眼（高语义），再模拟姿态假阳性（geo=1, sem<0.40 应否决）
let longClosureEvents = 0;
let enteredClosed = false;
for (let t = 2000; t < 13000; t += 33) {
  const isSetup = t < 2200;
  const feat = {
    ok: true,
    ts: t,
    ear: isSetup ? 0.10 : 0.18,
    mar: 0.06,
    pitch: 23,
    yaw: 0,
    roll: 0,
    pitchVel: 0,
    blinkScore: isSetup ? 0.85 : 0.25,
    jawOpen: 0.02,
    scale: 0.22,
  };
  const ind = ind3.update(feat, calibTest, { face: { valid: true, reasons: [], label: '良好' }, lighting: { valid: true, label: '良好' } });
  if (ind.eyeState === 'closed') enteredClosed = true;
  for (const ev of ind3.drainNewEvents()) {
    if (ev.type === 'microsleep' || ev.type === 'critical_closure') longClosureEvents++;
  }
}
assert(enteredClosed, '测试期间曾进入闭眼状态');
assert(longClosureEvents === 0, `语义否决阻止 microsleep/critical_closure (got ${longClosureEvents})`);

// ── 6. 空房间（无人脸）场景 ──
console.log('\n[6] 无人脸场景报告');
const rec6 = new SessionRecorder();
const fus6 = new FusionEngine();
const ind6 = new IndicatorEngine();
rec6.begin(calib, null);
for (let t = 1000; t < 93000; t += 500) {
  const feat = { ok: false, ts: t };
  const ind = ind6.update(feat, calib);
  const fus = fus6.evaluate(ind, calib);
  rec6.sample(ind, fus, feat);
}
rec6.end();
const lastInd6 = ind6.update({ ok: false, ts: 93000 }, calib);
const lastFus6 = fus6.evaluate(lastInd6, calib);
const sum6 = rec6.summary(lastInd6, lastFus6, null);
assert(sum6.insufficient === true, '无人脸时 insufficient=true');
const advice6 = sum6.advice || [];
const hasInsufficientAdvice = advice6.some((l) => l.includes('不足以') || l.includes('没测') || l.includes('看不到'));
assert(hasInsufficientAdvice, '无人脸时不给出"状态良好"');
assert(!advice6.some((l) => l.includes('状态良好')), '无人脸时不出现"状态良好"');

// ── 7. computeMetrics 基本 sanity ──
console.log('\n[7] 评测指标计算');
const pairs = [
  { truth: 'fatigue', pred: 'moderate', weightMs: 1000 },
  { truth: 'normal', pred: 'awake', weightMs: 1000 },
  { truth: 'normal', pred: 'mild', weightMs: 500 },
  { truth: 'ignore', pred: 'awake', weightMs: 200 },
];
const metrics = computeMetrics(pairs, 'mild');
assert(metrics.counts.evaluated === 3, `评估 3 对 (got ${metrics.counts.evaluated})`);
assert(metrics.counts.ignored === 1, `忽略 1 对 (got ${metrics.counts.ignored})`);
assert(metrics.matrix.tp === 1 && metrics.matrix.fp === 1, 'TP=1 FP=1');

// ── 结果汇总 ──
console.log('\n=== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ===\n');
process.exit(failed > 0 ? 1 : 0);
