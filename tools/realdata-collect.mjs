#!/usr/bin/env node
/**
 * realdata-collect.mjs — 真实标注数据特征采集（真实数据评测 · 第一步）
 *
 * 【定位】
 * 把公开标注数据集（NTHU-DDD 帧序列 / UTA-RLDD 独立帧）送入与生产完全相同的
 * 推理链路（FaceEngine → FeatureExtractor），将逐帧特征缓存为 JSON。
 * 之后的指标层/融合层评估与参数扫描由 realdata-eval.mjs 在 Node 中回放，
 * 无需重复推理——一次采集，多次复用。
 *
 * 【为什么在浏览器里跑推理】
 * MediaPipe FaceLandmarker 的 wasm 运行时面向浏览器环境；本仓库的评测传统
 * （e2e-fake-camera-test.mjs）已验证无头 Edge + CDP 可以驱动完整推理链路。
 * 特征提取复用 web/js/core/features.js 原模块，保证与线上行为逐位一致。
 *
 * 【缓存字段】（每帧，数值保留 4 位小数）
 *   i  帧序号（clip 内从 0 起）   ok 是否检测到人脸
 *   ear 眼纵横比(滤波后)          mar 嘴纵横比(滤波后)
 *   pitch/yaw/roll 头部欧拉角(度) pitchVel 俯仰角速度(度/秒)
 *   blinkScore 语义闭合度         jawOpen 张口系数
 *   scale 面部尺度                fw 人脸宽度占比      co 中心偏移
 * fw/co 为质量门控的原始量（复刻 quality.js 包围盒计算，不缓存判定结论），
 * 这样质量阈值（maxYawDeg/maxRollDeg 等）在回放侧仍可调。
 *
 * 【数据源】
 *   NTHU-DDD（HF: Manith/driver_drowsiness_detection_dataset，非 marked 版）
 *     文件名 {subject}_{scenario}_{behavior}_{frame}_{label}.jpg，
 *     label ∈ {drowsy, notdrowsy}，帧号连续 → 按 clip 分组、帧号排序，
 *     时间戳按虚拟帧率（--stepMs，默认 33.33ms ≈ 30fps）生成。
 *   UTA-RLDD（HF: chbh7051/UTA-RLDD_images）
 *     文件名 {subject}_{n}.jpg，类目录 alert/drowsy 为标签；
 *     帧为随机抽样、无时间连续性 → 每帧独立提取（每帧重置提取器，
 *     避免中值滤波状态跨帧污染），仅供帧级眼睛状态验证。
 *
 * 【用法】
 *   node tools/realdata-collect.mjs --dataset nthu --data-dir D:\fatigue-eval-data
 *   node tools/realdata-collect.mjs --dataset uta  --data-dir D:\fatigue-eval-data
 *   可选：--stepMs 33.33（NTHU 虚拟帧间隔）--app-port 5180（应用服务端口）
 *         --subjects 001,002（只采集部分被试，调试用）
 *
 * 【产出】
 *   {data-dir}\cache\{dataset}-features.json：
 *   { meta: {...}, subjects: { [subject]: { clips: { [clipKey]: {
 *       label, frames: [...] } } } } }
 *
 * 复现命令：node tools/realdata-collect.mjs --dataset nthu --data-dir D:\fatigue-eval-data
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchHeadless, evalJs, sleep } from './cdp-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ══════════════════ 命令行参数 ══════════════════ */
const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const DATASET = get('--dataset', 'nthu');
const DATA_DIR = path.resolve(get('--data-dir', 'D:\\fatigue-eval-data'));
const STEP_MS = Number(get('--stepMs', '33.333'));
const APP_PORT = Number(get('--app-port', '5180'));
const SUBJECT_FILTER = get('--subjects', '') ? get('--subjects', '').split(',') : null;
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const OUT_FILE = path.join(CACHE_DIR, `${DATASET}-features.json`);

if (!['nthu', 'uta'].includes(DATASET)) {
  console.error(`未知数据集 "${DATASET}"（支持 nthu / uta）`);
  process.exit(1);
}

/* ══════════════════ 一、扫描数据集构建 manifest ══════════════════ */

/**
 * NTHU 目录结构：<root>/nthu-ddd/{drowsy|notdrowsy}/{drowsy|notdrowsy}/*.jpg
 * 解析文件名 {subject}_{scenario}_{behavior}_{frame}_{label}.jpg。
 */
function scanNthu() {
  const base = path.join(DATA_DIR, 'nthu-ddd');
  const subjects = {}; // subject -> { clips: { clipKey: {label, frames:[{i,abs}] } } }
  let totalFiles = 0;
  for (const label of ['drowsy', 'notdrowsy']) {
    const dir = path.join(base, label, label);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jpg')) continue;
      totalFiles++;
      const parts = name.replace(/\.jpg$/, '').split('_');
      if (parts.length < 4) continue;
      const frameIdx = Number(parts[parts.length - 2]);
      const fileLabel = parts[parts.length - 1];
      const subject = parts[0];
      const body = parts.slice(1, -2).join('_'); // scenario_behavior（可能含下划线）
      if (fileLabel !== label) continue; // 目录与文件名标签不一致时以目录为准并跳过
      if (!Number.isInteger(frameIdx)) continue;
      subjects[subject] ??= { clips: {} };
      const clipKey = `${body}_${label}`;
      subjects[subject].clips[clipKey] ??= { label, frames: [] };
      subjects[subject].clips[clipKey].frames.push({ i: frameIdx, abs: path.join(dir, name) });
    }
  }
  // 帧号排序 + 连续性检查
  let clips = 0;
  let nonDense = 0;
  for (const subj of Object.values(subjects)) {
    for (const clip of Object.values(subj.clips)) {
      clip.frames.sort((a, b) => a.i - b.i);
      clips++;
      const gaps = [];
      for (let k = 1; k < Math.min(clip.frames.length, 40); k++) {
        gaps.push(clip.frames[k].i - clip.frames[k - 1].i);
      }
      const medianGap = gaps.length ? gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 1;
      if (medianGap > 1) nonDense++;
    }
  }
  console.log(
    `[manifest] NTHU-DDD：${Object.keys(subjects).length} 被试 / ${clips} clips / ${totalFiles} 帧（${nonDense} 个 clip 帧号非连续）`
  );
  return { subjects, totalFiles };
}

/**
 * UTA 目录结构：<root>/uta-rldd/{test|validation|train}/{split}/{class}/*.jpg
 * 文件名 {subject}_{n}.jpg；标签取自目录名（alert=清醒，drowsy=疲劳）。
 * 帧独立（无时间连续性），每个 (subject, class) 合并为一个"clip"，
 * 帧序号取文件名第二段。
 */
function scanUta() {
  const base = path.join(DATA_DIR, 'uta-rldd');
  const subjects = {};
  let totalFiles = 0;
  for (const split of ['test', 'validation', 'train']) {
    const dir = path.join(base, split, split);
    if (!fs.existsSync(dir)) continue;
    for (const cls of fs.readdirSync(dir)) {
      const clsDir = path.join(dir, cls);
      if (!fs.statSync(clsDir).isDirectory()) continue;
      for (const name of fs.readdirSync(clsDir)) {
        if (!name.endsWith('.jpg')) continue;
        totalFiles++;
        const parts = name.replace(/\.jpg$/, '').split('_');
        if (parts.length < 2) continue;
        const subject = parts[0];
        const frameIdx = Number(parts[1]);
        if (!Number.isInteger(frameIdx)) continue;
        subjects[subject] ??= { clips: {} };
        const clipKey = `${split}_${cls}`;
        subjects[subject].clips[clipKey] ??= { label: cls, frames: [] };
        subjects[subject].clips[clipKey].frames.push({ i: frameIdx, abs: path.join(clsDir, name) });
      }
    }
  }
  let clips = 0;
  for (const subj of Object.values(subjects)) {
    for (const clip of Object.values(subj.clips)) {
      clip.frames.sort((a, b) => a.i - b.i);
      clips++;
    }
  }
  console.log(`[manifest] UTA-RLDD：${Object.keys(subjects).length} 被试 / ${clips} 分组 / ${totalFiles} 帧`);
  return { subjects, totalFiles };
}

console.log(`\n=== realdata-collect：${DATASET} 数据集特征采集 ===`);
const { subjects: MANIFEST } = DATASET === 'nthu' ? scanNthu() : scanUta();

// 被试过滤（调试用）
const subjectKeys = Object.keys(MANIFEST).sort();
const ACTIVE = SUBJECT_FILTER ? subjectKeys.filter((s) => SUBJECT_FILTER.includes(s)) : subjectKeys;
if (ACTIVE.length === 0) {
  console.error('被试过滤后为空，请检查 --subjects 参数');
  process.exit(1);
}
const activeFrames = ACTIVE.reduce(
  (n, s) => n + Object.values(MANIFEST[s].clips).reduce((m, c) => m + c.frames.length, 0),
  0
);
console.log(`[manifest] 本次采集：${ACTIVE.length} 被试 / ${activeFrames} 帧`);

/* ══════════════════ 二、manifest 与应用服务 ══════════════════ */
// CSP connect-src 'self' 禁止页面跨源取数，因此数据集通过应用服务器
// 的 --dataset-dir 开关以同源路径 /dataset/ 提供（见 server.js）。
const slim = {};
for (const s of ACTIVE) {
  slim[s] = {};
  for (const [key, clip] of Object.entries(MANIFEST[s].clips)) {
    slim[s][key] = {
      label: clip.label,
      frames: clip.frames.map((f) => path.relative(DATA_DIR, f.abs).replace(/\\/g, '/')),
    };
  }
}
fs.writeFileSync(path.join(DATA_DIR, 'manifest.json'), JSON.stringify(slim), 'utf8');
console.log('[manifest] manifest.json 已写入数据目录');

const appServer = spawn(
  process.execPath,
  [path.join(ROOT, 'server/server.js'), '--no-open', '--port', String(APP_PORT), '--dataset-dir', DATA_DIR],
  { stdio: 'ignore', detached: false }
);
let appReady = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${APP_PORT}/`, { signal: AbortSignal.timeout(800) });
    if (r.ok) {
      appReady = true;
      break;
    }
  } catch {
    /* retry */
  }
  await sleep(500);
}
if (!appReady) {
  console.error('应用服务启动失败');
  process.exit(1);
}
console.log(`[server] 应用服务 http://127.0.0.1:${APP_PORT}（dataset 路由已启用）`);

/* ══════════════════ 四、无头浏览器 + 页面内采集 ══════════════════ */
const session = await launchHeadless({ debugPort: 9346 });
const { cdp } = session;
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;

/** 页面内采集器源码（fire-and-forget 启动，Node 轮询进度并逐被试取回） */
function buildStartExpr() {
  const resetPerFrame = DATASET === 'uta' ? 'extractor.reset();' : '';
  return `
(() => {
  window.__collect = { status: 'loading', error: null, doneSubjects: [], totalFrames: ${activeFrames}, doneFrames: 0, out: {} };
  const job = (async () => {
    const { FaceEngine } = await import('${APP_URL}js/core/face-engine.js');
    const { FeatureExtractor } = await import('${APP_URL}js/core/features.js');
    const manifest = await (await fetch('${APP_URL}dataset/manifest.json')).json();
    const engine = new FaceEngine();
    await engine.init();
    window.__collect.status = 'running';
    const engineTsBase = engine.reserveTimestampBase(5000);
    let engineTs = engineTsBase;
    const R4 = (v) => (Number.isFinite(v) ? +v.toFixed(4) : null);

    const loadImg = (url) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('img load fail: ' + url));
      img.src = url;
    });

    // 质量门控原始量（复刻 quality.js 的包围盒计算，不做判定）
    function bboxMetrics(lm, aspect) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < lm.length; i++) {
        const p = lm[i];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      const fw = maxX - minX;
      const co = Math.hypot(((minX + maxX) / 2 - 0.5) * aspect, (minY + maxY) / 2 - 0.5);
      return { fw: R4(fw), co: R4(co) };
    }

    for (const subject of ${JSON.stringify(ACTIVE)}) {
      const clipsOut = {};
      for (const [clipKey, clip] of Object.entries(manifest[subject])) {
        const extractor = new FeatureExtractor();
        const frames = [];
        for (let k = 0; k < clip.frames.length; k++) {
          const rel = clip.frames[k];
          const url = '${APP_URL}dataset/' + encodeURI(rel);
          ${resetPerFrame}
          const featTs = Math.round(k * ${STEP_MS});
          let rec = { i: k, ok: false };
          try {
            const img = await loadImg(url);
            engineTs += ${Math.round(STEP_MS)} + 1;
            const res = engine.detect(img, engineTs, true);
            if (res) {
              const aspect = img.naturalWidth / img.naturalHeight;
              const feat = extractor.extract(res, featTs, aspect);
              if (feat.ok) {
                const bb = bboxMetrics(feat.landmarks, aspect);
                rec = {
                  i: k, ok: true,
                  ear: R4(feat.ear), mar: R4(feat.mar),
                  pitch: R4(feat.pitch), yaw: R4(feat.yaw), roll: R4(feat.roll),
                  pitchVel: R4(feat.pitchVel), blinkScore: R4(feat.blinkScore),
                  jawOpen: R4(feat.jawOpen), scale: R4(feat.scale),
                  fw: bb.fw, co: bb.co,
                };
              }
            }
          } catch (e) { /* 单帧失败按无人脸记录 */ }
          frames.push(rec);
          window.__collect.doneFrames++;
          if (k % 20 === 0) await new Promise((r) => setTimeout(r, 0));
        }
        clipsOut[clipKey] = { label: clip.label, frames };
      }
      window.__collect.out[subject] = { clips: clipsOut };
      window.__collect.doneSubjects.push(subject);
    }
    window.__collect.status = 'done';
  })();
  job.catch((e) => {
    window.__collect.status = 'error';
    window.__collect.error = String((e && e.stack) || e);
  });
  return 'started';
})()
`;
}

try {
  await cdp.send('Page.navigate', { url: APP_URL });
  await sleep(3000);
  await evalJs(cdp, buildStartExpr());
  console.log('[collect] 页面内采集已启动，等待推理…');

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const result = {
    meta: {
      dataset: DATASET,
      collectedAt: new Date().toISOString(),
      stepMs: STEP_MS,
      appUrl: APP_URL,
      subjects: ACTIVE.length,
      frames: activeFrames,
      note:
        DATASET === 'nthu'
          ? 'NTHU-DDD 帧序列；ts=帧序号×stepMs（虚拟帧率）；质量原始量 fw/co 供回放侧判定'
          : 'UTA-RLDD 独立帧；无时间连续性，仅供帧级眼睛状态验证',
    },
    subjects: {},
  };
  const retrieved = new Set();
  const startedAt = Date.now();
  let lastDone = -1;
  let lastProgressAt = Date.now();
  while (true) {
    await sleep(4000);
    const status = await evalJs(
      cdp,
      `JSON.stringify({s: window.__collect.status, e: window.__collect.error, done: window.__collect.doneFrames, total: window.__collect.totalFrames, ready: window.__collect.doneSubjects})`
    );
    const st = JSON.parse(status);
    const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    process.stdout.write(
      `\r[collect] ${pct}%  ${st.done}/${st.total} 帧  ${st.ready.length}/${ACTIVE.length} 被试  ${elapsedMin}min   `
    );

    if (st.e) {
      console.error(`\n[collect] 页面内错误：${st.e}`);
      break;
    }
    for (const subj of st.ready) {
      if (retrieved.has(subj)) continue;
      const payload = await evalJs(cdp, `JSON.stringify(window.__collect.out[${JSON.stringify(subj)}])`);
      result.subjects[subj] = JSON.parse(payload);
      retrieved.add(subj);
      await evalJs(cdp, `delete window.__collect.out[${JSON.stringify(subj)}]`); // 释放页面内存
    }
    if (st.s === 'done') break;
    // 进度停滞保护：15 分钟无进展则放弃
    if (st.done === lastDone && Date.now() - lastProgressAt > 15 * 60 * 1000) {
      console.error('\n[collect] 进度停滞超时，退出');
      break;
    }
    if (st.done !== lastDone) {
      lastDone = st.done;
      lastProgressAt = Date.now();
    }
  }
  console.log('');
  fs.writeFileSync(OUT_FILE, JSON.stringify(result), 'utf8');
  const sizeMB = (fs.statSync(OUT_FILE).size / 1048576).toFixed(1);
  console.log(`[collect] 缓存已写入 ${OUT_FILE}（${sizeMB} MB，${retrieved.size} 被试）`);

  // 采集质量摘要：人脸检出率
  let okFrames = 0;
  let allFrames = 0;
  for (const subj of Object.values(result.subjects)) {
    for (const clip of Object.values(subj.clips)) {
      for (const f of clip.frames) {
        allFrames++;
        if (f.ok) okFrames++;
      }
    }
  }
  console.log(
    `[collect] 人脸检出率：${okFrames}/${allFrames} = ${((okFrames / Math.max(1, allFrames)) * 100).toFixed(1)}%`
  );
  if (okFrames / Math.max(1, allFrames) < 0.5) {
    console.warn('[collect] 警告：检出率过低，请检查数据集图像内容与引擎初始化');
  }
} finally {
  await session.close().catch(() => {});
  appServer.kill();
}
