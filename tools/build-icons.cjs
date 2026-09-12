#!/usr/bin/env node
/**
 * build-icons.cjs — 从栅格化产物重建 app-icon.png / app-icon.ico
 *
 * 图标源头是矢量母版 brand/app-icon.svg（醒目 · AWAKE EYE）。
 * 重建流程（无第三方依赖，浏览器即栅格化器）：
 *   1. 用浏览器打开 brand/app-icon.svg
 *   2. 控制台执行（256px PNG dataURL）：
 *      const s = new XMLSerializer().serializeToString(document.documentElement);
 *      const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
 *      await new Promise(r => { img.onload = r; });
 *      const c = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
 *      c.width = c.height = 256;
 *      c.getContext('2d').drawImage(img, 0, 0, 256, 256);
 *      copy(c.toDataURL('image/png'))   // macOS；Windows 手动复制输出
 *   3. 把含 dataURL 的文本存成 txt，执行：
 *      node tools/build-icons.cjs <txt路径>
 *
 * ICO 结构：ICONDIR(6B) + ICONDIRENTRY(16B) + 256px PNG 负载（Vista+ 原生支持 PNG 内嵌），
 * squircle 圆角外为透明，直接透传 canvas 的 alpha 通道。
 */
const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('用法: node tools/build-icons.cjs <含data:image/png;base64,...的txt路径>');
  process.exit(1);
}

const raw = fs.readFileSync(inputPath, 'utf8');
const m = raw.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
if (!m) {
  console.error('输入文件中未找到 PNG dataURL');
  process.exit(1);
}

const png = Buffer.from(m[1], 'base64');
const root = path.resolve(__dirname, '..');

fs.writeFileSync(path.join(root, 'app-icon.png'), png);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // count: 1

const entry = Buffer.alloc(16);
entry[0] = 0; // 宽 256（0 即 256）
entry[1] = 0; // 高 256
entry[2] = 0; // 调色板
entry[3] = 0; // reserved
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png.length, 8); // 负载长度
entry.writeUInt32LE(22, 12); // 数据偏移 = 6 + 16

fs.writeFileSync(path.join(root, 'app-icon.ico'), Buffer.concat([header, entry, png]));

console.log(
  `app-icon.png ${png.readUInt32BE(16)}x${png.readUInt32BE(20)} ${png.length}B；` +
    `app-icon.ico ${png.length + 22}B`
);
