/**
 * browser-launch.mjs — Playwright 跨平台浏览器启动器
 *
 * 背景：tools/ 下 playwright-core 系列测试脚本原先统一硬编码
 * `chromium.launch({ channel: 'msedge' })`，在没有安装 Edge 的
 * Linux / macOS 环境（CI、沙箱）直接抛 “Chromium distribution 'msedge'
 * is not found”，整套浏览器测试无法运行。cdp-util.mjs 早已具备跨平台
 * 浏览器发现能力（r3 P9），本模块把同一套发现逻辑接到 playwright 启动上。
 *
 * 行为约定（对原作者 Windows 开发机零影响）：
 *   1. 显式指定优先：CHROME_PATH / BROWSER_PATH / PUPPETEER_EXECUTABLE_PATH
 *      任一环境变量存在时，按其路径以 executablePath 启动（与 cdp-util 一致）；
 *   2. Windows 且未显式指定：保持原有 channel: 'msedge' 行为不变；
 *   3. 其他平台：经 cdp-util.findBrowser() 解析本机 Chrome/Chromium/Edge
 *      可执行文件，以 executablePath 启动。
 *
 * 用法（与原 chromium.launch 参数完全兼容）：
 *   import { launchBrowser } from './browser-launch.mjs';
 *   const browser = await launchBrowser({ headless: true, args: ['--no-sandbox'] });
 */
import { chromium } from 'playwright-core';
import { findBrowser } from './cdp-util.mjs';

export async function launchBrowser(options = {}) {
  const explicit =
    process.env.CHROME_PATH || process.env.BROWSER_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (!explicit && process.platform === 'win32') {
    // 原作者开发机路径：行为与修改前完全一致
    return chromium.launch({ channel: 'msedge', ...options });
  }
  // 容器/CI 的 /dev/shm 常只有 64MB，Chromium 高负载时渲染进程会因此崩溃
  // （chaos-test S15 起整段"浏览器已关闭"的根因），统一禁用 dev-shm。
  const args = [...(options.args || [])];
  if (!args.includes('--disable-dev-shm-usage')) args.push('--disable-dev-shm-usage');
  return chromium.launch({ executablePath: findBrowser(), ...options, args });
}
