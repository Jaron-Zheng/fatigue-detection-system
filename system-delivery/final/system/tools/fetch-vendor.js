#!/usr/bin/env node
/**
 * fetch-vendor.js — 依赖本地化脚本（零第三方依赖，仅用 Node 内置模块）
 *
 * 作用：把 MediaPipe Tasks-Vision 运行时与人脸关键点模型下载到 web/vendor/，
 *      使系统在完全断网的环境下（例如答辩现场）也能正常运行。
 *
 * 用法：node tools/fetch-vendor.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'web', 'vendor');

/** MediaPipe Tasks-Vision 版本（锁定版本，避免上游变更导致行为漂移） */
const MP_VERSION = '1.0.0';
const CDN = (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}${file}`;

/** 下载清单：[远端地址, 本地相对路径, 是否必需] */
const MANIFEST = [
  [CDN('/vision_bundle.mjs'), 'tasks-vision/vision_bundle.mjs', true],
  [CDN('/vision.d.ts'), 'tasks-vision/vision.d.ts', false],
  [CDN('/wasm/vision_wasm_internal.js'), 'tasks-vision/wasm/vision_wasm_internal.js', true],
  [CDN('/wasm/vision_wasm_internal.wasm'), 'tasks-vision/wasm/vision_wasm_internal.wasm', true],
  [CDN('/wasm/vision_wasm_nosimd_internal.js'), 'tasks-vision/wasm/vision_wasm_nosimd_internal.js', true],
  [CDN('/wasm/vision_wasm_nosimd_internal.wasm'), 'tasks-vision/wasm/vision_wasm_nosimd_internal.wasm', true],
  [
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    'models/face_landmarker.task',
    true,
  ],
];

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60000, headers: { 'user-agent': 'fatigue-detect-vendor/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        return download(new URL(res.headers.location, url).toString(), dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.part`;
      const ws = fs.createWriteStream(tmp);
      res.pipe(ws);
      ws.on('finish', () => {
        ws.close(() => {
          fs.renameSync(tmp, dest);
          resolve(fs.statSync(dest).size);
        });
      });
      ws.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

(async () => {
  console.log('=== 依赖本地化：MediaPipe Tasks-Vision v' + MP_VERSION + ' ===');
  let failedRequired = 0;

  for (const [url, rel, required] of MANIFEST) {
    const dest = path.join(VENDOR, rel);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log(`  [skip] ${rel}  (${humanSize(fs.statSync(dest).size)} 已存在)`);
      continue;
    }
    process.stdout.write(`  [get ] ${rel} ... `);
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const size = await download(url, dest);
        console.log(humanSize(size));
        ok = true;
      } catch (err) {
        if (attempt === 3) {
          console.log(`失败(${err.message})`);
          if (required) failedRequired++;
        } else {
          process.stdout.write(`重试${attempt} `);
          await new Promise((r) => setTimeout(r, 1200 * attempt));
        }
      }
    }
  }

  // 写一份清单，供前端做完整性自检
  const inventory = MANIFEST.map(([, rel]) => {
    const p = path.join(VENDOR, rel);
    return { file: rel, exists: fs.existsSync(p), size: fs.existsSync(p) ? fs.statSync(p).size : 0 };
  });
  fs.writeFileSync(
    path.join(VENDOR, 'inventory.json'),
    JSON.stringify({ mediapipeVersion: MP_VERSION, fetchedAt: new Date().toISOString(), files: inventory }, null, 2),
    'utf8'
  );

  const total = inventory.reduce((s, f) => s + f.size, 0);
  console.log(`--- 完成，本地资源合计 ${humanSize(total)} ---`);
  if (failedRequired > 0) {
    console.log(`警告：有 ${failedRequired} 个必需文件未获取成功，请检查网络后重跑本脚本。`);
    process.exitCode = 1;
  }
})();
