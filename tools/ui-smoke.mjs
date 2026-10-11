#!/usr/bin/env node
/**
 * ui-smoke.mjs — 浏览器端功能冒烟测试（CDP 无头浏览器 + 演示模式）
 *
 * 回归测试（regression-test.mjs）覆盖不到 app.js，因为它耦合了 DOM；
 * 本脚本用无头浏览器真实加载页面，通过 window.__fatigue 测试钩子驱动
 * 完整链路：页面加载 → 演示模式启动 → 主循环产数 → 暂停/恢复 → 结束出报告。
 *
 * 用途：app.js 重构（第三轮角色二）前后各跑一遍，行为必须一致。
 *
 * 用法：node tools/ui-smoke.mjs --url http://127.0.0.1:5180/ [--seconds 20]
 */
import { launchHeadless, evalJs, sleep } from './cdp-util.mjs';

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const URL_TARGET = get('--url', 'http://127.0.0.1:5180/');
const RUN_SECONDS = Number(get('--seconds', '20'));

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
};

const session = await launchHeadless({ debugPort: 9341 });
const { cdp } = session;

// 全局看门狗：任何一步挂死都不能无限阻塞，超时后如实报失败
const watchdog = setTimeout(() => {
  console.error('\n  ✗ 看门狗超时：测试链路挂死，强制退出');
  session.close().finally(() => process.exit(1));
}, (RUN_SECONDS + 90) * 1000);

try {
  console.log(`=== UI 冒烟测试 → ${URL_TARGET} ===\n`);
  await cdp.send('Page.navigate', { url: URL_TARGET });
  await sleep(3500);

  console.log('[1] 页面加载');
  const title = await evalJs(cdp, 'document.title');
  assert(typeof title === 'string' && title.length > 0, `页面标题正常 (${title})`);
  assert(await evalJs(cdp, 'Boolean(window.__fatigue)'), '__fatigue 测试钩子存在');
  assert(await evalJs(cdp, 'document.querySelectorAll(".view").length === 3'), '三个视图存在');

  console.log('\n[2] 演示模式启动');
  const state = await evalJs(cdp, 'window.__fatigue.startSimulation()');
  assert(state === 'running', `startSimulation 后状态为 running (got ${state})`);
  await sleep(2000);
  const score0 = await evalJs(cdp, 'window.__fatigue.score');
  assert(score0 !== null && !Number.isNaN(score0), `主循环产出疲劳分数 (${score0})`);

  console.log(`\n[3] 运行 ${RUN_SECONDS}s 采样`);
  await sleep(RUN_SECONDS * 1000);
  const snap1 = await evalJs(cdp, `JSON.stringify({
    state: window.__fatigue.state,
    score: window.__fatigue.score,
    level: window.__fatigue.level,
    phase: window.__fatigue.simPhase,
    totals: window.__fatigue.eventTotals,
  })`);
  const s1 = JSON.parse(snap1);
  assert(s1.state === 'running', `持续运行中 (state=${s1.state})`);
  assert(s1.score !== null && s1.score >= 0 && s1.score <= 100, `分数在 0-100 (got ${s1.score})`);
  assert(typeof s1.level === 'string', `等级有效 (${s1.level})`);

  console.log('\n[4] 暂停 / 恢复');
  await evalJs(cdp, 'window.__fatigue.app.togglePause()');
  await sleep(400);
  assert(await evalJs(cdp, 'window.__fatigue.state') === 'paused', '暂停生效');
  await evalJs(cdp, `window.__fatigue.app.togglePause()`);
  await sleep(400);
  assert(await evalJs(cdp, 'window.__fatigue.state') === 'running', '恢复生效');

  console.log('\n[5] 结束并生成报告');
  await evalJs(cdp, 'window.__fatigue.stop()');
  await sleep(800);
  assert(await evalJs(cdp, 'window.__fatigue.state') === 'report', '结束后进入 report 状态');
  assert(await evalJs(cdp, 'document.getElementById("viewReport").classList.contains("active")'), '报告视图已激活');
  // 【F3a·审计加固】锁 switchView 下沉后的导航高亮：结束会话走 router.switchView
  // 而非 gotoView，若高亮更新没下沉到统一出口，此处会漏高亮（view-router.js 单一事实来源）
  assert(await evalJs(cdp, `(()=>document.querySelector('.gn-links a[data-goto="viewReport"]').getAttribute('aria-current') === 'page')()`),
    '报告导航高亮 aria-current="page"');
  const reportTitle = await evalJs(cdp, 'document.getElementById("rpTitle")?.textContent || ""');
  assert(reportTitle.length > 0, `报告标题已渲染 (${reportTitle})`);
  // 【F3b·审计加固】锁报告数值口径：rpAvgScore 必须是 toFixed(1) 的一位小数
  // 或数据不足时的 '--'（report.js render 的两种合法输出），拦截整数/多位小数回归
  const avgScore = await evalJs(cdp, `(()=>document.getElementById('rpAvgScore')?.textContent || '')()`);
  assert(avgScore === '--' || /^\d+\.\d$/.test(avgScore), `平均疲劳指数为一位小数或 '--' (got '${avgScore}')`);

  console.log('\n[6] 控制台错误');
  assert(cdp.consoleErrors.length === 0, `无控制台错误 (${cdp.consoleErrors.length} 条)`);
  if (cdp.consoleErrors.length) console.error(JSON.stringify(cdp.consoleErrors, null, 2));
} catch (err) {
  failed++;
  console.error('  ✗ 冒烟测试异常:', err.message);
} finally {
  await session.close();
}

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
clearTimeout(watchdog);
process.exit(failed > 0 ? 1 : 0);
