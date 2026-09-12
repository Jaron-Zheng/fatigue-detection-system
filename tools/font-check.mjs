#!/usr/bin/env node
/**
 * font-check.mjs — --font-sans 字体栈在本机（Windows）的落地验证（第三轮角色十五）
 *
 * DESIGN.md「字体替代」一节建议非苹果平台用 Inter 兜底——那是针对英文正文写的。
 * Inter 是纯拉丁字符字体，不含任何中文字形；本项目是全中文界面，照抄该建议
 * 会让中文全部落到末位兜底、英文落到 Inter，中西文观感割裂。
 * tokens.css 因此写成：
 *   "SF Pro SC", "SF Pro Text", "SF Pro Icons", "PingFang SC",
 *   "Helvetica Neue", "Microsoft YaHei", Helvetica, Arial, sans-serif
 * macOS 命中苹方，Windows 命中微软雅黑——中西文由同一字体渲染，观感统一。
 *
 * 本脚本用 document.fonts.check() 实测当前机器上字体栈的命中情况，
 * 并对含 "PERCLOS / EAR / MAR / GPU / FPS" 英文缩写混排中文的专业模式
 * 界面截图取证（docs-evidence/design-audit/font-check-*.png）。
 *
 * 用法：node tools/font-check.mjs [--url http://127.0.0.1:5180/] [--port 9359]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHeadless, evalJs, shot, sleep } from './cdp-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const URL_TARGET = get('--url', 'http://127.0.0.1:5180/');
const OUT = path.join(ROOT, 'docs-evidence', 'design-audit');

const session = await launchHeadless({ debugPort: Number(get('--port', 9359)) });
try {
  await session.cdp.send('Page.navigate', { url: URL_TARGET });
  await sleep(3500);

  const probe = await evalJs(session.cdp, `(() => {
    const families = ['SF Pro SC', 'SF Pro Text', 'PingFang SC', 'Helvetica Neue', 'Microsoft YaHei', 'Inter', 'Arial'];
    const checks = Object.fromEntries(families.map((f) => [f, document.fonts.check('16px "' + f + '"')]));
    const stack = getComputedStyle(document.body).fontFamily;
    // 混排样本元素里的实际字号（验证中英文落在同一 font-size 体系）
    const metricLabel = document.querySelector('.metric-label');
    return {
      checks,
      stack,
      platform: navigator.platform,
      ua: navigator.userAgent.match(/Windows NT [\\d.]+|Mac OS X [\\d_.]+/) ? navigator.userAgent.match(/Windows NT [\\d.]+|Mac OS X [\\d_.]+/)[0] : 'unknown',
      sampleFontSize: metricLabel ? getComputedStyle(metricLabel).fontSize : null,
    };
  })()`);

  console.log('=== --font-sans 本机命中实测 ===');
  console.log(`平台：${probe.ua}`);
  console.log(`字体栈：${probe.stack}`);
  for (const [fam, ok] of Object.entries(probe.checks)) {
    console.log(`  ${ok ? '✓ 可用' : '✗ 缺失'}：${fam}`);
  }
  const macFonts = ['SF Pro SC', 'SF Pro Text', 'PingFang SC'].filter((f) => probe.checks[f]);
  const winFont = probe.checks['Microsoft YaHei'];
  if (macFonts.length > 0) {
    console.log(`结论：本机命中 ${macFonts.join('/')}（字体栈首位）——该字体同时含中文与拉丁字形，`);
    console.log('      PERCLOS/GPU/FPS 等缩写与中文混排观感统一。未装 SF 的典型 Windows 机器');
    console.log(`      会落到 Microsoft YaHei（本机${winFont ? '同样可用' : '不可用'}），同样是中西文一体字体。`);
  } else if (winFont) {
    console.log('结论：Windows 环境无 SF/苹方，字体栈按设计落到 Microsoft YaHei，');
    console.log('      中文与 PERCLOS/GPU/FPS 等英文缩写由同一字体渲染，观感统一。');
  }
  console.log('      不采用 DESIGN.md 字面的 Inter 建议：Inter 是纯拉丁字体、无中文字形，');
  console.log('      照抄会让中文二次回落到末位字体，中西文观感割裂。');
  if (probe.checks['Inter']) {
    console.log('提示：本机装有 Inter，但项目刻意不引用它（中文字形缺失）。');
  }

  // 专业模式截图：指标卡含 PERCLOS/EAR/MAR 等缩写，设置抽屉含 GPU/FPS 文案
  await evalJs(session.cdp, `(() => { if (!document.body.classList.contains('pro-mode')) window.__fatigue.app.chrome.toggleProMode(); document.documentElement.dataset.theme = 'light'; return true; })()`);
  await evalJs(session.cdp, `window.__fatigue.app.router.gotoView('viewWork')`);
  await sleep(600);
  await shot(session.cdp, 'font-check-pro-light.png', OUT);
  await evalJs(session.cdp, `document.documentElement.dataset.theme = 'dark'`);
  await sleep(500);
  await shot(session.cdp, 'font-check-pro-dark.png', OUT);
  console.log(`截图取证 → docs-evidence/design-audit/font-check-pro-*.png（专业模式，含英文缩写混排）`);
} finally {
  await session.close();
}
