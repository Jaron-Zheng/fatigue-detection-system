#!/usr/bin/env node
/**
 * screenshot.mjs — 无头浏览器批量截图工具（零依赖，Node ≥ 22 内置 WebSocket）
 *
 * 用法：
 *   node tools/screenshot.mjs --url http://127.0.0.1:5181/ --out system-delivery\comparison\after
 *
 * 原理：以远程调试模式启动本机 Edge/Chrome，通过 CDP（Chrome DevTools Protocol）
 * 导航、切主题、切视图后逐张 Page.captureScreenshot。
 * 用于 UI 回归取证：修改前后各跑一遍，产出可直接对比的截图。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const URL_TARGET = get('--url', 'http://127.0.0.1:5180/');
const OUT_DIR = path.resolve(get('--out', 'screenshots'));
const DEBUG_PORT = Number(get('--port', '9333'));

fs.mkdirSync(OUT_DIR, { recursive: true });

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
if (!browser) { console.error('未找到 Edge 或 Chrome 可执行文件'); process.exit(1); }
console.log('浏览器:', browser);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-profile-'));
const proc = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--window-size=1920,1080',
  'about:blank',
], { stdio: 'ignore', detached: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function waitForDebugger() {
  for (let i = 0; i < 40; i++) {
    try { return await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`); }
    catch { await sleep(300); }
  }
  throw new Error('远程调试端口未就绪');
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.consoleErrors = []; }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((ok, fail) => { this.ws.onopen = ok; this.ws.onerror = fail; });
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? 'uncaught exception');
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() { try { this.ws.close(); } catch { /* noop */ } }
}

async function shot(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('  ✓', name);
}

async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面脚本错误: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function setMetrics(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
}

async function main() {
  const targets = await waitForDebugger();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到页面 target');
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await setMetrics(cdp, 1920, 1080);

  console.log('导航到', URL_TARGET);
  await cdp.send('Page.navigate', { url: URL_TARGET });
  await sleep(4000); // 等字体/动效首屏稳定

  console.log('页面标题:', await evalJs(cdp, 'document.title'));

  /* ---------- 首页 ---------- */
  await evalJs(cdp, `document.documentElement.dataset.theme='light'`);
  await sleep(400);
  await shot(cdp, 'home-light.png');

  await evalJs(cdp, `window.scrollTo({top: Math.max(600, document.body.scrollHeight*0.45), behavior:'instant'})`);
  await sleep(1400); // 等滚动进场动效
  await shot(cdp, 'home-scroll-light.png');

  await evalJs(cdp, `window.scrollTo({top: document.body.scrollHeight, behavior:'instant'})`);
  await sleep(1400);
  await shot(cdp, 'home-bottom-light.png');

  await evalJs(cdp, `window.scrollTo({top:0,behavior:'instant'}); document.documentElement.dataset.theme='dark'`);
  await sleep(500);
  await shot(cdp, 'home-dark.png');

  /* ---------- 工作台 ---------- */
  await evalJs(cdp, `document.documentElement.dataset.theme='light'; document.querySelector('a[data-goto="viewWork"]')?.click()`);
  await sleep(1200);
  await shot(cdp, 'workbench-light.png');

  await evalJs(cdp, `document.documentElement.dataset.theme='dark'`);
  await sleep(400);
  await shot(cdp, 'workbench-dark.png');

  /* 专业模式（在工作台打开） */
  await evalJs(cdp, `document.documentElement.dataset.theme='light'; try{ var b=document.getElementById('btnProMode'); if(b && (b.getAttribute('aria-pressed')!=='true')) b.click(); }catch(e){}`);
  await sleep(800);
  await shot(cdp, 'workbench-pro-light.png');

  /* ---------- 设置抽屉 ---------- */
  await evalJs(cdp, `try{ document.getElementById('btnSettings')?.click(); }catch(e){}`);
  await sleep(900);
  await shot(cdp, 'settings-drawer.png');
  await evalJs(cdp, `try{ document.getElementById('btnCloseSheet')?.click(); }catch(e){}`);
  await sleep(600);

  /* ---------- 报告页 ---------- */
  await evalJs(cdp, `document.querySelector('a[data-goto="viewReport"]')?.click()`);
  await sleep(1200);
  await shot(cdp, 'report-light.png');

  await evalJs(cdp, `document.documentElement.dataset.theme='dark'`);
  await sleep(400);
  await shot(cdp, 'report-dark.png');

  /* ---------- 1366×768 响应式 ---------- */
  await setMetrics(cdp, 1366, 768);
  await evalJs(cdp, `document.documentElement.dataset.theme='light'; document.querySelector('a[data-goto="viewHome"]')?.click(); window.scrollTo({top:0,behavior:'instant'})`);
  await sleep(1200);
  await shot(cdp, 'home-1366x768.png');
  await evalJs(cdp, `document.querySelector('a[data-goto="viewWork"]')?.click()`);
  await sleep(1200);
  await shot(cdp, 'workbench-1366x768.png');

  /* ---------- 移动端 390×844 ---------- */
  await setMetrics(cdp, 390, 844);
  await evalJs(cdp, `document.querySelector('a[data-goto="viewHome"]')?.click(); window.scrollTo({top:0,behavior:'instant'})`);
  await sleep(1200);
  await shot(cdp, 'home-mobile-390.png');

  console.log('控制台错误:', cdp.consoleErrors.length ? JSON.stringify(cdp.consoleErrors, null, 2) : '无');
  cdp.close();
  try { process.kill(-proc.pid); } catch { proc.kill(); }
  await sleep(1200); // 等浏览器进程完全释放临时目录
  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log('截图完成 →', OUT_DIR);
}

main().catch(async (e) => { console.error('失败:', e.message); try { proc.kill(); } catch { /* noop */ } process.exit(1); });
