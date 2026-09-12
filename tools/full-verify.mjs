#!/usr/bin/env node
/**
 * full-verify.mjs — 一条命令跑完整质量门禁
 *
 * 顺序：静态检查 → 回归测试 → 启动服务器 → 集成/安全测试 → 关闭服务器
 *       → 开发者工具链（typecheck + lint，可选）。
 * 任何一步失败立即终止并返回非零退出码，可直接接入 CI。
 *
 * 第四轮建议②落地：lint/typecheck 纳入必跑门禁，堵住"新增工具脚本
 * 不进回归清单"的流程盲区（第三轮角色十四曾在这里抓到 16 个 lint 错误）。
 * 未执行过 npm install 时自动跳过该步（零安装承诺不变）。
 *
 * 用法：node tools/full-verify.mjs [--port 5210]
 *   集成测试用的端口默认 5210（避开开发常用的 5180，减少占用冲突）。
 */
'use strict';

import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const flagIndex = process.argv.indexOf('--port');
const PORT = flagIndex >= 0 ? Number(process.argv[flagIndex + 1]) : 5210;

/** 以当前运行时（node 或 ELECTRON_RUN_AS_NODE 的宿主）跑一个脚本并等待退出 */
function runScript(script, args = []) {
  // project-check.mjs 依赖 vm.SourceTextModule，需要实验性标志；
  // 若调用方已通过 NODE_OPTIONS/execArgv 带上则不重复添加
  const vmFlag = '--experimental-vm-modules';
  const needVm = script.endsWith('project-check.mjs') && !process.execArgv.includes(vmFlag);
  const fullArgs = [...(needVm ? [vmFlag] : []), ...process.execArgv, script, ...args];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, fullArgs, {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function waitForServer(port, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(tryOnce, 300);
      });
      req.on('timeout', () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

function step(name) {
  console.log(`\n────────── ${name} ──────────`);
}

/** 直接执行 node_modules/.bin 里的工具（tsc / eslint），返回退出码 */
function runBin(name, args = []) {
  const bin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
  if (!fs.existsSync(bin)) return Promise.resolve(-1); // 未安装
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(-1));
  });
}

async function main() {
  console.log('=== 全量质量门禁（full-verify） ===');

  step('1/4 静态检查');
  if ((await runScript(path.join(ROOT, 'tools', 'project-check.mjs'))) !== 0) {
    console.error('\n[full-verify] 静态检查失败，终止。');
    process.exit(1);
  }

  step('2/4 回归测试');
  if ((await runScript(path.join(ROOT, 'tools', 'regression-test.mjs'))) !== 0) {
    console.error('\n[full-verify] 回归测试失败，终止。');
    process.exit(1);
  }

  step(`3/4 集成/安全测试（临时服务器 127.0.0.1:${PORT}）`);
  const server = spawn(
    process.execPath,
    [path.join(ROOT, 'server', 'server.js'), '--no-open', '--port', String(PORT)],
    { cwd: ROOT, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
  );
  let exitCode;
  try {
    const up = await waitForServer(PORT);
    if (!up) {
      console.error('[full-verify] 服务器未能就绪，终止。');
      process.exit(1);
    }
    exitCode = (await runScript(path.join(ROOT, 'tools', 'integration-test.mjs'), ['--port', String(PORT)])) === 0 ? 0 : 1;
  } finally {
    server.kill();
  }
  if (exitCode !== 0) {
    console.error('\n[full-verify] 集成测试失败。');
    process.exit(1);
  }

  step('4/4 开发者工具链（typecheck + lint）');
  const hasDevDeps = fs.existsSync(path.join(ROOT, 'node_modules', 'eslint'));
  if (!hasDevDeps) {
    console.log('[full-verify] 未检测到 node_modules（未执行 npm install）——跳过本步。');
    console.log('              零安装承诺不变：普通使用者与答辩现场不需要这一步。');
  } else {
    const tscCode = await runBin('tsc', ['--noEmit']);
    if (tscCode === -1) {
      console.log('[full-verify] tsc 未安装，跳过类型检查。');
    } else if (tscCode !== 0) {
      console.error('\n[full-verify] 类型检查失败，终止。');
      process.exit(1);
    }
    const lintCode = await runBin('eslint', ['.']);
    if (lintCode === -1) {
      console.log('[full-verify] eslint 未安装，跳过 lint。');
    } else if (lintCode !== 0) {
      console.error('\n[full-verify] lint 失败（error 级），终止。');
      process.exit(1);
    }
  }

  console.log('\n=== full-verify 结果：全部通过 ===');
  process.exit(0);
}

main();
