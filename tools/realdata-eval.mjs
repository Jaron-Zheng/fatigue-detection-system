#!/usr/bin/env node
/**
 * realdata-eval.mjs — 真实数据回放评测与参数扫描（真实数据评测 · 第二步）
 *
 * 【定位】
 * 读取 realdata-collect.mjs 缓存的逐帧特征，在 Node 中回放与生产完全相同的
 * 指标层（indicators.js）与融合层（fusion.js）+ 质量门控 + 个性化标定，
 * 输出真实标注数据上的分类指标。推理只做一次（collect 阶段），
 * 参数扫描在回放侧进行——单次全量回放仅数秒，支持大规模网格寻优。
 *
 * 【评测口径】
 *   · NTHU-DDD：clip 级二分类。drowsy clip = 正类，notdrowsy clip = 负类。
 *     个性化标定取该被试 notdrowsy 片段的前 calibSec 秒（镜像生产流程：
 *     驾驶员清醒上车 → 标定 → 驾驶 → 状态演化）。
 *     clip 判定规则（可扫描）：
 *       peak   任意时刻等级 ≥ mild（"是否报警过"）
 *       ratioX 疲劳帧占比 ≥ X%（持续判定，主口径）
 *       mean   平均疲劳指数 ≥ mild 阈值
 *   · UTA-RLDD：帧级眼睛状态验证。alert 帧 vs drowsy 帧的闭合度 AUC
 *     （几何通道 / 语义通道 / 双通道融合三口径），验证双通道设计价值。
 *
 * 【防过拟合纪律】
 *   扫描寻优必须用 --subjects 限定被试子集（调优集），最终验证用封存的
 *   --subjects 余下被试（测试集）。被试级切分（而非 clip 级）杜绝同一人
 *   的数据同时出现在调优与测试两侧。
 *
 * 【用法】
 *   node tools/realdata-eval.mjs --cache <cache.json> --mode baseline
 *   node tools/realdata-eval.mjs --cache <cache.json> --mode fps
 *   node tools/realdata-eval.mjs --cache <cache.json> --mode framelevel
 *   node tools/realdata-eval.mjs --cache <cache.json> --mode sweep \
 *     --param calibration.earCloseRatio --values 0.66,0.72,0.78 \
 *     --subjects 001,003,005
 *   可选：--stepMs 33.333  --calibSec 5  --ratio 0.3  --tag 名称前缀
 *
 * 【产出】docs-evidence/figures/ 下：
 *   {tag}-nthu-rules.csv / {tag}-nthu-scenarios.csv / {tag}-nthu-subjects.csv /
 *   {tag}-nthu-clips.csv / {tag}-fps-estimate.csv / {tag}-uta-framelevel.csv /
 *   {tag}-sweep-{param}.csv
 *
 * 复现命令：见各模式输出首行。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_JS = path.resolve(__dirname, '../web/js');
const FIG_DIR = path.resolve(__dirname, '../docs-evidence/figures');

/* ── 浏览器 API 最小 mock（与 accuracy-eval.mjs 同口径） ── */
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Date.now() };
}
if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { userAgent: 'NodeRealDataEval/1.0' };
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
const { Calibrator, CalibState } = await importFromWeb('core/calibration.js');
const { IndicatorEngine } = await importFromWeb('core/indicators.js');
const { FusionEngine } = await importFromWeb('core/fusion.js');

/* ══════════════════ 命令行参数 ══════════════════ */
const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const MODE = get('--mode', 'baseline');
const DATA_DIR = get('--data-dir', 'D:\\fatigue-eval-data');
const ROOT = path.resolve(__dirname, '..');
// --cache 未指定时按模式取缓存文件名，查找顺序：
// 项目内 _eval-cache/（本地保存的完整特征缓存，首选，D 盘原始数据集
// 删除后仍可回放全部真实数据指标）→ {data-dir}\cache（collect 原始落点兜底）。
const CACHE_FILE = MODE === 'framelevel' ? 'uta-features.json' : 'nthu-features.json';
const DEFAULT_CACHE =
  [path.join(ROOT, '_eval-cache', CACHE_FILE), path.join(DATA_DIR, 'cache', CACHE_FILE)].find((p) =>
    fs.existsSync(p)
  ) || path.join(ROOT, '_eval-cache', CACHE_FILE);
const CACHE_PATH = path.resolve(get('--cache', DEFAULT_CACHE));
const STEP_MS = Number(get('--stepMs', '0')); // 0 = 用缓存 meta 里的 stepMs
const CALIB_SEC = Number(get('--calibSec', '5'));
const RATIO = Number(get('--ratio', '0.3')); // ratio 规则的疲劳占比阈值
const TAG = get('--tag', 'realdata');
const SWEEP_PARAM = get('--param', '');
const SWEEP_VALUES = get('--values', '') ? get('--values', '').split(',').map(Number) : [];
const SUBJECTS = get('--subjects', '') ? get('--subjects', '').split(',') : null;
/**
 * --set key=value：运行前的任意 CONFIG 补丁（可重复出现，支持组合实验）。
 * 形如 --set event.eyeCloseOn=0.75 --set fusion.weights.yawn=0.2
 */
const SET_PATCHES = args.filter((a) => a.startsWith('--set=')).map((a) => a.slice(6));
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--set' && i + 1 < args.length) SET_PATCHES.push(args[i + 1]);
}
for (const patch of SET_PATCHES) {
  const eq = patch.indexOf('=');
  if (eq <= 0) continue;
  const key = patch.slice(0, eq);
  const rawVal = patch.slice(eq + 1);
  const val = Number.isFinite(Number(rawVal)) && rawVal.trim() !== '' ? Number(rawVal) : rawVal;
  setConfigPath(key, val);
  console.log(`[patch] ${key} = ${val}`);
}

if (!fs.existsSync(CACHE_PATH)) {
  console.error(`缓存文件不存在：${CACHE_PATH}\n请先运行 realdata-collect.mjs 采集特征。`);
  process.exit(1);
}

console.log(`\n=== realdata-eval：${MODE} 模式 ===`);
console.log(`缓存：${CACHE_PATH}`);

const CACHE = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
const STEP = STEP_MS > 0 ? STEP_MS : CACHE.meta.stepMs;

/* ══════════════════ 配置补丁工具 ══════════════════ */
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
/** 按点分路径设置 CONFIG 值（sweep 用），levels 数组下标用 fusion.levels[0].max 形式 */
function setConfigPath(cfgPath, value) {
  const m = cfgPath.match(/^([\w.]+)\[(\d+)\]\.(\w+)$/);
  if (m) {
    const arr = m[1].split('.').reduce((o, k) => o[k], CONFIG);
    arr[Number(m[2])][m[3]] = value;
    return;
  }
  const keys = cfgPath.split('.');
  let obj = CONFIG;
  for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
  obj[keys[keys.length - 1]] = value;
}

/* ══════════════════ 回放核心 ══════════════════ */

/** 缓存帧 → FeatureSample（生产接口形状） */
function toFeat(f, stepMs) {
  if (!f.ok) return { ok: false, ts: Math.round(f.i * stepMs) };
  return {
    ok: true,
    ts: Math.round(f.i * stepMs),
    ear: f.ear ?? NaN,
    mar: f.mar ?? NaN,
    pitch: f.pitch ?? NaN,
    yaw: f.yaw ?? NaN,
    roll: f.roll ?? NaN,
    pitchVel: f.pitchVel ?? 0,
    blinkScore: f.blinkScore ?? NaN,
    jawOpen: f.jawOpen ?? NaN,
    scale: f.scale ?? NaN,
  };
}

/** 质量门控判定（复刻 quality.js 逻辑，基于缓存的原始量 fw/co） */
function qualityVerdict(f, calib) {
  if (!f.ok || f.fw == null || f.co == null) return null;
  const g = CONFIG.quality;
  const reasons = [];
  if (f.fw < g.minFaceWidthRatio) reasons.push('面部距离过远');
  if (f.fw > g.maxFaceWidthRatio) reasons.push('面部距离过近');
  if (f.co > g.maxCenterOffset) reasons.push('偏离画面中心');
  const dYaw = Math.abs((f.yaw ?? 0) - (calib ? calib.yaw0 : 0));
  const dRoll = Math.abs((f.roll ?? 0) - (calib ? calib.roll0 : 0));
  if (dYaw > g.maxYawDeg) reasons.push('头部侧转过大');
  if (dRoll > g.maxRollDeg) reasons.push('头部侧倾过大');
  return {
    face: { valid: reasons.length === 0, reasons, label: reasons.length ? '质量不足' : '良好' },
    lighting: { valid: true, label: '未评估' },
  };
}

/**
 * 用某片段跑生产标定器。
 * @param {Array} clipFrames 标定 clip 的缓存帧数组（i 需从 0 连续）
 * @param {number} calibSec 标定秒数
 * @param {number} stepMs 帧间隔
 * @param {number|null} minSamplesOverride 稀疏帧场景下放宽最少样本数
 */
function calibrateFrom(clipFrames, calibSec, stepMs, minSamplesOverride = null) {
  const savedDuration = CONFIG.calibration.durationSec;
  const savedMin = CONFIG.calibration.minSamples;
  const calibrator = new Calibrator();
  try {
    CONFIG.calibration.durationSec = calibSec;
    if (minSamplesOverride != null) CONFIG.calibration.minSamples = minSamplesOverride;
    calibrator.start(0);
    for (const f of clipFrames) {
      if (calibrator.feed(toFeat(f, stepMs), Math.round(f.i * stepMs))) break;
    }
    if (calibrator.state !== CalibState.DONE) calibrator._finish();
  } finally {
    CONFIG.calibration.durationSec = savedDuration;
    CONFIG.calibration.minSamples = savedMin;
  }
  if (!calibrator.result || !calibrator.result.ok) return calibrator.useFallback();
  return calibrator.result;
}

/** 选出被试的标定 clip（最长的 notdrowsy 片段）并完成标定 */
function calibrateSubject(clips) {
  const awake = clips.filter((c) => c.label === 'notdrowsy');
  if (!awake.length) return { calib: new Calibrator().useFallback(), ok: false };
  const clip = awake.reduce((a, b) => (b.frames.length > a.frames.length ? b : a));
  const calib = calibrateFrom(clip.frames, CALIB_SEC, STEP);
  return { calib, ok: !calib.skipped };
}

/** 回放单个 clip：完整指标层 + 融合层 */
function replayClip(frames, calib, stepMs) {
  const indicators = new IndicatorEngine();
  const fusion = new FusionEngine();
  const out = [];
  for (const f of frames) {
    const feat = toFeat(f, stepMs);
    const quality = qualityVerdict(f, calib);
    const ind = indicators.update(feat, calib, quality);
    const fus = fusion.evaluate(ind, calib);
    out.push({
      i: f.i,
      ok: f.ok,
      score: +fus.score.toFixed(2),
      level: fus.level,
      unreliable: !!fus.unreliable,
      perclos: Number.isFinite(ind.perclos) ? +ind.perclos.toFixed(4) : null,
      maxClosureMs: Math.round(ind.maxClosureMs || 0),
      closure: Number.isFinite(ind.closure) ? +ind.closure.toFixed(3) : null,
      qualityOk: quality ? quality.face.valid : null,
    });
  }
  const validFrames = out.filter((r) => r.ok && !r.unreliable);
  const mildPlus = validFrames.filter((r) => ['mild', 'moderate', 'severe'].includes(r.level));
  const ORDER = ['awake', 'mild', 'moderate', 'severe'];
  const summary = {
    nFrames: out.length,
    nFaceOk: out.filter((r) => r.ok).length,
    nValid: validFrames.length,
    peakScore: validFrames.reduce((m, r) => Math.max(m, r.score), 0),
    meanScore: validFrames.length ? +(validFrames.reduce((a, r) => a + r.score, 0) / validFrames.length).toFixed(2) : 0,
    fatigueRatio: validFrames.length ? +(mildPlus.length / validFrames.length).toFixed(4) : 0,
    peakLevel: validFrames.reduce((m, r) => (ORDER.indexOf(r.level) > ORDER.indexOf(m) ? r.level : m), 'awake'),
    finalLevel: validFrames.length ? validFrames[validFrames.length - 1].level : 'awake',
    peakPerclos: validFrames.reduce((m, r) => Math.max(m, r.perclos ?? 0), 0),
    peakClosureMs: validFrames.reduce((m, r) => Math.max(m, r.maxClosureMs), 0),
    durationSec: +((out.length * stepMs) / 1000).toFixed(1),
  };
  return { frames: out, summary };
}

/** clip 判定规则 → 二分类预测（true=疲劳） */
function classifyClip(summary, rule, ratio) {
  switch (rule) {
    case 'peak':
      return ['mild', 'moderate', 'severe'].includes(summary.peakLevel);
    case 'mean':
      return summary.meanScore >= CONFIG.fusion.levels[0].max;
    case 'ratio':
      return summary.fatigueRatio >= ratio;
    case 'final':
      return ['mild', 'moderate', 'severe'].includes(summary.finalLevel);
    default:
      return summary.fatigueRatio >= ratio;
  }
}

/** 二分类指标（clip 级） */
function clipMetrics(items) {
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  for (const it of items) {
    if (it.truth === 1 && it.pred === 1) tp++;
    else if (it.truth === 0 && it.pred === 1) fp++;
    else if (it.truth === 0 && it.pred === 0) tn++;
    else fn++;
  }
  const sens = tp + fn > 0 ? tp / (tp + fn) : NaN;
  const spec = tn + fp > 0 ? tn / (tn + fp) : NaN;
  const prec = tp + fp > 0 ? tp / (tp + fp) : NaN;
  const f1 = prec + sens > 0 ? (2 * prec * sens) / (prec + sens) : NaN;
  const den = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn));
  const mcc = den > 0 ? (tp * tn - fp * fn) / den : NaN;
  return {
    n: items.length,
    tp,
    fp,
    tn,
    fn,
    sensitivity: sens,
    specificity: spec,
    precision: prec,
    f1,
    mcc,
    balancedAcc: (sens + spec) / 2,
    accuracy: items.length ? (tp + tn) / items.length : NaN,
  };
}

function writeCsv(name, rows) {
  fs.mkdirSync(FIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(FIG_DIR, name), rows.map((r) => r.join(',')).join('\n') + '\n', 'utf8');
  console.log(`  已写入 figures/${name}`);
}

const fmt = (v, d = 4) => (Number.isFinite(v) ? v.toFixed(d) : '');

/** 秩和 AUC（正类得分应高于负类，并列取平均秩） */
function rankAuc(pos, neg) {
  if (!pos.length || !neg.length) return NaN;
  const all = [...pos.map((v) => ({ v, p: 1 })), ...neg.map((v) => ({ v, p: 0 }))].sort((a, b) => a.v - b.v);
  let i = 0;
  const ranks = new Array(all.length);
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }
  let rankSumPos = 0;
  for (let k = 0; k < all.length; k++) if (all[k].p === 1) rankSumPos += ranks[k];
  return (rankSumPos - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}

/* ══════════════════ 模式一：fps 标定 ══════════════════ */
/**
 * NTHU 帧的真实帧率未知（HF 上传者的抽取密度未注明）。
 * 用生理先验标定：清醒（notdrowsy）片段在正确时间尺度下应满足
 *   · 正常眨眼时长 100~400ms（blinkMinMs~blinkMaxMs 过滤后的中位时长）
 *   · 眨眼频率 10~28 次/分
 * 对候选 stepMs 逐一回放，得分最高者即为估计帧率。
 */
async function modeFps() {
  console.log(`\n=== 帧率标定：notdrowsy 片段眨眼参数 vs 候选 stepMs ===`);
  const candidates = [16.7, 33.3, 40, 50, 66.7, 100, 200];
  const rows = [
    [
      'stepMs',
      '等效帧率fps',
      '闭合段总数',
      '中位闭合时长ms',
      '眨眼数(60~500ms)',
      '微睡眠数(>500ms)',
      '眨眼频率次/分',
      '生理合理性得分',
    ],
  ];
  const subjects = Object.keys(CACHE.subjects).sort().slice(0, 6);
  console.log(`样本被试：${subjects.join(', ')}`);
  for (const stepMs of candidates) {
    let blinkCount = 0;
    let microsleeps = 0;
    let totalMs = 0;
    const durations = [];
    for (const s of subjects) {
      const clips = Object.values(CACHE.subjects[s].clips).filter((c) => c.label === 'notdrowsy');
      if (!clips.length) continue;
      const clip = clips.reduce((a, b) => (b.frames.length > a.frames.length ? b : a));
      const frames = clip.frames.slice(0, 900);
      const calibFrames = frames.slice(0, Math.max(30, Math.round((5 * 1000) / stepMs)));
      const calib = calibrateFrom(calibFrames, +((calibFrames.length * stepMs) / 1000).toFixed(3), stepMs, 10);
      const { frames: out } = replayClip(frames, calib, stepMs);
      // 闭眼段 = 连续 closure ≥ 0.8 的帧段（与 PERCLOS P80 判据同口径）
      let run = 0;
      const runs = [];
      for (const r of out) {
        if (r.ok && r.closure != null && r.closure >= 0.8) run++;
        else if (run > 0) {
          runs.push(run);
          run = 0;
        }
      }
      if (run > 0) runs.push(run);
      for (const n of runs) {
        const durMs = n * stepMs;
        if (durMs >= CONFIG.event.blinkMinMs && durMs <= CONFIG.event.blinkMaxMs) {
          blinkCount++;
          durations.push(durMs);
        } else if (durMs > CONFIG.event.microsleepMs) microsleeps++;
      }
      totalMs += out.length * stepMs;
    }
    durations.sort((a, b) => a - b);
    const medDur = durations.length ? durations[Math.floor(durations.length / 2)] : NaN;
    const rate = totalMs > 0 ? blinkCount / (totalMs / 60000) : NaN;
    let score = 0;
    if (blinkCount >= 5) score += 1;
    if (medDur >= 80 && medDur <= 450) score += 1;
    if (rate >= 8 && rate <= 28) score += 1;
    if (microsleeps === 0) score += 0.5;
    rows.push([
      stepMs,
      +(1000 / stepMs).toFixed(1),
      durations.length + microsleeps,
      fmt(medDur, 0),
      blinkCount,
      microsleeps,
      fmt(rate, 1),
      score,
    ]);
    console.log(
      `  stepMs=${String(stepMs).padEnd(6)} (${(1000 / stepMs).toFixed(0).padStart(3)}fps): 闭合段=${durations.length + microsleeps} 眨眼=${blinkCount} medDur=${fmt(medDur, 0)}ms rate=${fmt(rate, 1)}/min 微睡眠=${microsleeps} score=${score}`
    );
  }
  writeCsv(`${TAG}-fps-estimate.csv`, rows);
  console.log('\n判定：得分最高（=3.5）的 stepMs 为真实帧率。');
}

/* ══════════════════ 模式二：NTHU clip 级基线 ══════════════════ */
async function modeBaseline() {
  console.log(
    `\n=== NTHU-DDD clip 级基线（stepMs=${STEP} ≈ ${(1000 / STEP).toFixed(0)}fps，calibSec=${CALIB_SEC}，ratio=${RATIO}） ===`
  );
  const allSubjects = Object.keys(CACHE.subjects).sort();
  const active = SUBJECTS ?? allSubjects;
  console.log(`被试：${active.length}/${allSubjects.length}${SUBJECTS ? '（已过滤）' : ''}`);

  const clipResults = [];
  const subjectRows = [
    ['被试', 'clips', '正类clip', '负类clip', 'TP', 'FP', 'TN', 'FN', '平均峰值分-正类', '平均峰值分-负类', '标定成功'],
  ];
  let calibFail = 0;

  for (const s of active) {
    const clips = Object.values(CACHE.subjects[s].clips);
    const { calib, ok } = calibrateSubject(clips);
    if (!ok) calibFail++;

    let tp = 0,
      fp = 0,
      tn = 0,
      fn = 0;
    const peakPos = [];
    const peakNeg = [];
    for (const [key, clip] of Object.entries(CACHE.subjects[s].clips)) {
      const { summary } = replayClip(clip.frames, calib, STEP);
      const truth = clip.label === 'drowsy' ? 1 : 0;
      const predRatio = classifyClip(summary, 'ratio', RATIO);
      clipResults.push({
        subject: s,
        clip: key,
        scenario: key.split('_')[0],
        truth,
        summary,
        predPeak: classifyClip(summary, 'peak'),
        predRatio,
        predMean: classifyClip(summary, 'mean'),
      });
      if (truth === 1) {
        peakPos.push(summary.peakScore);
        predRatio ? tp++ : fn++;
      } else {
        peakNeg.push(summary.peakScore);
        predRatio ? fp++ : tn++;
      }
    }
    subjectRows.push([
      s,
      clips.length,
      clips.filter((c) => c.label === 'drowsy').length,
      clips.filter((c) => c.label === 'notdrowsy').length,
      tp,
      fp,
      tn,
      fn,
      peakPos.length ? (peakPos.reduce((a, b) => a + b, 0) / peakPos.length).toFixed(1) : '',
      peakNeg.length ? (peakNeg.reduce((a, b) => a + b, 0) / peakNeg.length).toFixed(1) : '',
      ok ? 'yes' : 'fallback',
    ]);
  }

  console.log('\n--- 总体指标（三种判定规则） ---');
  const ruleRows = [['判定规则', '灵敏度', '特异度', '精确率', 'F1', 'MCC', '平衡准确率', 'TP', 'FP', 'TN', 'FN']];
  for (const rule of ['peak', 'ratio', 'mean']) {
    const items = clipResults.map((c) => ({
      truth: c.truth,
      pred: (rule === 'peak' ? c.predPeak : rule === 'ratio' ? c.predRatio : c.predMean) ? 1 : 0,
    }));
    const m = clipMetrics(items);
    ruleRows.push([
      rule === 'ratio' ? `ratio(${RATIO})` : rule,
      fmt(m.sensitivity),
      fmt(m.specificity),
      fmt(m.precision),
      fmt(m.f1),
      fmt(m.mcc),
      fmt(m.balancedAcc),
      m.tp,
      m.fp,
      m.tn,
      m.fn,
    ]);
    console.log(
      `  ${rule.padEnd(10)} 灵敏度 ${fmt(m.sensitivity)} 特异度 ${fmt(m.specificity)} F1 ${fmt(m.f1)} MCC ${fmt(m.mcc)} (TP${m.tp} FP${m.fp} TN${m.tn} FN${m.fn})`
    );
  }

  console.log('\n--- 场景分解（ratio 规则） ---');
  const scenarios = {};
  for (const c of clipResults) {
    (scenarios[c.scenario] ??= []).push({ truth: c.truth, pred: c.predRatio ? 1 : 0 });
  }
  const sceneRows = [['场景', 'clips', '灵敏度', '特异度', 'F1', 'MCC']];
  for (const [sc, items] of Object.entries(scenarios).sort()) {
    const m = clipMetrics(items);
    sceneRows.push([sc, items.length, fmt(m.sensitivity), fmt(m.specificity), fmt(m.f1), fmt(m.mcc)]);
    console.log(
      `  ${sc.padEnd(16)} n=${String(items.length).padStart(3)} 灵敏度 ${fmt(m.sensitivity)} 特异度 ${fmt(m.specificity)} F1 ${fmt(m.f1)}`
    );
  }

  console.log('\n--- 误差样本（ratio 规则，前 20） ---');
  const fnList = clipResults.filter((c) => c.truth === 1 && !c.predRatio);
  const fpList = clipResults.filter((c) => c.truth === 0 && c.predRatio);
  console.log(`  漏检（drowsy 未报，${fnList.length} 个）：`);
  for (const c of fnList.slice(0, 20)) {
    console.log(
      `    ${c.subject} ${c.clip}: peak=${c.summary.peakScore} mean=${c.summary.meanScore} ratio=${c.summary.fatigueRatio} peakPerclos=${c.summary.peakPerclos} peakClosure=${c.summary.peakClosureMs}ms valid=${c.summary.nValid}/${c.summary.nFrames}`
    );
  }
  console.log(`  误报（notdrowsy 报警，${fpList.length} 个）：`);
  for (const c of fpList.slice(0, 20)) {
    console.log(
      `    ${c.subject} ${c.clip}: peak=${c.summary.peakScore} mean=${c.summary.meanScore} ratio=${c.summary.fatigueRatio} peakPerclos=${c.summary.peakPerclos} peakClosure=${c.summary.peakClosureMs}ms valid=${c.summary.nValid}/${c.summary.nFrames}`
    );
  }

  writeCsv(`${TAG}-nthu-rules.csv`, ruleRows);
  writeCsv(`${TAG}-nthu-scenarios.csv`, sceneRows);
  writeCsv(`${TAG}-nthu-subjects.csv`, subjectRows);
  writeCsv(`${TAG}-nthu-clips.csv`, [
    [
      '被试',
      'clip',
      'truth',
      'predPeak',
      'predRatio',
      'predMean',
      'peakScore',
      'meanScore',
      'fatigueRatio',
      'peakPerclos',
      'peakClosureMs',
      'nValid',
      'nFrames',
    ],
    ...clipResults.map((c) => [
      c.subject,
      c.clip,
      c.truth,
      c.predPeak ? 1 : 0,
      c.predRatio ? 1 : 0,
      c.predMean ? 1 : 0,
      c.summary.peakScore,
      c.summary.meanScore,
      c.summary.fatigueRatio,
      c.summary.peakPerclos,
      c.summary.peakClosureMs,
      c.summary.nValid,
      c.summary.nFrames,
    ]),
  ]);
  console.log(`\n标定失败（回退通用阈值）被试数：${calibFail}/${active.length}`);
}

/* ══════════════════ 模式三：UTA 帧级眼睛状态验证 ══════════════════ */
/**
 * UTA-RLDD 独立帧：alert（清醒）vs drowsy（困倦）的闭合度分离度。
 * 双通道价值验证：几何 / 语义 / 融合三口径 AUC 对比。
 * 个性化标定：该被试 alert 帧作为清醒素材（帧稀疏 → minSamples 放宽到 4）。
 */
async function modeFramelevel() {
  console.log(`\n=== UTA-RLDD 帧级眼睛状态验证（stepMs=${STEP}） ===`);
  const allSubjects = Object.keys(CACHE.subjects).sort();
  const active = SUBJECTS ?? allSubjects;
  const rows = [
    [
      '被试',
      'alert帧',
      'drowsy帧',
      'alert闭眼率',
      'drowsy闭眼率',
      '几何AUC',
      '语义AUC',
      '融合AUC',
      'EAR基线',
      '闭眼阈值',
    ],
  ];
  const agg = { alertClosure: [], drowsyClosure: [], alertGeo: [], drowsyGeo: [], alertSem: [], drowsySem: [] };

  for (const s of active) {
    const data = CACHE.subjects[s];
    const alertFrames = Object.values(data.clips)
      .filter((c) => c.label === 'alert')
      .flatMap((c) => c.frames)
      .filter((f) => f.ok);
    const drowsyFrames = Object.values(data.clips)
      .filter((c) => c.label === 'drowsy')
      .flatMap((c) => c.frames)
      .filter((f) => f.ok);
    if (alertFrames.length < 3 || drowsyFrames.length < 3) continue;

    const calib = calibrateFrom(alertFrames, +((alertFrames.length * STEP) / 1000).toFixed(3), STEP, 4);

    const engine = new IndicatorEngine();
    const closureOf = (f) => {
      const feat = toFeat(f, STEP);
      const geo =
        Number.isFinite(feat.ear) && calib.earBaseline > calib.earCloseThresh
          ? Math.min(1, Math.max(0, (calib.earBaseline - feat.ear) / (calib.earBaseline - calib.earCloseThresh)))
          : NaN;
      const sem = engine._semClosure(feat, calib);
      return { geo, sem, fused: engine._closureDegree(feat, calib) };
    };
    const alertC = alertFrames.map(closureOf);
    const drowsyC = drowsyFrames.map(closureOf);
    agg.alertClosure.push(...alertC.map((c) => c.fused));
    agg.drowsyClosure.push(...drowsyC.map((c) => c.fused));
    agg.alertGeo.push(...alertC.map((c) => c.geo));
    agg.drowsyGeo.push(...drowsyC.map((c) => c.geo));
    agg.alertSem.push(...alertC.map((c) => c.sem));
    agg.drowsySem.push(...drowsyC.map((c) => c.sem));

    const closedRate = (arr) => (arr.length ? arr.filter((v) => v >= 0.8).length / arr.length : NaN);
    rows.push([
      s,
      alertC.length,
      drowsyC.length,
      fmt(closedRate(alertC.map((c) => c.fused)), 3),
      fmt(closedRate(drowsyC.map((c) => c.fused)), 3),
      fmt(rankAuc(drowsyC.map((c) => c.geo).filter(Number.isFinite), alertC.map((c) => c.geo).filter(Number.isFinite))),
      fmt(rankAuc(drowsyC.map((c) => c.sem).filter(Number.isFinite), alertC.map((c) => c.sem).filter(Number.isFinite))),
      fmt(
        rankAuc(drowsyC.map((c) => c.fused).filter(Number.isFinite), alertC.map((c) => c.fused).filter(Number.isFinite))
      ),
      fmt(calib.earBaseline, 3),
      fmt(calib.earCloseThresh, 3),
    ]);
  }

  const aucAll = (pos, neg) => rankAuc(pos.filter(Number.isFinite), neg.filter(Number.isFinite));
  console.log(`\n有效被试：${rows.length - 1}`);
  console.log(`总体闭合度 AUC（正类=drowsy 帧）：`);
  console.log(`  几何通道   ${fmt(aucAll(agg.drowsyGeo, agg.alertGeo))}`);
  console.log(`  语义通道   ${fmt(aucAll(agg.drowsySem, agg.alertSem))}`);
  console.log(`  双通道融合 ${fmt(aucAll(agg.drowsyClosure, agg.alertClosure))}`);
  console.log(`帧数：alert ${agg.alertClosure.length} / drowsy ${agg.drowsyClosure.length}`);
  writeCsv(`${TAG}-uta-framelevel.csv`, rows);
}

/* ══════════════════ 模式四：参数扫描 ══════════════════ */
/**
 * 对单个参数扫描：每个取值全量回放调优被试子集，输出 ratio 规则指标。
 * 纪律：--subjects 必须显式给出调优子集（与测试被试不相交）。
 */
async function modeSweep() {
  if (!SWEEP_PARAM || !SWEEP_VALUES.length) {
    console.error('sweep 模式需要 --param <config路径> --values <逗号分隔数值>');
    process.exit(1);
  }
  if (!SUBJECTS) {
    console.error('sweep 模式必须用 --subjects 指定调优被试子集（防过拟合纪律：与测试被试不相交）');
    process.exit(1);
  }
  const snap = snapshotConfig();
  console.log(`\n=== 参数扫描：${SWEEP_PARAM} ∈ {${SWEEP_VALUES.join(', ')}} ===`);
  console.log(`调优被试：${SUBJECTS.join(',')}（${SUBJECTS.length} 人）`);

  const rows = [
    [
      '取值',
      '灵敏度',
      '特异度',
      'F1',
      'MCC',
      '平衡准确率',
      'TP',
      'FP',
      'TN',
      'FN',
      '平均峰值分-正类',
      '平均峰值分-负类',
    ],
  ];
  const stats = [];
  for (const v of SWEEP_VALUES) {
    restoreConfig(snap);
    setConfigPath(SWEEP_PARAM, v);
    const items = [];
    const peakPos = [];
    const peakNeg = [];
    for (const s of SUBJECTS) {
      const data = CACHE.subjects[s];
      if (!data) continue;
      const { calib } = calibrateSubject(Object.values(data.clips));
      for (const clip of Object.values(data.clips)) {
        const { summary } = replayClip(clip.frames, calib, STEP);
        items.push({ truth: clip.label === 'drowsy' ? 1 : 0, pred: classifyClip(summary, 'ratio', RATIO) ? 1 : 0 });
        (clip.label === 'drowsy' ? peakPos : peakNeg).push(summary.peakScore);
      }
    }
    const m = clipMetrics(items);
    const meanPeak = (arr) => (arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : '');
    rows.push([
      v,
      fmt(m.sensitivity),
      fmt(m.specificity),
      fmt(m.f1),
      fmt(m.mcc),
      fmt(m.balancedAcc),
      m.tp,
      m.fp,
      m.tn,
      m.fn,
      meanPeak(peakPos),
      meanPeak(peakNeg),
    ]);
    stats.push({ v, m });
    console.log(
      `  ${SWEEP_PARAM}=${v}: 灵敏度 ${fmt(m.sensitivity)} 特异度 ${fmt(m.specificity)} F1 ${fmt(m.f1)} MCC ${fmt(m.mcc)} (TP${m.tp} FP${m.fp} TN${m.tn} FN${m.fn})`
    );
  }
  restoreConfig(snap);
  const safeParam = SWEEP_PARAM.replace(/[[\].]/g, '-');
  writeCsv(`${TAG}-sweep-${safeParam}.csv`, rows);

  // 最优取值：特异度 >0.5 约束下 MCC 最大化（安全系统不允许全误报换灵敏度）
  const best = stats.reduce((a, b) => {
    const sa = a.m.specificity > 0.5 ? a.m.mcc : -Infinity;
    const sb = b.m.specificity > 0.5 ? b.m.mcc : -Infinity;
    return sb > sa ? b : a;
  });
  console.log(`\n最优取值：${SWEEP_PARAM}=${best.v}（MCC=${fmt(best.m.mcc)}，特异度 ${fmt(best.m.specificity)}）`);
}

/* ══════════════════ 调度 ══════════════════ */
switch (MODE) {
  case 'fps':
    await modeFps();
    break;
  case 'baseline':
    await modeBaseline();
    break;
  case 'framelevel':
    await modeFramelevel();
    break;
  case 'sweep':
    await modeSweep();
    break;
  default:
    console.error(`未知模式 "${MODE}"（支持 baseline / fps / framelevel / sweep）`);
    process.exit(1);
}
console.log('\n=== realdata-eval 完成 ===');
