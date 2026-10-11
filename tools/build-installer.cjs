#!/usr/bin/env node
/**
 * build-installer.cjs — 一键编译完整安装包（SEA + Inno Setup）
 *
 * 流程：
 *   1. 检查/下载工具（Node.js portable + Inno Setup + postject）
 *   2. 构建 SEA launcher（把启动逻辑注入 node.exe → launcher.exe）
 *   3. 用 ISCC 编译 .iss 脚本生成最终安装包
 *
 * 用法：node tools/build-installer.cjs
 *
 * 输出：项目根目录下 疲劳检测系统_Setup_v1.0.0.exe
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ISS_FILE = path.join(ROOT, 'packager', 'fatigue-detection.iss');
const PACK_DIR = path.join(ROOT, '_pack');
const LAUNCHER_EXE = path.join(PACK_DIR, 'launcher.exe');

// 查找 ISCC.exe
const candidates = [
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
  'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
];

let isccPath = null;
for (const c of candidates) {
  if (fs.existsSync(c)) {
    isccPath = c;
    break;
  }
}

console.log('══════════════════════════════════════════════════════');
console.log('  驾驶员疲劳检测系统 · 完整安装包编译');
console.log('══════════════════════════════════════════════════════');
console.log('');

// ============================================================
// Step 0: 检查 ISCC
// ============================================================
if (!isccPath) {
  console.error('  ✗ 未找到 Inno Setup 6 (ISCC.exe)');
  console.error('    请先运行: node tools/download-tools.cjs');
  console.error('    或手动安装: https://jrsoftware.org/isdl.php');
  process.exit(1);
}
console.log(`  ISCC.exe : ${isccPath}`);
console.log(`  脚本文件 : ${ISS_FILE}`);
console.log('');

// ============================================================
// Step 1: 检查 SEA launcher 是否已构建
// ============================================================
console.log('  [1] 检查 SEA launcher...');
if (!fs.existsSync(LAUNCHER_EXE)) {
  console.log('      launcher.exe 不存在，开始构建...');
  execSync(`node "${path.join(__dirname, 'build-sea.cjs')}"`, {
    cwd: ROOT,
    stdio: 'inherit',
  });
} else {
  const sizeMB = (fs.statSync(LAUNCHER_EXE).size / 1024 / 1024).toFixed(1);
  console.log(`      ✓ launcher.exe 已存在 (${sizeMB} MB)`);
}
console.log('');

// ============================================================
// Step 2: 检查关键资源
// ============================================================
console.log('  [2] 资源检查:');
const checks = [
  ['web/vendor/models/face_landmarker.task', 'MediaPipe 人脸模型'],
  ['web/vendor/tasks-vision/vision_bundle.mjs', 'MediaPipe Tasks-Vision'],
  ['web/vendor/tasks-vision/wasm/vision_wasm_internal.wasm', 'WASM 运行时'],
  ['server/server.js', '服务器'],
  ['web/index.html', '前端入口'],
  ['一键启动.bat', 'BAT 启动脚本'],
  ['app-icon.ico', '应用图标'],
  ['docs/安装许可协议.txt', '许可协议'],
  ['_pack/launcher.exe', 'SEA Launcher'],
  ['_pack/node/node.exe', 'Node.js Portable'],
];

let allOK = true;
for (const [rel, desc] of checks) {
  const p = path.join(ROOT, rel);
  const exists = fs.existsSync(p);
  const status = exists ? '✓' : '✗';
  console.log(`      ${status} ${desc} (${rel})`);
  if (!exists) allOK = false;
}
console.log('');

if (!allOK) {
  console.error('  ✗ 部分关键资源缺失，无法打包。');
  console.error('    请先运行: node tools/download-tools.cjs');
  process.exit(1);
}

// ============================================================
// Step 3: 删除旧的安装包（如果存在）
// ============================================================
const oldSetupFiles = fs.readdirSync(ROOT).filter(
  (f) => f.startsWith('疲劳检测系统_Setup_v') && f.endsWith('.exe')
);
for (const f of oldSetupFiles) {
  console.log(`  [3] 删除旧安装包: ${f}`);
  fs.unlinkSync(path.join(ROOT, f));
}
console.log('');

// ============================================================
// Step 4: 调用 ISCC 编译
// ============================================================
console.log('  [4] 开始编译安装包...');
console.log('');

try {
  execSync(`"${isccPath}" "${ISS_FILE}"`, {
    cwd: ROOT,
    stdio: 'inherit',
  });
} catch (e) {
  console.error('');
  console.error('  ✗ 编译失败:', e.message);
  process.exit(1);
}

// ============================================================
// Step 5: 输出结果
// ============================================================
console.log('');
console.log('══════════════════════════════════════════════════════');
console.log('  ✓ 安装包编译完成！');
console.log('══════════════════════════════════════════════════════');
console.log('');

const setupPattern = '疲劳检测系统_Setup_v';
const files = fs.readdirSync(ROOT).filter(
  (f) => f.startsWith(setupPattern) && f.endsWith('.exe')
);
if (files.length > 0) {
  for (const f of files) {
    const stat = fs.statSync(path.join(ROOT, f));
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    console.log(`  输出文件: ${f}  (${sizeMB} MB)`);
  }
} else {
  console.log('  [警告] 未找到输出文件，请检查编译日志。');
}
console.log('');
