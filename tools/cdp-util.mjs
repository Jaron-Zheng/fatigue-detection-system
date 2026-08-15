/**
 * cdp-util.mjs — 无头浏览器 CDP 控制共享基础设施（零依赖，Node ≥ 22 内置 WebSocket）
 *
 * screenshot.mjs 最早内置了这套"启动无头 Edge/Chrome → CDP 连接 → 导航 / 求值 / 截图"
 * 逻辑；第三轮起多个工具（UI 冒烟、假摄像头 e2e、无障碍扫描、性能剖析）都需要它，
 * 抽到此处共享，避免每个脚本各写一套浏览器启动逻辑。
 *
 * 用法：
 *   const session = await launchHeadless({ width: 1920, height: 1080, extraArgs: [...] });
 *   await session.cdp.send('Page.navigate', { url });
 *   await session.evalJs('document.title');
 *   await session.shot('name.png', outDir);
 *   await session.close();
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function findBrowser() {
  const browser = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
  if (!browser) throw new Error('未找到 Edge 或 Chrome 可执行文件');
  return browser;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.consoleMessages = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((ok, fail) => { this.ws.onopen = ok; this.ws.onerror = fail; });
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        this.consoleMessages.push({ type: msg.params.type, text });
        if (msg.params.type === 'error') this.consoleErrors.push(text);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const text = msg.params.exceptionDetails?.exception?.description ?? 'uncaught exception';
        this.consoleErrors.push(text);
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

/**
 * 启动无头浏览器并建立 CDP 连接。
 * @param {object} [options]
 * @param {number} [options.debugPort=9333] 远程调试端口
 * @param {number} [options.width=1920]
 * @param {number} [options.height=1080]
 * @param {string[]} [options.extraArgs] 追加的浏览器启动参数（如假摄像头参数）
 * @returns {Promise<{cdp:Cdp, proc:import('child_process').ChildProcess, userDataDir:string, close:()=>Promise<void>}>}
 */
export async function launchHeadless({ debugPort = 9333, width = 1920, height = 1080, extraArgs = [] } = {}) {
  // 防御：调试端口被残留浏览器进程占用时，会连到旧页面导致结果不可信
  try {
    const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) throw new Error(`调试端口 ${debugPort} 已被占用（可能有残留的无头浏览器），请先清理或换一个端口`);
  } catch (err) {
    if (err.message && err.message.includes('调试端口')) throw err;
    // fetch 失败 = 端口空闲，继续
  }
  const browser = findBrowser();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-profile-'));
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    ...extraArgs,
    'about:blank',
  ], { stdio: 'ignore', detached: true });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      targets = await res.json();
      break;
    } catch { await sleep(300); }
  }
  if (!targets) throw new Error('远程调试端口未就绪');

  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('未找到页面 target');
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  async function close() {
    cdp.close();
    try { process.kill(-proc.pid); } catch { proc.kill(); }
    await sleep(1200); // 等浏览器进程完全释放临时目录
    // 【F6·审计加固】Windows 上浏览器进程偶发未死透，rmSync 会抛 EBUSY/EPERM，
    // 把已经全部通过的测试翻转成非零退出码。临时目录清理失败只应留下垃圾文件，
    // 不应影响测试结论本身，故吞掉清理异常。
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* noop */ }
  }

  return { cdp, proc, userDataDir, close };
}

/** Runtime.evaluate 便捷封装：返回值传回 Node 侧，页面脚本异常时抛出 */
export async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面脚本错误: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

/** 截图保存到指定目录 */
export async function shot(cdp, name, outDir) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}
