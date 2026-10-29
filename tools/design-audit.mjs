#!/usr/bin/env node
/**
 * design-audit.mjs — DESIGN.md「Tesla 设计语言」Do's and Don'ts 逐条保真度审计
 *
 * 不是读代码猜，而是用无头浏览器真实加载页面后读 computed style：
 *   R1 单一强调色：交互元素颜色只来自 Electric Blue 家族，无第二支强调色
 *   R2 全站零投影：任何元素不得出现非 inset 的 box-shadow（描线用 inset）
 *   R3 正文 14px/400/字距 0
 *   R4 字重阶梯只有 400/500，全站不存在 600/700
 *   R5 无缩放按压（--press-scale 归一，无 :active scale 规则）
 *   R6 圆角只用令牌阶梯（2/4/12px 与 50% 圆形），无胶囊无中间值
 *   R7 零装饰性渐变（滑块的功能性填充除外）
 *   R8 导航底色 = 画布色（首页顶部与 hero 同为 Carbon Dark 的融合态）
 *   R9 正文行高 ≥1.49（14px 中文可读性）
 *   R10 全站无 text-transform: uppercase（Tesla 不用大写）
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
  console.log(`=== DESIGN.md（Tesla）Do's/Don'ts 保真度审计 → ${URL_TARGET} ===\n`);
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
      // 交互元素的文字/图标颜色只允许：Carbon/Graphite/Pewter/SilverFog 中性、
      // Electric Blue 家族（浅 62,106,225 / 47,85,189；深 90,139,242）、
      // 白字（实心底）、四级语义色（状态信息不是强调色）
      const c = cs.color;
      const interactive = /^(rgb|#)/.test(c);
      if (!interactive) continue;
      const okBlue = c.includes('62, 106, 225') || c.includes('47, 85, 189') || c.includes('90, 139, 242');
      const okNeutral = c.includes('23, 26, 32') || c.includes('57, 60, 65') || c.includes('92, 94, 98') || c.includes('142, 142, 142') || c.includes('255, 255, 255');
      const okSemantic = c.includes('20, 106, 56') || c.includes('122, 90, 0') || c.includes('179, 78, 0') || c.includes('193, 31, 26');
      if (!okBlue && !okNeutral && !okSemantic) bad.push(el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).split(' ')[0] : '') + ' color=' + c);
    }
    return { acc, bad: bad.slice(0, 8) };
  })()`);
  assert(accents.bad.length === 0, `R1 单一强调色：交互元素无第二支强调色（基色 ${accents.acc}）${accents.bad.length ? '，异常：' + accents.bad.join(' | ') : ''}`);

  /* ---- R2 全站零投影 ----
   * Tesla 规则：任何元素不加投影。允许的"非投影"只有 inset 描线
   * （计算样式里全部片段都带 inset 关键字）。 */
  const shadows = await evalJs(cdp, `(() => {
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const bs = getComputedStyle(el).boxShadow;
      if (!bs || bs === 'none') continue;
      const parts = bs.split(/,(?![^(]*\\))/).map((s) => s.trim());
      const realShadow = parts.some((p) => !/inset/.test(p));
      if (realShadow) offenders.push((el.className || el.tagName) + ' → ' + bs.slice(0, 60));
    }
    return { offenders: offenders.slice(0, 6) };
  })()`);
  assert(shadows.offenders.length === 0, `R2 全站零投影（含浮层，描线只允许 inset）${shadows.offenders.length ? '，违规：' + shadows.offenders.join(' | ') : ''}`);

  /* ---- R3 正文 14px/400/字距 0 ---- */
  const body = await evalJs(cdp, `(() => {
    const cs = getComputedStyle(document.body);
    const t = document.querySelector('.t-body');
    const tcs = t ? getComputedStyle(t) : cs;
    return { size: cs.fontSize, tSize: tcs.fontSize, weight: cs.fontWeight, ls: cs.letterSpacing, lh: cs.lineHeight };
  })()`);
  assert(body.size === '14px' && body.tSize === '14px', `R3 正文 14px（body=${body.size}, .t-body=${body.tSize}）`);
  assert(body.weight === '400', `R3 正文 400（实测 ${body.weight}）`);
  assert(body.ls === 'normal' || body.ls === '0px', `R3 字距默认/0（实测 ${body.ls}）`);

  /* ---- R4 字重阶梯只有 400/500 ---- */
  const wBad = await evalJs(cdp, `(() => {
    const hits = [];
    for (const el of document.querySelectorAll('body *')) {
      const w = getComputedStyle(el).fontWeight;
      if (w === '600' || w === '700' || w === 'bold' || w === '300' || w === 'lighter') hits.push(el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''));
    }
    return hits.slice(0, 5);
  })()`);
  assert(wBad.length === 0, `R4 全站字重只有 400/500${wBad.length ? '，违规：' + wBad.join(' | ') : ''}`);

  /* ---- R5 无缩放按压 ---- */
  const press = await evalJs(cdp, `(() => {
    const pv = getComputedStyle(document.documentElement).getPropertyValue('--press-scale').trim();
    let activeRules = 0;
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      if (!rules) continue;
      for (const r of rules) {
        if (r.selectorText && /:active/.test(r.selectorText) && /scale|translate/.test(r.cssText)) activeRules++;
      }
    }
    return { pv, activeRules };
  })()`);
  assert(press.pv === '1', `R5 --press-scale = 1（实测 ${press.pv}）`);
  assert(press.activeRules === 0, `R5 无 :active 缩放/位移规则（实测 ${press.activeRules} 条）`);

  /* ---- R6 圆角阶梯 ----
   * 豁免：宽高 ≤12px 的微装饰元素（图例色块小方点）不在圆角语法约束范围。 */
  const radii = await evalJs(cdp, `(() => {
    const allow = new Set(['0px', '2px', '4px', '12px', '50%', '100%']);
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
   * --pct），不是装饰性氛围背景；Tesla 禁的是后者。 */
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

  /* ---- R8 导航底色 = 画布色（或首页顶部与 hero 的 Carbon Dark 融合态） ---- */
  const nav = await evalJs(cdp, `(() => {
    const el = document.querySelector('header.global-nav');
    return el ? getComputedStyle(el).backgroundColor : null;
  })()`);
  assert(nav === 'rgb(244, 244, 244)' || nav === 'rgb(255, 255, 255)' || nav === 'rgb(23, 26, 32)', `R8 导航底色为画布色/hero 融合态（实测 ${nav}）`);

  /* ---- R9 正文行高 ≥1.49（量 .t-body 正文类，与 R3 同口径） ---- */
  const lh = await evalJs(cdp, `(() => {
    const p = document.querySelector('.t-body') || document.querySelector('footer p');
    if (!p) return null;
    const cs = getComputedStyle(p);
    return { lh: cs.lineHeight, fs: parseFloat(cs.fontSize), ratio: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) };
  })()`);
  assert(lh && lh.ratio >= 1.49, `R9 正文行高 ≥1.49（实测 ${lh ? lh.ratio.toFixed(2) : 'n/a'}）`);

  /* ---- R10 全站无全大写转换（静态 CSS 扫描） ---- */
  const upper = await evalJs(cdp, `(() => {
    const hits = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      if (!rules) continue;
      for (const r of rules) {
        if (r.selectorText && /text-transform:\\s*uppercase/i.test(r.cssText) && !/^@(media|supports)/.test(r.cssText)) {
          hits.push(r.selectorText);
        }
      }
    }
    return hits.slice(0, 5);
  })()`);
  assert(upper.length === 0, `R10 无 text-transform: uppercase${upper.length ? '，违规选择器：' + upper.join(' | ') : ''}`);

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
