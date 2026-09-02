#!/usr/bin/env node
/**
 * realdata-diagnose.mjs — 误差 clip 隶属度诊断（批次2 辅助工具）
 *
 * 对指定 clip 回放完整管线，输出逐秒隶属度/贡献分明细，
 * 定位"分数从哪来/卡在哪"。仅调试用，不产出论文数据。
 *
 * 用法：node tools/realdata-diagnose.mjs --subject 001 --clip glasses_yawning_drowsy
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_JS = path.resolve(__dirname, '../web/js');

if (typeof globalThis.performance === 'undefined') globalThis.performance = { now: () => Date.now() };
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { userAgent: 'NodeDiag/1.0' };
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { createElement: () => ({}), body: { appendChild: () => {}, removeChild: () => {} } };
}
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

const importFromWeb = (rel) => import(pathToFileURL(path.join(WEB_JS, rel)).href);
const { CONFIG } = await importFromWeb('config.js');
const { Calibrator, CalibState } = await importFromWeb('core/calibration.js');
const { IndicatorEngine } = await importFromWeb('core/indicators.js');
const { FusionEngine } = await importFromWeb('core/fusion.js');

const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const CACHE = JSON.parse(fs.readFileSync(get('--cache', 'D:\\fatigue-eval-data\\cache\\nthu-features.json'), 'utf8'));
const SUBJECT = get('--subject', '');
const CLIP = get('--clip', '');
const STEP = Number(get('--stepMs', '33.333'));
const CALIB_SEC = Number(get('--calibSec', '5'));

if (!SUBJECT || !CLIP) {
  console.error('用法：--subject 001 --clip glasses_yawning_drowsy');
  process.exit(1);
}

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

function qualityVerdict(f, calib) {
  if (!f.ok || f.fw == null || f.co == null) return null;
  const g = CONFIG.quality;
  const reasons = [];
  if (f.fw < g.minFaceWidthRatio) reasons.push('远');
  if (f.fw > g.maxFaceWidthRatio) reasons.push('近');
  if (f.co > g.maxCenterOffset) reasons.push('偏');
  if (Math.abs((f.yaw ?? 0) - calib.yaw0) > g.maxYawDeg) reasons.push('侧转');
  if (Math.abs((f.roll ?? 0) - calib.roll0) > g.maxRollDeg) reasons.push('侧倾');
  return {
    face: { valid: !reasons.length, reasons, label: reasons.length ? '差' : '良好' },
    lighting: { valid: true },
  };
}

// 标定
const clips = CACHE.subjects[SUBJECT].clips;
const awake = Object.values(clips).filter((c) => c.label === 'notdrowsy');
const calibClip = awake.reduce((a, b) => (b.frames.length > a.frames.length ? b : a));
const savedDur = CONFIG.calibration.durationSec;
const calibrator = new Calibrator();
CONFIG.calibration.durationSec = CALIB_SEC;
calibrator.start(0);
for (const f of calibClip.frames) {
  if (calibrator.feed(toFeat(f, STEP), Math.round(f.i * STEP))) break;
}
if (calibrator.state !== CalibState.DONE) calibrator._finish();
CONFIG.calibration.durationSec = savedDur;
const calib = calibrator.result.ok ? calibrator.result : calibrator.useFallback();
console.log(
  `标定：earBaseline=${calib.earBaseline?.toFixed(4)} closeThresh=${calib.earCloseThresh?.toFixed(4)} blinkBase=${calib.blinkScoreBaseline?.toFixed(3)} (来源clip: ${Object.entries(clips).find(([, c]) => c === calibClip)?.[0]})`
);

// 回放目标 clip
const clip = clips[CLIP];
if (!clip) {
  console.error(`clip 不存在。可用：${Object.keys(clips).join(', ')}`);
  process.exit(1);
}
const indicators = new IndicatorEngine();
const fusion = new FusionEngine();
console.log(
  `回放：${SUBJECT} ${CLIP}（${clip.frames.length} 帧 = ${((clip.frames.length * STEP) / 1000).toFixed(1)}s，标签=${clip.label}）\n`
);

// 每秒采样输出
const everyN = Math.max(1, Math.round(1000 / STEP));
let frameIdx = 0;
const contributions = {};
let maxScore = 0;
let maxScoreInfo = null;
for (const f of clip.frames) {
  const feat = toFeat(f, STEP);
  const quality = qualityVerdict(f, calib);
  const ind = indicators.update(feat, calib, quality);
  const fus = fusion.evaluate(ind, calib);
  if (fus.score > maxScore) {
    maxScore = fus.score;
    maxScoreInfo = { frameIdx, fus, ind };
  }
  for (const [k, v] of Object.entries(fus.contributions)) {
    contributions[k] = (contributions[k] || 0) + v.points;
  }
  if (frameIdx % everyN === 0) {
    const mu = fus.memberships;
    console.log(
      `t=${((frameIdx * STEP) / 1000).toFixed(0).padStart(4)}s score=${fus.score.toFixed(1).padStart(6)} lv=${fus.level.padEnd(8)}` +
        ` perclos=${(ind.perclos ?? 0).toFixed(3)} closMs=${String(Math.round(ind.maxClosureMs || 0)).padStart(5)}` +
        ` blinkR=${(ind.blinkRate ?? 0).toFixed(1)}/m avgBlink=${Math.round(ind.avgBlinkMs || 0)}ms` +
        ` yawnR=${(ind.yawnRate ?? 0).toFixed(2)}/m nodR=${(ind.nodRate ?? 0).toFixed(2)}/m` +
        ` | μ: pc=${mu.perclos.toFixed(2)} cl=${mu.closureDur.toFixed(2)} br=${mu.blinkRate.toFixed(2)} bd=${mu.blinkDur.toFixed(2)} yw=${mu.yawn.toFixed(2)} nd=${mu.nod.toFixed(2)}`
    );
  }
  frameIdx++;
}

console.log(
  `\n峰值分数 ${maxScore.toFixed(2)} @ 帧 ${maxScoreInfo.frameIdx}（t=${((maxScoreInfo.frameIdx * STEP) / 1000).toFixed(1)}s）`
);
const sorted = Object.entries(contributions).sort((a, b) => b[1] - a[1]);
console.log('累计贡献分排名（全程）：');
for (const [k, v] of sorted) console.log(`  ${k.padEnd(12)} ${v.toFixed(1)}`);
const evCount = {};
for (const e of indicators.events) evCount[e.type] = (evCount[e.type] || 0) + 1;
console.log('事件统计：', JSON.stringify(evCount));
