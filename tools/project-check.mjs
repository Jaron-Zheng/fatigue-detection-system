#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanLiterals } from './check-literals.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const requiredFiles = [
  'web/index.html',
  'web/css/tokens.css',
  'web/css/base.css',
  'web/css/components.css',
  'web/css/layout.css',
  'web/css/motion.css',
  'web/js/app.js',
  'web/vendor/models/face_landmarker.task',
  'web/vendor/tasks-vision/vision_bundle.mjs',
  'web/vendor/tasks-vision/wasm/vision_wasm_internal.wasm',
  'server/server.js',
  'tools/launch.js',
  '一键启动.bat',
  '一键启动.ps1',
];

function fail(message) {
  failures.push(message);
  console.error(`  ✗ ${message}`);
}

function pass(message) {
  console.log(`  ✓ ${message}`);
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function collectJavaScript(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectJavaScript(fullPath);
    return entry.isFile() && /\.m?js$/i.test(entry.name) ? [fullPath] : [];
  });
}

function checkRequiredFiles() {
  for (const relativePath of requiredFiles) {
    const fullPath = path.join(ROOT, relativePath);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).size === 0) fail(`缺少或为空：${relativePath}`);
  }
  if (!failures.length) pass(`必需文件完整（${requiredFiles.length} 项）`);
}

function checkJavaScriptSyntax() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fatigue-check-'));
  const files = [path.join(ROOT, 'server', 'server.js'), ...collectJavaScript(path.join(ROOT, 'tools')), ...collectJavaScript(path.join(ROOT, 'web', 'js'))];
  try {
    for (const [index, file] of files.entries()) {
      const tempFile = path.join(tempDir, `${index}.mjs`);
      fs.writeFileSync(tempFile, fs.readFileSync(file, 'utf8'));
      const result = spawnSync(process.execPath, ['--check', tempFile], { encoding: 'utf8' });
      if (result.status !== 0) fail(`JavaScript 语法错误：${path.relative(ROOT, file)}\n${result.stderr.trim()}`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (!failures.some((message) => message.startsWith('JavaScript 语法错误'))) pass(`JavaScript 语法检查通过（${files.length} 个文件）`);
}

function checkHtml() {
  const html = read('web/index.html');
  const ids = [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) fail(`存在重复 HTML id：${[...new Set(duplicates)].join(', ')}`);
  else pass(`HTML id 唯一（${ids.length} 个）`);

  const assets = [...html.matchAll(/<(?:script|link)\b[^>]+?(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1]);
  for (const asset of assets) {
    if (/^(?:[a-z]+:|#|\/)/i.test(asset)) continue;
    const file = path.join(ROOT, 'web', asset);
    if (!fs.existsSync(file)) fail(`HTML 引用资源不存在：${asset}`);
  }
  if (!failures.some((message) => message.startsWith('HTML 引用资源不存在'))) pass(`HTML 本地资源引用完整（${assets.length} 项）`);
}

function checkSecurityBaselines() {
  const server = read('server/server.js');
  const config = read('web/js/config.js');
  if (!server.includes('Content-Security-Policy')) fail('静态服务器缺少 CSP 安全头');
  if (!server.includes("decoded.includes('\\\\')")) fail('静态服务器未拒绝反斜杠路径');
  if (!config.includes('isUnsafeKey')) fail('本地配置未过滤原型污染键');
  if (!failures.some((message) => message.includes('安全头') || message.includes('反斜杠') || message.includes('原型污染'))) {
    pass('安全基线检查通过');
  }
}

/** 设计令牌落地一致性：样式文件不得绕开令牌直接写字面量颜色（第三轮角色十五） */
function checkDesignTokenLiterals() {
  const files = ['base.css', 'components.css', 'layout.css', 'motion.css'];
  let count = 0;
  for (const name of files) {
    for (const v of scanLiterals(read(`web/css/${name}`))) {
      fail(`字面量颜色绕开令牌：web/css/${name}:${v.line} ${v.match}（改令牌或加 lit-ok 标记）`);
      count++;
    }
  }
  if (!count) pass(`设计令牌一致性检查通过（${files.length} 个样式文件无字面量颜色）`);
}

console.log('\n=== 项目静态检查 ===\n');
checkRequiredFiles();
checkJavaScriptSyntax();
checkHtml();
checkSecurityBaselines();
checkDesignTokenLiterals();

if (failures.length) {
  console.error(`\n=== 结果：${failures.length} 项失败 ===`);
  process.exitCode = 1;
} else {
  console.log('\n=== 结果：全部静态检查通过 ===');
}
