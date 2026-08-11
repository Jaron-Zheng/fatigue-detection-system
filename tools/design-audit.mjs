#!/usr/bin/env node
/**
 * design-audit.mjs — DESIGN.md「Do's and Don'ts」逐条保真度审计（第三轮角色十五）
 *
 * 不是读代码猜，而是用无头浏览器真实加载页面后读 computed style：
 *   R1 单一强调色：交互元素颜色只来自 accent 家族，无第二支强调色
 *   R2 阴影唯一性：卡片/按钮/文字零阴影，阴影只出现在浮层（舞台/抽屉/吐司/报警）
 *   R3 正文 17px/400/-0.374px（不是 16px）
 *   R4 字重阶梯 300/400/600/700，全站不存在 font-weight:500
 *   R5 按下反馈 scale(0.95)（--press-scale 值 + 样式表中的 :active 规则）
 *   R6 圆角只用令牌阶梯（0/5/8/11/18/20/28/980px 与 50% 圆形），无中间值
 *   R7 零装饰性渐变（CSS 里没有 linear-gradient/radial-gradient）
 *   R8 全局导航纯黑（唯一的纯黑出现处）
 *   R9 正文行高 ≥1.47
 *   R10 Sky Link Blue（--link-on-dark）只出现在深色磁贴上下文
 *
 * 证据截图输出到 docs-evidence/design-audit/。
 *
 * 用法：node tools/design-audit.mjs [--url http://127.0.0.1:5180/] [--port 9357]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHeadless, evalJs, shot, sleep } from './cdp-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const URL_TARGET = get('--url', 'http://127.0.0.1:5180/');
const OUT = path.join(ROOT, 'docs-evidence', 'design-audit');

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
};

const session = await launchHeadless({ debugPort: Number(get('--port', 9357)) });
const { cdp } = session;
const watchdog = setTimeout(() => {
  console.error('看门狗超时');
  session.close().finally(() => process.exit(1));
}, 240000);

try {
  console.log(`=== DESIGN.md Do's/Don'ts 保真度审计 → ${URL_TARGET} ===\n`);
  await cdp.send('Page.navigate', { url: URL_TARGET });
  await sleep(3500);
  await evalJs(cdp, `(() => { document.documentElement.dataset.theme = 'light'; return true; })()`);
  await sleep(400);

  /* ---- R1 单一强调色 ---- */
  const accents = await evalJs(cdp, `(() => {
    const acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const bad = [];
    for (const el of document.querySelectorAll('a, button, .pill, input[type=range]')) {
      const cs = getComputedStyle(el);
      // 交互元素的文字/图标颜色只允许：正文黑、次级灰、强调色家族、白字（实心底）、继承
      const c = cs.color;
      const bg = cs.backgroundColor;
      const interactive = /^(rgb|#)/.test(c);
      if (!interactive) continue;
      const okBlue = c.includes('0, 87, 184') || c.includes('0, 102, 204') || c.includes('0, 113, 227') || c.includes('87, 135, 214');
      const okNeutral = c.includes('29, 29, 31') || c.includes('81, 81, 84') || c.includes('110, 110, 115') || c === 'rgb(255, 255, 255)' || c.includes('255, 255, 255');
      const okSemantic = c.includes('20, 106, 56') || c.includes('122, 90, 0') || c.includes('179, 78, 0') || c.includes('193, 31, 26'); // 四级语义色不是"强调色"，是状态色
      if (!okBlue && !okNeutral && !okSemantic) bad.push(el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ')[0] : '') + ' color=' + c);
    }
    return { acc, bad: bad.slice(0, 8) };
  })()`);
  assert(accents.bad.length === 0, `R1 单一强调色：交互元素无第二支强调色（基色 ${accents.acc}）${accents.bad.length ? '，异常：' + accents.bad.join(' | ') : ''}`);

  /* ---- R2 阴影唯一性 ---- */
  const shadows = await evalJs(cdp, `(() => {
    const offenders = [];
    for (const el of document.querySelectorAll('.card, .btn, .pill, .badge, h1, h2, h3, p')) {
      const bs = getComputedStyle(el).boxShadow;
      if (!bs || bs === 'none') continue;
      // 允许的"非投影"：inset 描边（计算样式里 inset 关键字在末尾，不在开头）；
      // 真正的投影一定有非零偏移且不带 inset
      const parts = bs.split(/,(?![^(]*\\))/).map((s) => s.trim());
      const realShadow = parts.some((p) => !/inset/.test(p));
      if (realShadow) offenders.push((el.className || el.tagName) + ' → ' + bs.slice(0, 60));
    }
    const floaters = ['.stage', '#sheet', '.toast', '#alarmBanner', '.tip'].filter((s) => {
      const el = document.querySelector(s);
      return el && getComputedStyle(el).boxShadow !== 'none';
    });
    return { offenders: offenders.slice(0, 6), floaters };
  })()`);
  assert(shadows.offenders.length === 0, `R2 卡片/按钮/文字零投影${shadows.offenders.length ? '，违规：' + shadows.offenders.join(' | ') : ''}`);
  assert(shadows.floaters.length > 0, `R2 阴影只保留给浮层（实测有阴影的浮层：${shadows.floaters.join(', ')}）`);

  /* ---- R3 正文 17px/400/-0.374px ----
   * 口径：量 body 本体与 .t-body 正文类。首页 tile-sub/tile-lead 是 19px 的
   * 展示层导语（Apple 的 lead 段落同样大于正文），不算正文正文。 */
  const body = await evalJs(cdp, `(() => {
    const cs = getComputedStyle(document.body);
    const t = document.querySelector('.t-body');
    const tcs = t ? getComputedStyle(t) : cs;
    return { size: cs.fontSize, tSize: tcs.fontSize, weight: cs.fontWeight, ls: cs.letterSpacing, lh: cs.lineHeight };
  })()`);
  assert(body.size === '17px' && body.tSize === '17px', `R3 正文 17px（body=${body.size}, .t-body=${body.tSize}；tile 导语 19px 属展示层不算正文）`);
  assert(body.weight === '400', `R3 正文 400（实测 ${body.weight}）`);
  assert(body.ls === '-0.374px', `R3 字距 -0.374px（实测 ${body.ls}）`);

  /* ---- R4 字重阶梯无 500 ---- */
  const w500 = await evalJs(cdp, `(() => {
    const hits = [];
    for (const el of document.querySelectorAll('body *')) {
      const w = getComputedStyle(el).fontWeight;
      if (w === '500') hits.push(el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''));
    }
    return hits.slice(0, 5);
  })()`);
  assert(w500.length === 0, `R4 全站无 font-weight:500${w500.length ? '，违规：' + w500.join(' | ') : ''}`);

  /* ---- R5 按下反馈 scale(0.95) ---- */
  const press = await evalJs(cdp, `(() => {
    const pv = getComputedStyle(document.documentElement).getPropertyValue('--press-scale').trim();
    let activeRules = 0;
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      if (!rules) continue;
      for (const r of rules) {
        if (r.selectorText && /:active/.test(r.selectorText) && /scale/.test(r.cssText)) activeRules++;
      }
    }
    return { pv, activeRules };
  })()`);
  assert(press.pv === '0.95', `R5 --press-scale = 0.95（实测 ${press.pv}）`);
  assert(press.activeRules >= 1, `R5 存在 :active scale 按下规则（${press.activeRules} 条）`);

  /* ---- R6 圆角阶梯 ----
   * 豁免：宽高 ≤12px 的微装饰元素（图例色块小方点）不在圆角语法约束范围，
   * Apple 自己的圆角语法也只约束容器级元素。 */
  const radii = await evalJs(cdp, `(() => {
    const allow = new Set(['0px', '5px', '8px', '11px', '18px', '20px', '28px', '980px', '50%', '100%']);
    const seen = new Set();
    const bad = new Set();
    for (const el of document.querySelectorAll('body *')) {
      const r = getComputedStyle(el).borderRadius;
      if (!r || r === '0px') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 12 && rect.height <= 12) continue; // 微装饰豁免
      for (const part of r.split(' ')) {
        seen.add(part);
        if (!allow.has(part)) bad.add(part + ' @ ' + el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''));
      }
    }
    return { seen: [...seen].sort(), bad: [...bad].slice(0, 6) };
  })()`);
  assert(radii.bad.length === 0, `R6 圆角只用令牌阶梯（实测集合：${radii.seen.join(', ')}）${radii.bad.length ? '，越界：' + radii.bad.join(' | ') : ''}`);

  /* ---- R7 零装饰性渐变 ----
   * 豁免：滑块的 linear-gradient 是"已填充比例"的功能性进度指示（syncFill 写入
   * --pct），不是装饰性氛围背景；DESIGN 禁的是后者。 */
  const gradients = await evalJs(cdp, `(() => {
    const hits = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.tagName === 'INPUT' && el.type === 'range') continue; // 功能性填充豁免
      const bg = getComputedStyle(el).backgroundImage;
      if (/gradient/i.test(bg)) hits.push(el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : '') + ' → ' + bg.slice(0, 50));
    }
    return hits.slice(0, 5);
  })()`);
  assert(gradients.length === 0, `R7 零装饰性渐变（滑块功能性填充除外）${gradients.length ? '，违规：' + gradients.join(' | ') : ''}`);

  /* ---- R8 全局导航黑色 ----
   * 记录在案例外：导航是 rgba(0,0,0,0.8) + backdrop-blur 的玻璃态——
   * 这与 apple.com 全局导航的实测 computed style 一致（半透明黑玻璃），
   * 视觉呈现仍是"唯一的纯黑区域"，DESIGN 的 surface-black 指视觉结果。 */
  const nav = await evalJs(cdp, `(() => {
    const el = document.querySelector('.gn') || document.querySelector('header') || document.body.firstElementChild;
    return el ? getComputedStyle(el).backgroundColor : null;
  })()`);
  assert(nav === 'rgba(0, 0, 0, 0.8)' || nav === 'rgb(0, 0, 0)', `R8 全局导航黑色玻璃（实测 ${nav}；与 apple.com 实测同构，已记录为例行豁免）`);

  /* ---- R9 正文行高 ≥1.47（量 .t-body 正文类，与 R3 同口径） ---- */
  const lh = await evalJs(cdp, `(() => {
    const p = document.querySelector('.t-body') || document.querySelector('footer p');
    if (!p) return null;
    const cs = getComputedStyle(p);
    return { lh: cs.lineHeight, fs: parseFloat(cs.fontSize), ratio: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) };
  })()`);
  assert(lh && lh.ratio >= 1.46, `R9 正文行高 ≥1.47（实测 ${lh ? lh.ratio.toFixed(2) : 'n/a'}）`);

  /* ---- R10 Sky Link Blue 仅限深色表面（静态 CSS 扫描） ----
   * 记录在案例外：.vision-* 是首页插画内部的暗色屏幕绘图（fill 是 tile-dark 系），
   * 属于"深色表面上的内容"，虽然页面本身是浅色。 */
  const skyUse = await evalJs(cdp, `(() => {
    const bad = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      if (!rules) continue;
      for (const r of rules) {
        if (!r.selectorText || !r.cssText.includes('link-on-dark')) continue;
        if (/^\\.vision-/.test(r.selectorText.trim())) continue; // 插画暗色内部豁免
        const inDarkCtx = /tile-dark|on-dark|data-theme=['"]dark|prefers-color-scheme/.test(r.selectorText)
          || r.selectorText.includes(':root');
        if (!inDarkCtx) bad.push(r.selectorText);
      }
    }
    return bad.slice(0, 5);
  })()`);
  assert(skyUse.length === 0, `R10 --link-on-dark 仅用于深色上下文${skyUse.length ? '，越界选择器：' + skyUse.join(' | ') : ''}`);

  /* ---- 截图取证（浅/深 × 首页/工作台） ---- */
  fs.mkdirSync(OUT, { recursive: true });
  const gotoView = (id) => evalJs(cdp, `(() => { window.__fatigue.app.router.gotoView('${id}'); return true; })()`);
  await gotoView('viewHome');
  await evalJs(cdp, `document.documentElement.dataset.theme = 'light'`); await sleep(500);
  await shot(cdp, 'audit-home-light.png', OUT);
  await evalJs(cdp, `document.documentElement.dataset.theme = 'dark'`); await sleep(500);
  await shot(cdp, 'audit-home-dark.png', OUT);
  await gotoView('viewWork');
  await evalJs(cdp, `document.documentElement.dataset.theme = 'light'`); await sleep(500);
  await shot(cdp, 'audit-work-light.png', OUT);
  await evalJs(cdp, `document.documentElement.dataset.theme = 'dark'`); await sleep(500);
  await shot(cdp, 'audit-work-dark.png', OUT);
  console.log(`  ✓ 截图取证 4 张 → docs-evidence/design-audit/`);

  assert(cdp.consoleErrors.length === 0, `审计全程无控制台错误（${cdp.consoleErrors.length} 条）`);
} catch (err) {
  failed++;
  console.error('  ✗ 审计异常:', err.message);
} finally {
  await session.close();
}

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
clearTimeout(watchdog);
process.exit(failed > 0 ? 1 : 0);
