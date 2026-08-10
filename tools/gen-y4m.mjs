#!/usr/bin/env node
/**
 * gen-y4m.mjs — 生成假摄像头测试用的 .y4m 人脸视频（零依赖）
 *
 * 【为什么这样做】本环境没有 ffmpeg，也没有现成的人脸视频素材。
 * Chromium 的 --use-file-for-fake-video-capture 支持 .y4m，而 y4m 容器
 * 格式极简（文本头 + 逐帧 YUV420 平面），可以直接用 Node 编码。
 *
 * 人脸来源：MediaPipe 官方测试素材 portrait.jpg（storage.googleapis.com/mediapipe-assets）。
 * 用无头浏览器把 JPEG 解码成 RGBA，再转 BT.601 YUV420 写入 y4m。
 * 帧间加入缓慢的缩放/平移微动，避免完全静止画面带来的解码缓存特例。
 *
 * 用法：node tools/gen-y4m.mjs [--out tools/fixtures/fake-face.y4m]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHeadless, evalJs, sleep } from './cdp-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(get('--out', path.join(__dirname, 'fixtures', 'fake-face.y4m')));
const PORTRAIT_URL = 'https://storage.googleapis.com/mediapipe-assets/portrait.jpg';

// 输出规格：320×240 @ 10fps，60 帧（6 秒）。足够走完 8 秒校准的「有效样本 ≥60」
// ——校准按累计有效帧数计，推理约 10~15fps 时 6 秒素材循环播放即可达标。
const W = 320;
const H = 240;
const FPS_NUM = 10;
const FRAMES = 60;

const session = await launchHeadless({ debugPort: 9343, width: 800, height: 600 });
const { cdp } = session;

try {
  console.log('下载官方人像素材…', PORTRAIT_URL);
  const buf = Buffer.from(await (await fetch(PORTRAIT_URL)).arrayBuffer());
  const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`;
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(500);

  console.log('浏览器内解码 JPEG → RGBA…');
  const rgbaB64 = await evalJs(cdp, `(async () => {
    const img = new Image();
    await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = ${JSON.stringify(dataUrl)}; });
    const cw = img.naturalWidth, ch = img.naturalHeight;
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    c.getContext('2d').drawImage(img, 0, 0);
    const d = c.getContext('2d').getImageData(0, 0, cw, ch).data;
    const bytes = new Uint8Array(d.buffer, 0, cw * ch * 4);
    let bin = '';
    const CH = 0x8000; // 分块转字符串，避免大参数展开爆栈
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return JSON.stringify({ w: cw, h: ch, b64: btoa(bin) });
  })()`);
  const meta = JSON.parse(rgbaB64);
  const src = Buffer.from(meta.b64, 'base64');
  console.log(`素材尺寸 ${meta.w}×${meta.h}，RGBA ${src.length} 字节`);

  /* ---------- RGBA → YUV420（BT.601），带帧间微动 ---------- */
  const Y = new Uint8Array(W * H);
  const U = new Uint8Array((W / 2) * (H / 2));
  const V = new Uint8Array((W / 2) * (H / 2));

  const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

  /** 第 f 帧：以 (1+amp·sin) 的缩放从素材中心裁剪并缩放到 W×H */
  function fillFrame(f) {
    const amp = 0.02;
    const zoom = 1 + amp * Math.sin((f / FRAMES) * Math.PI * 4);
    const sw = Math.min(meta.w, meta.w / zoom);
    const sh = Math.min(meta.h, meta.h / zoom);
    const sx0 = (meta.w - sw) / 2;
    const sy0 = (meta.h - sh) / 2;
    for (let y = 0; y < H; y++) {
      const srcY = (sy0 + (y / H) * sh) | 0;
      for (let x = 0; x < W; x++) {
        const srcX = (sx0 + (x / W) * sw) | 0;
        const i = (srcY * meta.w + srcX) * 4;
        const r = src[i], g = src[i + 1], b = src[i + 2];
        Y[y * W + x] = clamp255(0.299 * r + 0.587 * g + 0.114 * b);
        if ((x & 1) === 0 && (y & 1) === 0) {
          const j = (y >> 1) * (W >> 1) + (x >> 1);
          U[j] = clamp255(-0.169 * r - 0.331 * g + 0.5 * b + 128);
          V[j] = clamp255(0.5 * r - 0.419 * g - 0.081 * b + 128);
        }
      }
    }
  }

  console.log(`编码 y4m：${W}×${H} F${FPS_NUM}:1 C420jpeg × ${FRAMES} 帧…`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const fd = fs.openSync(OUT, 'w');
  fs.writeSync(fd, `YUV4MPEG2 W${W} H${H} F${FPS_NUM}:1 Ip A0:0 C420jpeg\n`);
  for (let f = 0; f < FRAMES; f++) {
    fillFrame(f);
    fs.writeSync(fd, 'FRAME\n');
    fs.writeSync(fd, Y);
    fs.writeSync(fd, U);
    fs.writeSync(fd, V);
  }
  fs.closeSync(fd);
  const size = fs.statSync(OUT).size;
  console.log(`✓ 已生成 ${path.relative(process.cwd(), OUT)}（${(size / 1024 / 1024).toFixed(2)} MB）`);
} finally {
  await session.close();
}
