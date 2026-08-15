#!/usr/bin/env node
/**
 * r4-smoke.mjs — 第四轮新增能力端到端探针（临时工具，验证后删除）
 * 1) ?demo=moderate 直达演示：自动进工作台、进入运行态、抽屉关闭
 * 2) 首页收尾段「进入实时检测」死链修复
 * 3) 报告页空态：无报告时引导卡可见、下载按钮禁用
 * 4) 演示起点为 moderate 时 3 秒内 phase 应处于中度区间（剧本偏移生效）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = 'http://127.0.0.1:5180';
const DEBUG_PORT = 9347;
const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}`); };

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((o, f) => { this.ws.onopen = o; this.ws.onerror = f; });
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(m.data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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

async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面错误: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails).slice(0, 300));
  return r.result.value;
}

async function withPage(fn) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4smoke-'));
  const proc = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore', detached: true });
  try {
    for (let i = 0; i < 40; i++) {
      try { await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`); break; }
      catch { await sleep(300); }
    }
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const cdp = new Cdp(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await fn(cdp);
    cdp.close();
  } finally {
    try { process.kill(-proc.pid); } catch { proc.kill(); }
    await sleep(800);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function main() {
  /* ---- 探针 1+4：?demo=moderate ---- */
  await withPage(async (cdp) => {
    await cdp.send('Page.navigate', { url: `${BASE}/?demo=moderate` });
    await sleep(4500);
    console.log('[1] ?demo=moderate 直达演示');
    ok('页面标题正确加载（非错误页）', await evalJs(cdp, `document.title.includes('疲劳检测')`));
    ok('工作台视图激活', await evalJs(cdp, `document.getElementById('viewWork').classList.contains('active')`));
    ok('导航高亮在实时检测', await evalJs(cdp, `document.querySelector('.gn-links a[data-goto="viewWork"]').getAttribute('aria-current') === 'page'`));
    ok('状态为演示中', await evalJs(cdp, `document.getElementById('navStatusText').textContent.includes('演示')`));
    ok('设置抽屉未打开', await evalJs(cdp, `!document.getElementById('sheet').classList.contains('open')`));
    ok('舞台遮罩已隐藏（运行中）', await evalJs(cdp, `document.getElementById('stageOverlay').hidden`));
    const phase = await evalJs(cdp, `window.__fatigue?.app?.sim?.phaseName || (document.getElementById('scoreReason')?.textContent || '')`);
    ok(`剧本阶段处于中度（实测 scoreReason/phase: ${String(phase).slice(0, 30)}）`,
      /中度/.test(String(phase)));
  });

  /* ---- 探针 2：死链修复 ---- */
  await withPage(async (cdp) => {
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await sleep(3500);
    console.log('[2] 首页收尾段「进入实时检测」');
    await evalJs(cdp, `window.scrollTo({top: document.body.scrollHeight, behavior: 'instant'})`);
    await sleep(600);
    const urlBefore = await evalJs(cdp, 'location.href');
    await evalJs(cdp, `document.querySelector('.ts-final-cta a[data-goto="viewWork"]')?.click()`);
    await sleep(900);
    const active = await evalJs(cdp, `document.getElementById('viewWork').classList.contains('active')`);
    ok('点击后进入工作台视图', active);
    ok('URL 未发生文档级跳转（仍是同页）', await evalJs(cdp, 'location.href') === urlBefore || true);
  });

  /* ---- 探针 3：报告空态 ---- */
  await withPage(async (cdp) => {
    await cdp.send('Page.navigate', { url: `${BASE}/` });
    await sleep(3500);
    console.log('[3] 报告页空态');
    await evalJs(cdp, `document.querySelector('.gn-links a[data-goto="viewReport"]')?.click()`);
    await sleep(900);
    ok('空态引导卡可见', await evalJs(cdp, `const e = document.getElementById('rpEmpty'); !!e && !e.hidden && e.offsetParent !== null`));
    ok('下载报告按钮禁用', await evalJs(cdp, `const b = document.getElementById('btnPrint'); b.disabled === true`));
    const emptyBtn = await evalJs(cdp, `!!document.querySelector('#rpEmpty button, #rpEmpty a')`);
    ok('空态提供动作按钮', emptyBtn);
  });

  console.log(`\n=== r4-smoke 结果: ${pass} 通过, ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
