#!/usr/bin/env node
/**
 * gen-icons.mjs — 从矢量母版 brand/app-icon.svg 栅格化 PWA 图标
 *
 * 为什么需要这个工具：manifest.json 此前只有 favicon.svg 一个图标，
 * 部分浏览器的安装入口/桌面快捷方式对 SVG 支持不完整，图标会退化为
 * 通用地形图。PWA 最佳实践要求提供 192/512 PNG。build-icons.cjs 的
 * 流程需要人工在浏览器控制台复制 dataURL，不适合复现；本工具用
 * cdp-util 驱动无头浏览器把 SVG 画到 canvas 上直接导出，全自动。
 *
 * 输出：web/icons/icon-192.png / icon-512.png
 * 用法：node tools/gen-icons.mjs
 */
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchHeadless, evalJs } from './cdp-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVG_PATH = path.join(ROOT, 'brand', 'app-icon.svg');
const OUT_DIR = path.join(ROOT, 'web', 'icons');
const SIZES = [192, 512];
const DEBUG_PORT = 9359; // 避开其他测试工具的常用端口（9333/9349/9353）

const svg = fs.readFileSync(SVG_PATH, 'utf8');
// data: 页面内嵌 SVG；CSP 不适用于 data: 文档
const html = `<!doctype html><meta charset="utf-8"><body>
<img id="src" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}">
<script>
window.renderIcon = async (size) => {
  const img = document.getElementById('src');
  if (!img.complete) await new Promise((r, e) => { img.onload = r; img.onerror = e; });
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d').drawImage(img, 0, 0, size, size);
  return c.toDataURL('image/png');
};
</script>`;

const { cdp, close } = await launchHeadless({ debugPort: DEBUG_PORT, width: 800, height: 600 });
try {
  await cdp.send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
  await new Promise((r) => setTimeout(r, 500));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const size of SIZES) {
    const dataUrl = await evalJs(cdp, `window.renderIcon(${size})`);
    const b64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 500) throw new Error(`${size}px 导出异常（${buf.length} 字节）`);
    // 校验 IHDR 宽高确实等于目标尺寸
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (w !== size || h !== size) throw new Error(`${size}px 实际为 ${w}x${h}`);
    const out = path.join(OUT_DIR, `icon-${size}.png`);
    fs.writeFileSync(out, buf);
    console.log(`✓ ${path.relative(ROOT, out)}（${size}x${size}，${buf.length} 字节）`);
  }
} finally {
  await close();
}
console.log('完成。记得重跑 node tools/gen-sw-precache.mjs 刷新 SW 预缓存指纹。');
