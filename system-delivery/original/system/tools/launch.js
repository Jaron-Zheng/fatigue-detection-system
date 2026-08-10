#!/usr/bin/env node
/**
 * launch.js — 一键启动的实际执行体
 *
 * 【为什么把逻辑放在 Node 里而不是写在 .bat 中】
 * Windows 的 cmd.exe 按系统默认代码页（简体中文环境为 GBK/936）解析 .bat 文件的
 * 字节流，而这个解析发生在 `chcp 65001` 生效之前。因此一旦 .bat 以 UTF-8 保存
 * 且包含中文，中文字节会被误解析并破坏命令语法（实测出现过 `if not exist`
 * 被截断成 `xist` 的情况，脚本整体失效）。
 *
 * 解决办法：.bat 只保留纯 ASCII 的最小引导逻辑，其余全部交给 Node——
 * Node 的 stdout 输出 UTF-8 字节，配合 chcp 65001 可正确显示中文，
 * 且逻辑也比批处理更好维护。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');

const REQUIRED = [
  'vendor/tasks-vision/vision_bundle.mjs',
  'vendor/tasks-vision/wasm/vision_wasm_internal.js',
  'vendor/tasks-vision/wasm/vision_wasm_internal.wasm',
  'vendor/models/face_landmarker.task',
];

function banner() {
  console.log('');
  console.log('  ============================================================');
  console.log('     基于面部多特征融合的 Web 端驾驶员疲劳检测系统');
  console.log('     Driver Fatigue Detection System');
  console.log('  ============================================================');
  console.log('');
  console.log(`  [1/3] Node.js 环境正常  (${process.version})`);
}

function ensureVendor() {
  const missing = REQUIRED.filter((rel) => {
    const p = path.join(WEB, rel);
    return !fs.existsSync(p) || fs.statSync(p).size === 0;
  });

  if (missing.length === 0) {
    console.log('  [2/3] 本地推理资源已就绪，可离线运行');
    return true;
  }

  console.log('  [2/3] 首次运行，正在下载本地推理资源（约 26MB，仅需一次）...');
  console.log('        下载完成后系统即可完全离线运行。');
  console.log('');
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'fetch-vendor.js')], {
      stdio: 'inherit',
      cwd: ROOT,
    });
  } catch {
    console.log('');
    console.log('  [!] 资源下载未完全成功，请检查网络连接后重新运行本脚本。');
    console.log('      也可手动执行：node tools\\fetch-vendor.js');
    console.log('');
    return false;
  }

  const still = REQUIRED.filter((rel) => {
    const p = path.join(WEB, rel);
    return !fs.existsSync(p) || fs.statSync(p).size === 0;
  });
  if (still.length) {
    console.log('');
    console.log('  [!] 以下必需文件仍然缺失：');
    still.forEach((f) => console.log('      - ' + f));
    console.log('');
    return false;
  }
  console.log('');
  return true;
}

function main() {
  banner();
  if (!ensureVendor()) {
    process.exitCode = 1;
    return;
  }
  console.log('  [3/3] 正在启动本地服务并打开浏览器...');
  console.log('');
  console.log('  提示：浏览器询问"是否允许使用摄像头"时请点击【允许】。');
  console.log('        关闭此窗口即停止服务。');

  // 在同一进程内启动服务器，Ctrl+C 可正常终止
  require(path.join(ROOT, 'server', 'server.js'));
}

main();
