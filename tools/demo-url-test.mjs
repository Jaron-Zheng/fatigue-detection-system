#!/usr/bin/env node
/**
 * demo-url-test.mjs — 演示模式 URL 直达与设置面板端到端探针
 * 1) ?demo=moderate 直达演示：自动进工作台、进入运行态、抽屉关闭
 * 2) 首页收尾段「进入实时检测」死链修复
 * 3) 报告页空态：无报告时引导卡可见、下载按钮禁用
 * 4) 设置抽屉开演示开关：抽屉自动关闭 + 自动跳工作台（F2d 审计新增）
 * 5) ?demo=awake 剧本起点：加载 3s 后阶段应为「清醒」（F2e 审计新增）
 *
 * 【F2a·审计加固】弃用本文件内嵌的精简 Cdp 类，改 import 共享 cdp-util.mjs：
 *   其 Cdp 自带 Runtime.exceptionThrown / console.error 收集与调试端口占用检查，
 *   本工具由此获得「每个探针结束断言无控制台错误」的能力（F2b）。
 * 【F2f·审计加固】调试端口 9347 → 9353：与 perf-profile 默认端口撞车，并行必冲突。
 *
 * 用法：
 *   node tools/demo-url-test.mjs              # 自起临时服务器 5197，跑完自动停
 *   node tools/demo-url-test.mjs --url http://127.0.0.1:5180   # 复用已启动的服务器
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHeadless, evalJs, sleep } from './cdp-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const URL_OVERRIDE = get('--url', null);
const SERVER_PORT = Number(get('--server-port', '5197'));
// 【F2f】与 perf-profile（9349）错开；旧值 9347 正是撞车源头
const DEBUG_PORT = 9353;

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}`); };

/** 【F7a】自起临时服务器（--no-open），返回停止函数 */
async function startServer(port) {
  // ELECTRON_RUN_AS_NODE：本测试可能运行在 Electron-as-Node 环境，
  // 子进程需继承同一运行时语义（与 regression-test [13] 一致）
  const proc = spawn(process.execPath, [
    path.join(ROOT, 'server', 'server.js'), '--port', String(port), '--no-open',
  ], { stdio: 'ignore', env: { ...process.env, NO_OPEN: '1', ELECTRON_RUN_AS_NODE: '1' } });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      if (r.ok) { ready = true; break; }
    } catch { /* 未就绪，继续等 */ }
    await sleep(300);
  }
  if (!ready) { try { proc.kill(); } catch { /* noop */ } throw new Error(`临时服务器 ${port} 未就绪`); }
  return async () => { try { proc.kill(); } catch { /* noop */ } await sleep(300); };
}

/** 每个探针独立开一个干净的无头页面；探针收口统一断言无控制台错误（F2b） */
async function withPage(fn) {
  const session = await launchHeadless({ debugPort: DEBUG_PORT, width: 1440, height: 900 });
  try {
    await fn(session.cdp);
    // 【F2b·审计加固】每个探针结束时断言无控制台错误：
    // 探针 DOM 断言全过但页面在抛异常的链路不可信
    const errs = session.cdp.consoleErrors;
    ok('探针期间无控制台错误', errs.length === 0);
    if (errs.length) console.error('    控制台错误明细:', JSON.stringify(errs, null, 2));
  } finally {
    await session.close();
  }
}

let stopServer = null;

async function main() {
  let BASE;
  if (URL_OVERRIDE) {
    BASE = URL_OVERRIDE.replace(/\/+$/, '');
  } else {
    stopServer = await startServer(SERVER_PORT);
    BASE = `http://127.0.0.1:${SERVER_PORT}`;
  }
  console.log(`目标地址: ${BASE}`);

  try {
    /* ---- 探针 1：?demo=moderate ---- */
    await withPage(async (cdp) => {
      await cdp.send('Page.navigate', { url: `${BASE}/?demo=moderate` });
      await sleep(4500);
      console.log('[1] ?demo=moderate 直达演示');
      ok('页面标题正确加载（非错误页）', await evalJs(cdp, `(()=>document.title.includes('疲劳检测'))()`));
      ok('工作台视图激活', await evalJs(cdp, `(()=>document.getElementById('viewWork').classList.contains('active'))()`));
      ok('导航高亮在实时检测', await evalJs(cdp, `(()=>document.querySelector('.gn-links a[data-goto="viewWork"]').getAttribute('aria-current') === 'page')()`));
      ok('状态为演示中', await evalJs(cdp, `(()=>document.getElementById('navStatusText').textContent.includes('演示'))()`));
      ok('设置抽屉未打开', await evalJs(cdp, `(()=>!document.getElementById('sheet').classList.contains('open'))()`));
      ok('舞台遮罩已隐藏（运行中）', await evalJs(cdp, `(()=>document.getElementById('stageOverlay').hidden)()`));
      const phase = await evalJs(cdp, `(()=>{ const p = window.__fatigue?.app?.sim?.phaseName || (document.getElementById('scoreReason')?.textContent || ''); return p; })()`);
      ok(`剧本阶段处于中度（实测 scoreReason/phase: ${String(phase).slice(0, 30)}）`,
        /中度/.test(String(phase)));
    });

    /* ---- 探针 2：死链修复 ---- */
    await withPage(async (cdp) => {
      await cdp.send('Page.navigate', { url: `${BASE}/` });
      await sleep(3500);
      console.log('[2] 首页收尾段「进入实时检测」');
      await evalJs(cdp, `(()=>{ window.scrollTo({top: document.body.scrollHeight, behavior: 'instant'}); })()`);
      await sleep(600);
      const urlBefore = await evalJs(cdp, `(()=>location.href)()`);
      await evalJs(cdp, `(()=>{ document.querySelector('.ts-final-cta a[data-goto="viewWork"]')?.click(); })()`);
      await sleep(900);
      const active = await evalJs(cdp, `(()=>document.getElementById('viewWork').classList.contains('active'))()`);
      ok('点击后进入工作台视图', active);
      // 【F2c·审计加固】原断言 `location.href === urlBefore || true` 恒真，形同虚设；
      // 改为真断言：死链修复后点击只做同页视图切换，不得发生文档级跳转，
      // 也不得在 URL 上留下 hash（链接 href="#" 未被 preventDefault 的回归信号）
      const hrefAfter = await evalJs(cdp, `(()=>location.href)()`);
      const hashAfter = await evalJs(cdp, `(()=>location.hash)()`);
      ok('URL 未发生文档级跳转且未产生 hash', hrefAfter === urlBefore && !hashAfter);
    });

    /* ---- 探针 3：报告空态 ---- */
    await withPage(async (cdp) => {
      await cdp.send('Page.navigate', { url: `${BASE}/` });
      await sleep(3500);
      console.log('[3] 报告页空态');
      await evalJs(cdp, `(()=>{ document.querySelector('.gn-links a[data-goto="viewReport"]')?.click(); })()`);
      await sleep(900);
      ok('空态引导卡可见', await evalJs(cdp, `(()=>{ const e = document.getElementById('rpEmpty'); return !!e && !e.hidden && e.offsetParent !== null; })()`));
      ok('下载报告按钮禁用', await evalJs(cdp, `(()=>{ const b = document.getElementById('btnPrint'); return b.disabled === true; })()`));
      const emptyBtn = await evalJs(cdp, `(()=>!!document.querySelector('#rpEmpty button, #rpEmpty a'))()`);
      ok('空态提供动作按钮', emptyBtn);
    });

    /* ---- 探针 4（F2d·审计新增）：设置抽屉 · 演示模式开关联动 ---- */
    /* 实测校准：状态机（session-state-machine.js）只允许会话中 SIM_ENTER；
     * IDLE 拨开关 = 仅标记 + 抽屉让位（app.js：须经「开始检测」正规链路进入）；
     * 「抽屉关闭 + 自动跳工作台」完整语义发生在会话中拨开关（setSimulate 的
     * SIM_ENTER 分支：settings.hide() + router.gotoView('viewWork')）。
     * 两条路径分别锁定，断言不弱化。 */
    await withPage(async (cdp) => {
      await cdp.send('Page.navigate', { url: `${BASE}/` });
      await sleep(3500);
      console.log('[4] 设置抽屉 · 演示模式开关联动（IDLE 态）');
      await evalJs(cdp, `(()=>{ document.getElementById('btnSettings').click(); })()`);
      await sleep(900);
      ok('点击设置后抽屉打开（.open）', await evalJs(cdp, `(()=>document.getElementById('sheet').classList.contains('open'))()`));
      // 拨 swSimulate 开关：设 checked=true 并派发 change，与用户真实拨动等价
      await evalJs(cdp, `(()=>{ const sw = document.getElementById('swSimulate'); sw.checked = true; sw.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(1200);
      // setSimulate(true) 无条件 settings.hide()：抽屉必须让位，否则用户错过剧本开头
      ok('开启演示后抽屉自动关闭', await evalJs(cdp, `(()=>!document.getElementById('sheet').classList.contains('open'))()`));
      // IDLE 态状态机拒绝 SIM_ENTER：不得擅自跳视图/启动会话，须等用户点「开始检测」
      ok('IDLE 下开启演示不擅自跳转视图（仍停留在首页）', await evalJs(cdp, `(()=>document.getElementById('viewHome').classList.contains('active'))()`));
      // 拨回 false 清理，避免影响后续探针
      await evalJs(cdp, `(()=>{ const sw = document.getElementById('swSimulate'); if (sw.checked) { sw.checked = false; sw.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
      await sleep(600);
    });

    /* ---- 探针 4B（F2d·审计新增）：会话中拨演示开关 → 抽屉关闭 + 自动跳工作台 ---- */
    await withPage(async (cdp) => {
      await cdp.send('Page.navigate', { url: `${BASE}/?demo=moderate` });
      await sleep(4500);
      console.log('[4B] 会话中开启演示：抽屉让位 + 自动跳工作台');
      // 先离开工作台回首页，让「自动跳回工作台」断言有分辨力
      await evalJs(cdp, `(()=>{ document.querySelector('.gn-links a[data-goto="viewHome"]').click(); })()`);
      await sleep(900);
      ok('前置：已切回首页视图', await evalJs(cdp, `(()=>document.getElementById('viewHome').classList.contains('active'))()`));
      await evalJs(cdp, `(()=>{ document.getElementById('btnSettings').click(); })()`);
      await sleep(900);
      ok('会话中可打开设置抽屉', await evalJs(cdp, `(()=>document.getElementById('sheet').classList.contains('open'))()`));
      // 会话中拨演示开关：RUNNING → SIM_ENTER 自迁移（换数据源重启会话）
      await evalJs(cdp, `(()=>{ const sw = document.getElementById('swSimulate'); sw.checked = true; sw.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(1200);
      ok('开启演示后抽屉自动关闭', await evalJs(cdp, `(()=>!document.getElementById('sheet').classList.contains('open'))()`));
      ok('开启演示后自动跳转工作台（viewWork active）', await evalJs(cdp, `(()=>document.getElementById('viewWork').classList.contains('active'))()`));
      // 拨回 false 清理：SIM_EXIT → IDLE，停掉演示会话，避免影响后续探针
      await evalJs(cdp, `(()=>{ const sw = document.getElementById('swSimulate'); if (sw.checked) { sw.checked = false; sw.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
      await sleep(600);
    });

    /* ---- 探针 5（F2e·审计新增）：?demo=awake 剧本起点 ---- */
    await withPage(async (cdp) => {
      await cdp.send('Page.navigate', { url: `${BASE}/?demo=awake` });
      await sleep(3000);
      console.log('[5] ?demo=awake 剧本起点');
      // 优先读 window.__fatigue 测试钩子的 simPhase（test-hooks.js 的 getter
      // 同步返回 app.sim.phaseName），不依赖 UI 渲染时序，零 flaky；
      // 清醒阶段长 25s，加载 3s 后断言远在阶段边界内，稳定成立
      const phase = await evalJs(cdp, `(()=>window.__fatigue?.simPhase ?? window.__fatigue?.app?.sim?.phaseName ?? null)()`);
      ok(`加载 3s 后剧本阶段为「清醒」（实测 ${phase}）`, phase === '清醒');
    });
  } finally {
    if (stopServer) await stopServer();
  }

  console.log(`\n=== demo-url-test 结果: ${pass} 通过, ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error('失败:', e.message);
  if (stopServer) await stopServer();
  process.exit(1);
});
