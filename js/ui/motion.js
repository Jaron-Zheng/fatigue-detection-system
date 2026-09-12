/**
 * motion.js — 动效引擎（Apple 设计语言）
 *
 * 职责：
 *   1. 判断元素何时进入视口，加 .is-inview
 *   2. 给同组元素编号，实现错峰进场
 *   3. 数字递增动画
 *   4. 顶栏滚动态切换（透明 → 毛玻璃）
 *   5. 视差效果
 *   6. 功能卡片网格行内编号
 *
 * 视差幅度、缓动曲线、位移幅度全部留在 motion.css 里，
 * JS 不设任何具体数值。.has-motion 是总闸，只有本文件成功跑起才会加上。
 */

/** 检测用户是否关闭了动效 */
const reduceMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ==================== 滚动进场 ==================== */

/**
 * 给 [data-reveal] 元素接上进场动画。
 * 同一个 [data-reveal-group] 容器内的元素依次编号实现错峰。
 * @param {ParentNode} root
 */
function setupReveal(root = document) {
  const items = root.querySelectorAll('[data-reveal]');
  if (!items.length) return;

  // 关闭动效时直接置为终态
  if (reduceMotion() || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-inview'));
    return;
  }

  // 组内编号
  for (const group of root.querySelectorAll('[data-reveal-group]')) {
    const kids = group.querySelectorAll(':scope > [data-reveal]');
    kids.forEach((el, i) => el.style.setProperty('--i', String(i)));
  }

  // 功能卡片网格：按行编号
  for (const grid of root.querySelectorAll('.feat-grid')) {
    const kids = grid.querySelectorAll('[data-reveal]');
    const rows = new Map();
    kids.forEach((el) => {
      const top = el.offsetTop;
      if (!rows.has(top)) rows.set(top, []);
      rows.get(top).push(el);
    });
    const sortedTops = [...rows.keys()].sort((a, b) => a - b);
    sortedTops.forEach((top, rowIdx) => {
      rows.get(top).forEach((el, colIdx) => {
        el.style.setProperty('--row', String(rowIdx));
        el.style.setProperty('--i', String(colIdx));
      });
    });
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-inview');
        io.unobserve(entry.target); // 只播一次
      }
    },
    {
      rootMargin: '0px 0px -10% 0px',
      threshold: 0.01,
    }
  );

  items.forEach((el) => io.observe(el));
}

/* ==================== 数字递增 ==================== */

/**
 * 把元素里的数字从 0 递增到目标值。
 * 目标值直接读元素当前文本，读不出数字则不动。
 * @param {HTMLElement} el
 * @param {number} duration 毫秒
 */
function countUp(el, duration = 1200) {
  const raw = (el.textContent || '').trim();
  const m = raw.match(/^([+-]?\d+(?:\.\d+)?)$/);
  if (!m) return;

  const target = parseFloat(m[1]);
  if (!Number.isFinite(target) || target <= 0) return;
  const goal = Math.max(0, target);

  // 保持与原文本相同的小数位数
  const decimals = (m[1].split('.')[1] || '').length;

  // 重入保护
  if (el._countUpRaf) cancelAnimationFrame(el._countUpRaf);

  const start = performance.now();
  // ease-out-quart 缓动
  const ease = (t) => 1 - Math.pow(1 - t, 4);

  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const v = goal * ease(t);
    el.textContent = v.toFixed(decimals);
    if (t < 1) el._countUpRaf = requestAnimationFrame(frame);
    else {
      el.textContent = goal.toFixed(decimals);
      el._countUpRaf = null;
    }
  }
  el._countUpRaf = requestAnimationFrame(frame);
}

/**
 * 触发容器内所有 [data-countup] 的递增
 */
export function runCountUp(root = document) {
  if (reduceMotion()) return;
  root.querySelectorAll('[data-countup]').forEach((el) => countUp(el));
}

/* ==================== 顶栏滚动态 ==================== */

/**
 * 页面滚过后给导航加 .is-scrolled，从透明切到毛玻璃
 */
function setupNavScroll() {
  const nav = document.querySelector('.global-nav');
  if (!nav) return;

  let ticking = false;
  const update = () => {
    nav.classList.toggle('is-scrolled', window.scrollY > 8);
    ticking = false;
  };

  window.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    },
    { passive: true }
  );
  update();
}

/* ==================== 视差效果 ==================== */

/**
 * [data-parallax] 元素随滚动产生轻微位移，通过 CSS 变量 --scroll-y 驱动
 */
function setupParallax() {
  if (reduceMotion()) return;

  const items = document.querySelectorAll('[data-parallax]');
  if (!items.length) return;

  let ticking = false;
  const update = () => {
    for (const el of items) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > -200 && rect.top < window.innerHeight + 200) {
        const center = rect.top + rect.height / 2;
        const viewportCenter = window.innerHeight / 2;
        const delta = (center - viewportCenter) / window.innerHeight;
        el.style.setProperty('--scroll-y', delta.toFixed(4));
      }
    }
    ticking = false;
  };

  window.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    },
    { passive: true }
  );
  update();
}

/* ==================== 滚动驱动 ==================== */

/**
 * Hero 内容随滚动淡出 + 轻微上移，SVG 插图产生轻微视差
 */
function setupScrollDriven() {
  if (reduceMotion()) return;

  const hero = document.querySelector('.ts-hero');
  const heroInner = document.querySelector('.ts-hero-inner');
  const visionProduct = document.querySelector('.vision-product');
  if (!hero) return;

  let ticking = false;
  const update = () => {
    const scrollY = window.scrollY;
    const heroHeight = hero.offsetHeight || window.innerHeight;
    const progress = Math.min(1, scrollY / heroHeight);

    if (heroInner) {
      const opacity = Math.max(0, 1 - progress * 1.3);
      const translateY = progress * -30;
      heroInner.style.setProperty('opacity', opacity.toFixed(3));
      heroInner.style.setProperty('transform', `translateY(${translateY}px)`);
    }

    if (visionProduct) {
      const parallaxY = progress * 15;
      const scale = 1 - progress * 0.03;
      visionProduct.style.setProperty(
        'transform',
        `translateY(${parallaxY}px) scale(${scale})`
      );
    }

    ticking = false;
  };

  window.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    },
    { passive: true }
  );
  update();
}

/* ==================== Staggered Fade In ==================== */

/**
 * 给 [data-staggered] 元素编号并接上进场动画
 */
function setupStaggered(root = document) {
  const items = root.querySelectorAll('[data-staggered]');
  if (!items.length) return;

  if (reduceMotion() || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-inview'));
    return;
  }

  for (const group of root.querySelectorAll('[data-staggered-group]')) {
    const kids = group.querySelectorAll(':scope > [data-staggered]');
    kids.forEach((el, i) => el.style.setProperty('--i', String(i)));
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-inview');
        io.unobserve(entry.target);
      }
    },
    {
      rootMargin: '0px 0px -10% 0px',
      threshold: 0.05,
    }
  );

  items.forEach((el) => io.observe(el));
}

/* ==================== 初始化 ==================== */

/**
 * 启动动效系统。.has-motion 是总闸。
 */
export function initMotion() {
  const html = document.documentElement;

  if (!reduceMotion()) html.classList.add('has-motion');

  setupReveal();
  setupStaggered();
  setupNavScroll();
  setupParallax();
  setupScrollDriven();
}

/**
 * 给动态插入的内容补上进场动画
 */
export function refreshMotion(root = document) {
  setupReveal(root);
  setupStaggered(root);
}
