/**
 * sea-launcher.js — SEA (Single Executable Application) 启动器
 *
 * 此脚本会被注入到 node.exe 中，生成一个独立的 launcher.exe。
 * 用户双击 launcher.exe 即可启动疲劳检测系统，无需单独安装 Node.js。
 *
 * 原理：SEA 进程的 process.execPath 指向 launcher.exe 自身，
 * 通过 path.dirname 获取安装目录，再 spawn node 运行 server.js。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// SEA 注入后，process.execPath 是 launcher.exe 的路径
// 安装目录 = launcher.exe 所在目录
const APP_DIR = path.dirname(process.execPath);

// Node.js portable 的位置（安装时一起打包到 node\ 子目录）
const NODE_EXE = path.join(APP_DIR, 'node', 'node.exe');
const SERVER_JS = path.join(APP_DIR, 'server', 'server.js');

// ANSI 颜色（Windows 终端支持）
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function printBanner() {
  console.log('');
  console.log('  ' + C.bold + '┌──────────────────────────────────────────────────────┐' + C.reset);
  console.log('  ' + C.bold + '│         驾驶员疲劳检测系统 · 正在启动                 │' + C.reset);
  console.log('  ' + C.bold + '└──────────────────────────────────────────────────────┘' + C.reset);
  console.log('');
}

function checkFiles() {
  const missing = [];

  if (!fs.existsSync(NODE_EXE)) {
    missing.push('node/node.exe (Node.js 运行时)');
  }
  if (!fs.existsSync(SERVER_JS)) {
    missing.push('server/server.js (服务器脚本)');
  }

  // 检查推理资源
  const vendorDir = path.join(APP_DIR, 'web', 'vendor');
  const vendorFiles = [
    'tasks-vision/vision_bundle.mjs',
    'tasks-vision/wasm/vision_wasm_internal.wasm',
    'models/face_landmarker.task',
  ];
  for (const f of vendorFiles) {
    const p = path.join(vendorDir, f);
    if (!fs.existsSync(p) || fs.statSync(p).size === 0) {
      missing.push('web/vendor/' + f);
    }
  }

  return missing;
}

function main() {
  printBanner();

  // 1. 检查关键文件
  const missing = checkFiles();
  if (missing.length > 0) {
    console.log('  ' + C.red + '[错误] 以下文件缺失：' + C.reset);
    for (const f of missing) {
      console.log('         - ' + f);
    }
    console.log('');
    console.log('  安装可能不完整，请重新安装本程序。');
    console.log('');
    process.stdin.resume();
    process.stdin.on('data', () => process.exit(1));
    return;
  }

  console.log('  ' + C.green + '[√] 文件检查通过' + C.reset);

  // 2. 启动服务器
  console.log('  ' + C.cyan + '正在启动本地服务器...' + C.reset);
  console.log('');

  const child = spawn(NODE_EXE, [SERVER_JS], {
    cwd: APP_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      // 确保使用内嵌的 Node.js
      PATH: path.join(APP_DIR, 'node') + ';' + (process.env.PATH || ''),
    },
  });

  // 3. Ctrl+C 转发
  process.on('SIGINT', () => {
    child.kill('SIGINT');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    child.kill('SIGTERM');
    process.exit(0);
  });

  child.on('exit', (code) => {
    if (code !== 0) {
      console.log('');
      console.log('  ' + C.red + '[错误] 服务器异常退出，错误码: ' + code + C.reset);
      console.log('  请检查上方日志，或联系技术支持。');
      console.log('');
      process.stdin.resume();
      process.stdin.on('data', () => process.exit(code || 1));
    } else {
      process.exit(0);
    }
  });
}

main();
