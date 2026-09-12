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
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 浏览器可执行文件候选（r3 P9：补齐 Linux / macOS 路径，原先只有 4 个 Windows 路径，
 * 在其他平台直接抛"未找到"）。查找顺序：
 *   1. 环境变量 CHROME_PATH / BROWSER_PATH / PUPPETEER_EXECUTABLE_PATH（显式指定优先）
 *   2. 本平台常见安装路径
 *   3. PATH 中的常见命令名（google-chrome / chromium / msedge …）
 */
const LOCAL = process.env.LOCALAPPDATA || '';
export const BROWSER_CANDIDATES = {
  win32: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    LOCAL && path.join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    LOCAL && path.join(LOCAL, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean),
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/brave-browser',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
    '/opt/microsoft/msedge/msedge',
  ],
};
/** PATH 上尝试的命令名（跨平台） */
const PATH_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'msedge', 'chrome', 'brave-browser'];

function findOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const full = path.join(d, name + ext);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* 不存在，继续 */
      }
    }
  }
  return null;
}

/** 按 Playwright 缓存目录约定再兜一层（devDependencies 里有 playwright-core 的机器常见） */
function findPlaywrightChromium() {
  const base =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === 'win32'
      ? path.join(LOCAL, 'ms-playwright')
      : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
      : path.join(os.homedir(), '.cache', 'ms-playwright'));
  try {
    const dirs = fs
      .readdirSync(base)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const d of dirs) {
      const cands =
        process.platform === 'win32'
          ? [path.join(base, d, 'chrome-win', 'chrome.exe'), path.join(base, d, 'chrome-win64', 'chrome.exe')]
          : process.platform === 'darwin'
          ? [path.join(base, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')]
          : [path.join(base, d, 'chrome-linux', 'chrome'), path.join(base, d, 'chrome-linux64', 'chrome')];
      const hit = cands.find((p) => fs.existsSync(p));
      if (hit) return hit;
    }
  } catch {
    /* 无 Playwright 缓存 */
  }
  return null;
}

export function findBrowser() {
  for (const key of ['CHROME_PATH', 'BROWSER_PATH', 'PUPPETEER_EXECUTABLE_PATH']) {
    const p = process.env[key];
    if (p && fs.existsSync(p)) return p;
    if (p) console.warn(`[cdp-util] 环境变量 ${key}=${p} 指向的文件不存在，忽略`);
  }
  const list = BROWSER_CANDIDATES[process.platform] || BROWSER_CANDIDATES.linux;
  const local = list.find((p) => fs.existsSync(p));
  if (local) return local;
  for (const name of PATH_NAMES) {
    const hit = findOnPath(name);
    if (hit) return hit;
  }
  const pw = findPlaywrightChromium();
  if (pw) return pw;
  throw new Error(
    `未找到 Edge 或 Chrome 可执行文件（平台 ${process.platform}）。` +
      '请安装 Chrome/Edge/Chromium，或用环境变量 CHROME_PATH=/path/to/chrome 显式指定。'
  );
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
  // 防御：调试端口被残留浏览器进程占用时，会连到旧页面导致结果不可信。
  // demo-url-test 等工具会在同一端口高频启停浏览器，上一个进程刚被 close 杀掉时
  // 监听 socket 仍有数百毫秒残留（进程退出竞态），立即探测会误报"端口被占用"。
  // 这里给"端口仍应答"的情况一个短暂重试窗口，期间恢复空闲即继续；始终应答才报错。
  const portBusy = async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) });
      return res.ok;
    } catch {
      return false; // fetch 失败 = 端口空闲
    }
  };
  for (let waited = 0; (await portBusy()) && waited < 3000; waited += 300) {
    await new Promise((r) => setTimeout(r, 300));
  }
  if (await portBusy()) {
    throw new Error(`调试端口 ${debugPort} 已被占用（可能有残留的无头浏览器），请先清理或换一个端口`);
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
    // Windows 下 Edge 存在"兼容层重启"：spawn 出的 msedge 只是启动器，真正持有
    // 调试端口的浏览器进程是它的子进程，且启动器可能随即退出、真实进程被系统
    // 收养——按 proc.pid 杀树会扑空，残留进程占住端口导致同端口下一次
    // launchHeadless 误报"端口被占用"。因此改为按调试端口找监听进程整树终止。
    if (process.platform === 'win32') {
      try {
        const res = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
        const pids = new Set();
        for (const line of String(res.stdout || '').split('\n')) {
          if (line.includes(`:${debugPort} `) && line.includes('LISTENING')) {
            const pid = line.trim().split(/\s+/).pop();
            if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
          }
        }
        for (const pid of pids) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
      } catch { /* netstat/taskkill 不可用时退回按 pid 杀 */ }
    }
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    if (process.platform !== 'win32') {
      try { process.kill(-proc.pid); } catch { proc.kill(); }
    }
    // 等调试端口真正释放（而非固定睡一觉），消除同端口高频启停的竞态
    for (let waited = 0; (await portBusy()) && waited < 5000; waited += 300) {
      await new Promise((r) => setTimeout(r, 300));
    }
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
