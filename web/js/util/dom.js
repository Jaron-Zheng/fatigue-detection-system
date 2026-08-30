/** dom.js — 轻量 DOM 工具（避免引入框架，保持零依赖） */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 创建元素：el('div.card', { id:'x' }, [child...]) */
export function el(tag, attrs = {}, children = []) {
  let name = tag;
  const classes = [];
  let id = null;
  // 支持 'div.a.b#id' 简写
  const idMatch = name.match(/#([\w-]+)/);
  if (idMatch) {
    id = idMatch[1];
    name = name.replace(idMatch[0], '');
  }
  const parts = name.split('.');
  name = parts.shift() || 'div';
  classes.push(...parts.filter(Boolean));

  const node = document.createElement(name);
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');

  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = [node.className, v].filter(Boolean).join(' ');
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }

  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** 只在值变化时写 DOM：高频刷新时显著减少重排 */
export function setText(node, value) {
  if (!node) return;
  const s = String(value);
  if (node.__lastText !== s) {
    node.textContent = s;
    node.__lastText = s;
  }
}

export function setAttr(node, name, value) {
  if (!node) return;
  const key = '__attr_' + name;
  const s = value === null || value === undefined ? null : String(value);
  if (node[key] === s) return;
  node[key] = s;
  if (s === null) node.removeAttribute(name);
  else node.setAttribute(name, s);
}

export function setStyle(node, prop, value) {
  if (!node) return;
  const key = '__style_' + prop;
  const s = String(value);
  if (node[key] === s) return;
  node[key] = s;
  node.style.setProperty(prop, s);
}

export function toggleClass(node, cls, on) {
  if (!node) return;
  node.classList.toggle(cls, !!on);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 创建引用 index.html sprite symbol 的内联 SVG（createElementNS，不走 innerHTML）。
 * toast 图标章与时间轴事件图标共用，保证全站一套视觉语言。 */
export function svgUse(symbolId, size = 13) {
  const NS = 'http://www.w3.org/2000/svg';
  const XLINK = 'http://www.w3.org/1999/xlink';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  // href 的新式命名空间写法 + xlink 兼容旧引擎（Firefox 需要）
  use.setAttributeNS(XLINK, 'xlink:href', `#${symbolId}`);
  use.setAttribute('href', `#${symbolId}`);
  svg.appendChild(use);
  return svg;
}

/**
 * 高 DPI 屏幕下的 Canvas 尺寸适配。
 * 不做这一步，Retina 屏上的线条与文字会明显发虚。
 */
export function fitCanvas(canvas, cssW = null, cssH = null) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(cssW ?? rect.width));
  const h = Math.max(1, Math.round(cssH ?? rect.height));
  const needW = Math.round(w * dpr);
  const needH = Math.round(h * dpr);
  if (canvas.width !== needW || canvas.height !== needH) {
    canvas.width = needW;
    canvas.height = needH;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}

/** 读取当前主题下的 CSS 变量真实值（图表需要拿到具体颜色） */
export function cssVar(name, fallback = '#000') {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** 节流：保证高频事件（resize）不过度触发 */
export function throttle(fn, ms = 120) {
  let last = 0;
  let timer = null;
  return function (...args) {
    const now = Date.now();
    const rest = ms - (now - last);
    if (rest <= 0) {
      last = now;
      fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = null;
        fn.apply(this, args);
      }, rest);
    }
  };
}
