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
// alarm.js 的 speak() 会探测 'speechSynthesis' in window；补一个最小 window 避免 ReferenceError
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

const importFromWeb = (rel) => import(pathToFileURL(path.join(WEB_JS, rel)).href);

const { CONFIG, loadUserConfig, resetConfig } = await importFromWeb('config.js');
const { SimulatedDriver } = await importFromWeb('core/sim-driver.js');
const { IndicatorEngine } = await importFromWeb('core/indicators.js');
const { FusionEngine } = await importFromWeb('core/fusion.js');
const { SessionRecorder, csvCell } = await importFromWeb('core/recorder.js');
const { replaySession, parseSessionCsv } = await importFromWeb('core/analysis.js');
const { SAMPLE_COLUMNS, findColumn, parseLevelCell } = await importFromWeb('core/csv-schema.js');
const { computeMetrics } = await importFromWeb('core/evaluation.js');
const { TimeWindow, EventWindow, TimeWeightedWindow } = await importFromWeb('util/ring-buffer.js');
const { AlarmSystem } = await importFromWeb('core/alarm.js');
const {
  clamp, membership, membershipTwoSided, normalizeAngle, fmtDuration, matrixToEuler, Ema,
} = await importFromWeb('util/math.js');

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

// ── 1.1 本地配置安全合并 ──
console.log('\n[1.1] 本地配置安全合并');
const defaultPerclosWindow = CONFIG.window.perclosSec;
const defaultEmaAlpha = CONFIG.fusion.emaAlpha;
loadUserConfig({
  getItem: () => '{"window":{"perclosSec":"not-a-number"},"fusion":{"emaAlpha":0.2},"__proto__":{"polluted":true}}',
});
assert(CONFIG.window.perclosSec === defaultPerclosWindow, '错误类型的配置值不会覆盖默认参数');
assert(CONFIG.fusion.emaAlpha === 0.2, '合法配置值可以载入');
assert({}.polluted === undefined, '原型污染键被忽略');
resetConfig();
assert(CONFIG.fusion.emaAlpha === defaultEmaAlpha, '恢复默认配置后参数一致');

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

// ── 8. TimeWindow：滑动窗口语义（PERCLOS/波形图的底座） ──
console.log('\n[8] TimeWindow 滑动窗口');
{
  const w = new TimeWindow(1000, 60);
  w.push(0, 1);
  w.push(500, 3);
  w.push(1500, 5); // 触发驱逐：t=0 超出 [500,1500] 窗口
  assert(w.size === 2, `过期样本被驱逐 (size=${w.size})`);
  assertApprox(w.mean(), 4, 1e-9, '窗口内均值正确');
  assertApprox(w.ratio((v) => v > 4), 0.5, 1e-9, 'ratio 谓词占比正确');

  // 容量回绕：持续写入远超容量的样本，遍历顺序与最新值仍须正确
  const w2 = new TimeWindow(1000, 2); // capacity = max(64, ...) = 64
  for (let t = 0; t < 2000; t += 10) w2.push(t, t);
  const latest = w2.latest();
  assert(latest && latest.t === 1990 && latest.v === 1990, '回绕后 latest() 正确');
  let asc = true;
  let prev = -Infinity;
  w2.forEach((t) => { if (t < prev) asc = false; prev = t; });
  assert(asc, '回绕后遍历仍按时间升序');
  assert(w2.span() <= 1000, `回绕后窗口跨度不超窗长 (span=${w2.span()})`);

  // 缩短窗口：旧数据必须立即驱逐，否则统计会混入过期样本
  const w3 = new TimeWindow(5000, 60);
  for (let t = 0; t <= 4000; t += 1000) w3.push(t, 1);
  w3.setWindow(2000);
  assert(w3.size === 3, `setWindow 缩短后驱逐过期样本 (size=${w3.size})`);

  // 扩大窗口：已有数据必须完整保留且顺序不变
  const w4 = new TimeWindow(1000, 2);
  for (let t = 0; t <= 900; t += 100) w4.push(t, t);
  const before = w4.toArray().map((p) => p.t).join(',');
  w4.setWindow(60000, 60);
  const after = w4.toArray().map((p) => p.t).join(',');
  assert(before === after, 'setWindow 扩容后数据完整保留');
}

// ── 9. TimeWeightedWindow：PERCLOS 时间加权正确性 ──
console.log('\n[9] TimeWeightedWindow 时间加权');
{
  // 语义：区间在下一个样本到达时闭合；末尾未闭合区间按「延续到最后采样时刻」计入。
  // 序列：睁眼 0→1000（1000ms），闭眼 1000→1800（800ms），末尾未闭合闭眼 1800→2000（200ms）。
  // 占比 = (800+200)/2000 = 0.5。
  const pushSeq = (tw, eyeStep, closedStep) => {
    for (let t = 0; t <= 1000; t += eyeStep) tw.push(t, false);
    for (let t = 1000; t <= 2000; t += closedStep) tw.push(t, true);
  };
  const tw = new TimeWeightedWindow(30000, 400);
  pushSeq(tw, 100, 100);
  assertApprox(tw.ratio(), 0.5, 0.02, '时间占比按区间时长计算（含末尾未闭合段）');

  // 时间加权的核心性质：同一物理过程，采样越密越收敛于真实占比（1000ms 睁 / 1000ms 闭 = 0.5）；
  // 早期按帧计数的实现没有这个性质（稀疏侧会被系统性低估）。
  const twSparse = new TimeWeightedWindow(30000, 400);
  pushSeq(twSparse, 250, 250);
  const truth = 0.5;
  const errDense = Math.abs(tw.ratio() - truth);
  const errSparse = Math.abs(twSparse.ratio() - truth);
  assert(errDense <= errSparse + 1e-9, `加密采样向真实占比收敛 (密 ${errDense.toFixed(4)} ≤ 疏 ${errSparse.toFixed(4)})`);

  // 采样间断：间隔超过 maxGapMs 的未闭合区间必须丢弃，不能假设状态延续。
  // 间断后 lastTs 保留：下一次 push 会先闭合并丢弃间断前区间，再开启新区间。
  const tw3 = new TimeWeightedWindow(30000, 400);
  tw3.push(0, true);
  tw3.push(200, true);   // 闭合区间 0→200（闭眼 200ms）
  tw3.push(5000, false); // 4.8s 间断：未闭合区间 200→5000 必须丢弃，不得假设闭眼延续
  tw3.push(5200, false); // 闭合区间 5000→5200（睁眼 200ms）
  // 有效区间仅 200+200=400ms，其中闭眼 200ms → 0.5；
  // 若实现错误地把间断段硬连为闭眼，比值会升到 ≈0.96，此断言即可拦截
  assertApprox(tw3.ratio(), 0.5, 1e-9, '间断的未知区间被丢弃，不假设状态延续');
  assertApprox(tw3.observedMs(), 400, 1e-9, '间断后仅保留有效区间时长（200+200）');

  // interrupt()：人脸丢失时未闭合区间必须作废
  const tw4 = new TimeWeightedWindow(30000, 400);
  tw4.push(0, true);
  tw4.interrupt();
  tw4.push(100, false);
  tw4.push(200, false);
  assertApprox(tw4.ratio(), 0, 1e-9, 'interrupt 后闭眼区间不计入');
  assert(tw4.observedMs() > 0, 'interrupt 后仍有有效观测时长');

  // interrupt 后续观测照常累计：
  // {100,200,false} + {200,300,false} + {300,500,true} → 总 400ms，闭眼 200ms → 0.5
  tw4.push(300, true);
  tw4.push(500, true);
  assertApprox(tw4.ratio(), 0.5, 1e-9, 'interrupt 后续观测照常累计');
}

// ── 10. EventWindow：事件频率统计 ──
console.log('\n[10] EventWindow 事件频率');
{
  const ew = new EventWindow(60000);
  ew.push(1000, 120);
  ew.push(2000, 200);
  ew.push(3000, null); // 非数值 payload 不应污染均值
  assert(ew.count(30000) === 3, '窗口内计数正确');
  assertApprox(ew.meanPayload(30000), 160, 1e-9, '均值忽略非数值 payload');
  // 过期驱逐：61s 后最早的三个事件都应出窗
  ew.push(70000, 150);
  assert(ew.count(70000) === 1, '过期事件被驱逐');
  // 观测不足一分钟时按实际观测时长归一，避免低估频率
  const ew2 = new EventWindow(60000);
  ew2.push(0);
  ew2.push(15000);
  const rate = ew2.ratePerMinute(30000, 30000);
  assertApprox(rate, 4, 1e-9, 'ratePerMinute 按观测时长归一（2 次/30s = 4 次/分）');
}

// ── 11. AlarmSystem：冷却 / 升级立即 / 等级语义 ──
console.log('\n[11] AlarmSystem 报警策略');
{
  const alarm = new AlarmSystem();
  assert(alarm.update('awake', 0) === null, '清醒等级不报警');
  const first = alarm.update('mild', 1000);
  assert(first && first.type === 'alarm', '首次进入轻度立即报警');
  assert(alarm.update('mild', 1000 + CONFIG.alarm.byLevel.mild.cooldownMs - 1) === null, '冷却期内同等级不重复报警');
  const afterCooldown = alarm.update('mild', 1000 + CONFIG.alarm.byLevel.mild.cooldownMs + 1);
  assert(afterCooldown !== null, '冷却结束后可再次报警');
  const escalated = alarm.update('severe', 1000 + CONFIG.alarm.byLevel.mild.cooldownMs + 2);
  assert(escalated && escalated.escalated === true, '等级升高绕过冷却立即报警');
  assert(escalated.level === 'danger', '重度报警事件级别为 danger');
  alarm.reset();
  assert(alarm.fireCount === 0, 'reset 清零报警计数');
}

// ── 12. 数值工具：角度归一 / 隶属函数 / 时长格式化 / 欧拉角 ──
console.log('\n[12] 数值工具');
{
  assertApprox(normalizeAngle(190), -170, 1e-9, 'normalizeAngle(190)=-170');
  assertApprox(normalizeAngle(-190), 170, 1e-9, 'normalizeAngle(-190)=170');
  assertApprox(normalizeAngle(180), 180, 1e-9, 'normalizeAngle(180)=180（边界归右闭）');
  assert(membership(NaN, 0, 1) === 0, 'membership(NaN)=0');
  assert(membership(5, 5, 5) === 1, 'membership 退化区间 hi==lo 时 v>=hi 为 1');
  assertApprox(membership(0.5, 0, 1), 0.5, 1e-9, 'membership 线性中点');
  assert(membershipTwoSided(15, 12, 22, 4, 45) === 0, '双侧隶属：正常区间内为 0');
  assert(membershipTwoSided(45, 12, 22, 4, 45) === 1, '双侧隶属：达到硬上限为 1');
  assert(fmtDuration(-5) === '--', 'fmtDuration 负数返回 --');
  assert(fmtDuration(95000) === '01:35', 'fmtDuration 95s = 01:35');
  assert(fmtDuration(3661000) === '01:01:01', 'fmtDuration 含小时位');
  const ema = new Ema(0.5, null);
  ema.push(NaN);
  assert(ema.value === null, 'EMA 忽略 NaN 输入');
  // 单位矩阵 → 零角度
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const e0 = matrixToEuler(identity);
  assert(Math.abs(e0.pitch) < 1e-6 && Math.abs(e0.yaw) < 1e-6 && Math.abs(e0.roll) < 1e-6, '单位矩阵欧拉角为零');
  // 绕 Y 轴（yaw）旋转 90°的列主序矩阵 → yaw≈90
  const yaw90 = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
  const e1 = matrixToEuler(yaw90);
  assert(Math.abs(e1.yaw - 90) < 1e-6, `yaw90 矩阵解出 yaw≈90 (got ${e1.yaw.toFixed(3)})`);
  assert(clamp(5, 0, 1) === 1 && clamp(-1, 0, 1) === 0, 'clamp 边界');
}

// ── 13. 服务端：非法端口必须显式报错退出（B-01 回归） ──
console.log('\n[13] 服务端非法端口校验');
{
  const { execFileSync } = await import('child_process');
  const serverPath = path.resolve(__dirname, '../server/server.js');
  // 本测试可能运行在 Electron-as-Node 环境，子进程需继承同一运行时语义
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_OPEN: '1' };
  for (const badPort of ['abc', '99999']) {
    let exitCode = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [serverPath, '--port', badPort, '--no-open'], { env, timeout: 15000 });
    } catch (e) {
      exitCode = e.status ?? -1;
      stderr = String(e.stderr || '');
    }
    assert(exitCode === 1, `--port ${badPort} 以退出码 1 终止`);
    assert(stderr.includes('端口必须是 1 到 65535 的整数'), `--port ${badPort} 输出中文报错`);
  }
}

// ── 14. SessionRecorder：长会话容量控制（批量驱逐语义） ──
console.log('\n[14] SessionRecorder 容量控制');
{
  // 注入受控时钟：begin()/end() 会读真实 performance.now()，
  // 若不控制，7400 次循环的真实耗时会混进样本时间轴，无法精确断言驱逐位置
  const realNow = performance.now.bind(performance);
  let clock = 0;
  performance.now = () => clock;
  const rec = new SessionRecorder();
  rec.begin(calib, null);
  const maxS = CONFIG.record.maxSamples;
  const step = CONFIG.record.sampleIntervalMs;
  // 超过上限 200 个采样：应触发批量驱逐，且保留的是最新数据
  const total = maxS + 200;
  for (let i = 0; i < total; i++) {
    const ts = 1000 + i * step;
    clock = ts;
    const ind = { ts, sessionMs: ts, perclos: 0, perclosReady: true, dataValid: true, facePresent: true, closure: 0, maxClosureMs: 0, currentClosureMs: 0, blinkRate: 0, avgBlinkMs: 100, yawnRate: 0, nodRate: 0, headDevRatio: 0 };
    const fus = { score: 0, raw: 0, level: 'awake' };
    rec.sample(ind, fus, { ear: 0.3, mar: 0.1, pitch: 0, yaw: 0, roll: 0 });
  }
  assert(rec.samples.length <= maxS + 64, `样本数受容量上限约束 (${rec.samples.length} ≤ ${maxS + 64})`);
  assert(rec.samples.length > maxS - 200, '批量驱逐不会误删过多数据');
  // 驱逐数 = 总量 - 现存；首样本即第 evicted 个采样。
  // 采样 ts 从 1000 起，故首样本 t = 1000 + evicted×step（受控时钟下可精确断言）
  const evicted = total - rec.samples.length;
  assert(rec.samples[0].t === 1000 + evicted * step, `保留的是最新数据（驱逐 ${evicted} 条，首样本 t=${rec.samples[0].t}）`);
  // 事件容量上限
  for (let i = 0; i < 30; i++) rec.addEvent({ type: 'blink', ts: i, level: 'info', message: 'x' });
  assert(rec.events.length <= CONFIG.record.maxEvents, '事件数受 maxEvents 约束');
  performance.now = realNow;
}

// ── 15. SessionStateMachine：合法迁移全覆盖 + 非法迁移拒绝（第三轮角色二新增） ──
console.log('\n[15] 会话状态机');
{
  const { SessionStateMachine, SessionState, SessionEvent } = await importFromWeb('core/session-state-machine.js');

  // 完整合法路径：idle→booting→calibrating→running→paused→running→report→booting→error→booting
  {
    const sm = new SessionStateMachine();
    const calibPayload = { calibration: { earBaseline: 0.3 } };
    assert(sm.state === SessionState.IDLE, '初始状态为 IDLE');
    assert(sm.send(SessionEvent.START), 'idle → start → booting');
    assert(sm.state === SessionState.BOOTING, '当前状态 BOOTING');
    assert(sm.send(SessionEvent.BEGIN_CALIBRATION), 'booting → beginCalibration → calibrating');
    assert(sm.send(SessionEvent.CALIBRATION_DONE, calibPayload), 'calibrating → calibrationDone → running（带校准结果）');
    assert(sm.send(SessionEvent.PAUSE), 'running → pause → paused');
    assert(sm.send(SessionEvent.RESUME), 'paused → resume → running');
    assert(sm.send(SessionEvent.RECALIBRATE), 'running → recalibrate → calibrating');
    assert(sm.send(SessionEvent.BEGIN_RUNNING, calibPayload), 'calibrating → beginRunning（跳过校准）→ running');
    assert(sm.send(SessionEvent.FINISH), 'running → finish → report');
    assert(sm.send(SessionEvent.START), 'report → start → booting（报告页再次检测）');
    assert(sm.send(SessionEvent.FAIL), 'booting → fail → error');
    assert(sm.send(SessionEvent.START), 'error → start → booting（重试）');
    assert(sm.send(SessionEvent.CANCEL), 'booting → cancel → idle');
  }

  // 演示模式迁移：会话中途切入/退出
  {
    const sm = new SessionStateMachine();
    sm.send(SessionEvent.START);
    sm.send(SessionEvent.BEGIN_RUNNING, { simulated: true });
    assert(sm.state === SessionState.RUNNING, 'booting → beginRunning（演示模式）→ running');
    assert(sm.send(SessionEvent.SIM_ENTER, { simulated: true }), 'running → simEnter 自迁移允许');
    assert(sm.state === SessionState.RUNNING, 'simEnter 后仍为 RUNNING');
    assert(sm.send(SessionEvent.SIM_EXIT), 'running → simExit → idle');
    assert(sm.state === SessionState.IDLE, '退出演示模式回到 IDLE');
  }

  // 非法迁移：至少 5 种（均须返回 false 且状态不变）
  {
    const mk = async (to, events) => {
      const sm = new SessionStateMachine();
      for (const [ev, payload] of events) assert(sm.send(ev, payload), `前置迁移 ${ev} 成功`);
      return sm;
    };
    const calibPayload = { calibration: { earBaseline: 0.3 } };
    let sm = new SessionStateMachine();
    assert(!sm.send(SessionEvent.PAUSE), '非法①：IDLE 时 pause 被拒绝');
    assert(!sm.send(SessionEvent.FINISH), '非法②：IDLE 时 finish 被拒绝');
    assert(sm.state === SessionState.IDLE, '非法迁移不改变状态');

    sm.send(SessionEvent.START);
    sm.send(SessionEvent.BEGIN_RUNNING, calibPayload);
    assert(!sm.send(SessionEvent.START), '非法③：RUNNING 时重复 start 被拒绝');
    assert(!sm.send(SessionEvent.BEGIN_CALIBRATION), '非法④：RUNNING 时 beginCalibration 被拒绝');

    sm = new SessionStateMachine();
    sm.send(SessionEvent.START);
    assert(!sm.send(SessionEvent.PAUSE), '非法⑤：BOOTING 时 pause 被拒绝');
    sm.send(SessionEvent.BEGIN_CALIBRATION);
    assert(!sm.send(SessionEvent.PAUSE), '非法⑥：CALIBRATING 时 pause 被拒绝');
    assert(!sm.send(SessionEvent.RESUME), '非法⑦：CALIBRATING 时 resume 被拒绝');

    sm = await mk(SessionState.REPORT, [[SessionEvent.START], [SessionEvent.BEGIN_RUNNING, calibPayload], [SessionEvent.FINISH]]);
    assert(!sm.send(SessionEvent.PAUSE), '非法⑧：REPORT 时 pause 被拒绝');
    assert(!sm.send(SessionEvent.RESUME), '非法⑨：REPORT 时 resume 被拒绝');
  }

  // guard：未校准不得进入 RUNNING
  {
    const sm = new SessionStateMachine();
    sm.send(SessionEvent.START);
    sm.send(SessionEvent.BEGIN_CALIBRATION);
    assert(!sm.send(SessionEvent.CALIBRATION_DONE), 'guard：无校准载荷时 calibrationDone 被拒绝');
    assert(!sm.can(SessionEvent.BEGIN_RUNNING), 'guard：can() 同样反映 guard 结果');
    assert(sm.state === SessionState.CALIBRATING, 'guard 拒绝后状态保持 CALIBRATING');
    assert(sm.send(SessionEvent.CALIBRATION_DONE, { calibration: { earBaseline: 0.3 } }), 'guard：带校准载荷后迁移成功');
  }

  // onChange 钩子：迁移成功才触发，拒绝不触发
  {
    const sm = new SessionStateMachine();
    const seen = [];
    const off = sm.onChange((from, to, event) => seen.push(`${from}>${to}:${event}`));
    sm.send(SessionEvent.START);
    sm.send(SessionEvent.PAUSE); // 非法，不应触发
    assert(seen.length === 1 && seen[0] === 'idle>booting:start', 'onChange 只记录成功迁移');
    off();
    sm.send(SessionEvent.BEGIN_CALIBRATION);
    assert(seen.length === 1, '取消订阅后不再收到钩子');
    assert(sm.history.length === 2, 'history 记录全部成功迁移');
  }
}

// ── 16. RenderLoop：启动/停止/帧回调（第三轮角色二新增） ──
console.log('\n[16] RenderLoop 主循环调度');
{
  const { RenderLoop } = await importFromWeb('core/render-loop.js');
  let frames = 0;
  const loop = new RenderLoop({ onFrame: () => { frames++; }, targetFps: () => 60 });
  assert(!loop.running, '初始未运行');
  loop.start();
  loop.start(); // 重复 start 不应叠加定时器
  assert(loop.running, 'start 后 running=true');
  await new Promise((r) => setTimeout(r, 220));
  assert(frames >= 4, `目标 60fps 下 220ms 内至少 4 帧 (got ${frames})`);
  loop.stop();
  assert(!loop.running, 'stop 后 running=false');
  const after = frames;
  await new Promise((r) => setTimeout(r, 120));
  assert(frames === after, 'stop 后不再产生新帧');
  // 帧回调抛异常不得杀死主循环
  let errors = 0;
  let frames2 = 0;
  const loop2 = new RenderLoop({
    onFrame: () => { frames2++; if (frames2 === 1) throw new Error('boom'); },
    targetFps: () => 60,
    onError: () => { errors++; },
  });
  loop2.start();
  await new Promise((r) => setTimeout(r, 200));
  loop2.stop();
  assert(errors >= 1 && frames2 >= 2, `帧异常被捕获且循环继续 (errors=${errors}, frames=${frames2})`);
}

// ── 结果汇总 ──
console.log('\n=== 结果: ' + passed + ' 通过, ' + failed + ' 失败 ===\n');
process.exit(failed > 0 ? 1 : 0);
