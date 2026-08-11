#!/usr/bin/env node
/**
 * a11y-test.mjs — 无障碍自动化扫描（第三轮角色六）
 *
 * 复用 cdp-util.mjs 的无头浏览器基础设施，在页面加载完成后注入 axe-core
 * （从本地 node_modules 读取脚本内容注入，不依赖运行时联网 CDN），
 * 对首页、工作台（普通/专业模式）、报告页、设置抽屉在浅色/深色主题下
 * 分别扫描，汇总 critical / serious 级别违规项。
 *
 * 输出格式对齐 integration-test.mjs 的通过/失败统计风格；
 * 完整扫描记录写入 docs-evidence/a11y-<时间戳>.json。
 *
 * 依赖：axe-core（devDependency，需先执行一次 npm install，仅开发者需要）。
 *
 * 用法：node tools/a11y-test.mjs [--url http://127.0.0.1:5180/] [--port 9351]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHeadless, evalJs, sleep } from './cdp-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const URL_TARGET = get('--url', 'http://127.0.0.1:5180/');

const AXE_PATH = path.join(ROOT, 'node_modules', 'axe-core', 'axe.min.js');
if (!fs.existsSync(AXE_PATH)) {
  console.error('缺少 axe-core，请先执行 npm install（仅开发者工具链依赖）');
  process.exit(1);
}
const axeSource = fs.readFileSync(AXE_PATH, 'utf8');

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
};

const session = await launchHeadless({ debugPort: Number(get('--port', 9351)) });
const { cdp } = session;
const report = { date: new Date().toISOString(), url: URL_TARGET, scenarios: [] };

const watchdog = setTimeout(() => {
  console.error('\n  ✗ 看门狗超时：扫描挂死，强制退出');
  session.close().finally(() => process.exit(1));
}, 300000);

try {
  console.log(`=== 无障碍自动化扫描（axe-core）→ ${URL_TARGET} ===\n`);
  await cdp.send('Page.navigate', { url: URL_TARGET });
  await sleep(3500);

  // 注入 axe-core：通过 Runtime.evaluate 直接执行本地脚本内容。
  // 不能用 <script textContent> 插入的方式——服务器 CSP（script-src 'self'）会拦截内联脚本；
  // CDP 求值走调试通道，不受 CSP 约束。
  await evalJs(cdp, axeSource);
  const injected = await evalJs(cdp, 'window.axe && window.axe.version ? String(window.axe.version) : (window.axe && window.axe.run ? "ok(no version field)" : null)');
  assert(typeof injected === 'string', `axe-core 注入成功（version=${injected}）`);

  // 切主题后必须触发与真实用户一致的重绘（toggleTheme 会延迟 60ms 重取图表颜色），
  // 否则报告色带等"渲染时取色"的组件会留下上一主题的内联色，扫描结果不反映真实使用场景
  const setTheme = async (t) => {
    await evalJs(cdp, `(() => { document.documentElement.dataset.theme = ${JSON.stringify(t)}; window.__fatigue.app._onThemeChanged(); return document.documentElement.dataset.theme; })()`);
    await sleep(350);
    return t;
  };
  const gotoView = (id) => evalJs(cdp, `(() => { window.__fatigue.app.router.gotoView(${JSON.stringify(id)}); return document.getElementById(${JSON.stringify(id)}).classList.contains('active'); })()`);

  /** 对当前页面状态跑一次 axe，返回按 impact 归类的违规 */
  async function scan(name) {
    const raw = await evalJs(cdp, `(async () => {
      const r = await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'best-practice'] },
        resultTypes: ['violations'],
      });
      return JSON.stringify(r.violations.map(v => ({
        id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length,
        target: v.nodes.slice(0, 3).map(n => n.target.join(' ')),
        details: v.id === 'color-contrast' ? v.nodes.map(n => ({ t: n.target.join(' '), m: (n.any || []).concat(n.all || [], n.none || []).map(c => c.message).join(' ') })) : undefined,
      })));
    })()`);
    const violations = JSON.parse(raw);
    const critical = violations.filter((v) => v.impact === 'critical');
    const serious = violations.filter((v) => v.impact === 'serious');
    const moderate = violations.filter((v) => v.impact === 'moderate' || v.impact === 'minor');
    report.scenarios.push({ name, violations });
    console.log(`\n[${name}] critical=${critical.length} serious=${serious.length} moderate/minor=${moderate.length}`);
    for (const v of [...critical, ...serious]) {
      console.log(`    ${v.impact === 'critical' ? '✗' : '!'} ${v.id} (${v.impact}, ${v.nodes} 处) ${v.help}`);
      for (const t of v.target) console.log(`        @ ${t}`);
      if (v.details) for (const d of v.details) {
        const m = d.m && d.m.match(/contrast of ([\d.]+) \(foreground color: (#[0-9a-f]+), background color: (#[0-9a-f]+), font size: ([^,]+), font weight: ([^.)]+)/);
        console.log(m ? `        ${d.t} ratio=${m[1]} fg=${m[2]} bg=${m[3]} ${m[4].trim()}/${m[5].trim()}` : `        ${d.t} ${d.m}`);
      }
    }
    assert(critical.length === 0, `${name}：critical 级违规清零`);
    return { critical, serious };
  }

  // —— 场景 1/2：首页（浅/深） ——
  await gotoView('viewHome');
  await setTheme('light'); await sleep(500);
  await scan('首页 · 浅色');
  await setTheme('dark'); await sleep(500);
  await scan('首页 · 深色');

  // —— 场景 3/4：工作台普通模式（浅/深） ——
  await gotoView('viewWork');
  await setTheme('light'); await sleep(500);
  await scan('工作台 · 普通 · 浅色');
  await setTheme('dark'); await sleep(500);
  await scan('工作台 · 普通 · 深色');

  // —— 场景 5/6：工作台专业模式（浅/深） ——
  await evalJs(cdp, `(() => { if (!document.body.classList.contains('pro-mode')) window.__fatigue.app.chrome.toggleProMode(); return document.body.classList.contains('pro-mode'); })()`);
  await sleep(500);
  await setTheme('light'); await sleep(500);
  await scan('工作台 · 专业 · 浅色');
  await setTheme('dark'); await sleep(500);
  await scan('工作台 · 专业 · 深色');

  // —— 场景 7/8：报告页（先跑一段演示模式产出真实报告数据） ——
  await evalJs(cdp, 'window.__fatigue.startSimulation()');
  await sleep(6000);
  await evalJs(cdp, 'window.__fatigue.stop()');
  await sleep(1200);
  const reportActive = await evalJs(cdp, 'document.getElementById("viewReport").classList.contains("active")');
  assert(reportActive, '报告页已生成并激活');
  await setTheme('light'); await sleep(600);
  await scan('报告页 · 浅色');
  await setTheme('dark'); await sleep(600);
  await scan('报告页 · 深色');

  // —— 场景 9/10：设置抽屉（浅/深） ——
  await evalJs(cdp, 'document.getElementById("btnSettings").click()');
  await sleep(700);
  const sheetOpen = await evalJs(cdp, 'document.getElementById("sheet").classList.contains("open")');
  assert(sheetOpen, '设置抽屉已打开');
  await setTheme('light'); await sleep(500);
  await scan('设置抽屉 · 浅色');
  await setTheme('dark'); await sleep(500);
  await scan('设置抽屉 · 深色');
  await evalJs(cdp, 'document.getElementById("btnCloseSheet").click()');
  await sleep(400);

  // 控制台错误检查
  assert(cdp.consoleErrors.length === 0, `扫描全程无控制台错误 (${cdp.consoleErrors.length} 条)`);
} catch (err) {
  failed++;
  console.error('  ✗ 扫描异常:', err.message);
} finally {
  const outDir = path.join(ROOT, 'docs-evidence');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `a11y-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n扫描记录 → ${outFile}`);
  await session.close();
}

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
clearTimeout(watchdog);
process.exit(failed > 0 ? 1 : 0);
