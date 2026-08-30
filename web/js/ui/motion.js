/**
 * motion.js — 动效引擎（Apple 设计语言）
 *
 * 职责：
 *   1. 判断元素何时进入视口，加 .is-inview（CSS 无法"只播一次"）
 *   2. 给同组元素编号，实现错峰进场
 *   3. 数字递增动画（缓动曲线减速）
 *   4. 顶栏滚动态切换（透明 → 毛玻璃）
 *   5. 视差效果（元素随滚动轻微位移）
 *   6. 功能卡片网格行内编号
 *
 * 视差幅度、缓动曲线、位移幅度全部留在 motion.css 里——
 * JS 不设任何具体数值，改动效只需要改 CSS。
 *
 * 设计前提：没有这个文件页面也必须是完好的。
 * 所以起始态（透明+下移）由 .has-motion 这个类闸门控制，
 * 而这个类只有本文件成功跑起来才会加上。
 */

/** 用户在系统里关掉了动效 */
const reduceMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ==================== 滚动进场 ==================== */

/**
 * 给 [data-reveal] 元素接上进场动画。
 *
 * 错峰规则：同一个 [data-reveal-group] 容器内的元素依次编号，
 * CSS 用这个序号乘以间隔算出各自的延迟。没有分组容器的元素序号为 0，
 * 立即进场——独立元素不该等别人。
 *
 * @param {ParentNode} root 扫描范围，默认整个文档
 */
function setupReveal(root = document) {
  const items = root.querySelectorAll('[data-reveal]');
  if (!items.length) return;

  // 关闭动效时直接置为终态，不注册任何观察器
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
    // 简单地按 offsetTop 分组
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
        // 只播一次：Apple 的进场动画不会因为往回滚就重来
        io.unobserve(entry.target);
      }
    },
    {
      // 底部负 margin：元素露出约一成才触发，
      // 避免刚冒头就播完，用户滚到时动画已经结束
      rootMargin: '0px 0px -10% 0px',
      threshold: 0.01,
    }
  );

  items.forEach((el) => {
    // 已经在视口内的（首屏）不等滚动，下一帧直接放行，
    // 否则首屏内容会停在透明状态直到用户滚动
    io.observe(el);
  });
}

/* ==================== 数字递增 ==================== */

/**
 * 把元素里的数字从 0 递增到目标值。
 *
 * 目标值直接读元素当前的文本，所以调用时机必须在数据填好之后。
 * 读不出数字（"--"、"00:00" 这类占位或时间格式）就原样不动——
 * 报告页有大量非纯数字字段，不能一律套上去。
 *
 * @param {HTMLElement} el
 * @param {number} duration 毫秒
 */
function countUp(el, duration = 1200) {
  const raw = (el.textContent || '').trim();
  // 允许前后有符号和单位，但必须以数字为主体
  const m = raw.match(/^([+-]?\d+(?:\.\d+)?)$/);
  if (!m) return;

  const target = parseFloat(m[1]);
  if (!Number.isFinite(target) || target <= 0) return;
  // 防御：动画中间态被再次触发时会把中间值当目标解析，
  // 一旦出现负数（理论上不该发生）宁可不动也不要播出去
  const goal = Math.max(0, target);

  // 保持与原文本相同的小数位数，否则 "0.0" 会变成 "0"
  const decimals = (m[1].split('.')[1] || '').length;

  // 重入保护：上一次动画未播完时先取消，避免两个循环互相覆盖文本
  if (el._countUpRaf) cancelAnimationFrame(el._countUpRaf);

  const start = performance.now();
  // Apple 风格缓动：cubic-bezier(0.25, 0.1, 0.3, 1) 的 JS 近似
  // 末段极缓，数字"停"得自然
  const ease = (t) => {
    // ease-out-quart: 1 - (1-t)^4 — 接近 Apple 的减速曲线
    return 1 - Math.pow(1 - t, 4);
  };

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
 * 触发一个容器内所有 [data-countup] 的递增。
 * 报告页渲染完成后调用。
 */
export function runCountUp(root = document) {
  if (reduceMotion()) return;
  root.querySelectorAll('[data-countup]').forEach((el) => countUp(el));
}

/* ==================== 顶栏滚动态 ==================== */

/**
 * 页面滚过一定距离后给导航加 .is-scrolled，
 * 从首页 hero 上的透明悬浮切回毛玻璃实底。
 * Apple 顶栏的标志性效果。
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
 * [data-parallax] 元素随滚动产生轻微位移，制造深度感。
 * 通过 CSS 变量 --scroll-y 驱动，具体幅度在 CSS 中定义。
 */
function setupParallax() {
  if (reduceMotion()) return;

  const items = document.querySelectorAll('[data-parallax]');
  if (!items.length) return;

  let ticking = false;
  const update = () => {
    const scrollY = window.scrollY;
    for (const el of items) {
      const rect = el.getBoundingClientRect();
      // 只在元素附近时才更新，节省性能
      if (rect.bottom > -200 && rect.top < window.innerHeight + 200) {
        // 计算元素中心相对于视口中心的偏移
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
 * Apple 风格的滚动驱动效果：
 * 1. Hero 内容随滚动淡出 + 轻微上移
 * 2. 导航栏在滚动后激活毛玻璃 + 从上方滑入
 * 3. Hero 内的 SVG 插图产生轻微视差（比文字移动稍慢）
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

    // Hero 内容随滚动淡出 + 轻微上移
    if (heroInner) {
      const opacity = Math.max(0, 1 - progress * 1.3);
      const translateY = progress * -30;
      heroInner.style.setProperty('opacity', opacity.toFixed(3));
      heroInner.style.setProperty('transform', `translateY(${translateY}px)`);
    }

    // SVG 插图视差：比文字移动稍慢
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
 * Apple StaggeredFadeIn 机制：
 * 给 [data-staggered] 元素编号，与 [data-reveal-group] 类似但
 * 使用单独的 data-staggered 属性，避免与现有 data-reveal 冲突。
 */
function setupStaggered(root = document) {
  const items = root.querySelectorAll('[data-staggered]');
  if (!items.length) return;

  if (reduceMotion() || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('is-inview'));
    return;
  }

  // 组内编号
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
 * 启动动效系统。
 *
 * .has-motion 是总闸：加上它，CSS 里的起始态（透明+下移）才生效。
 * 放在最前面同步执行，避免元素先以终态渲染一帧再被压回起点——
 * 那一帧会看成闪烁。
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
 * 给动态插入的内容补上进场动画（例如报告页渲染完的卡片）。
 */
export function refreshMotion(root = document) {
  setupReveal(root);
  setupStaggered(root);
}
