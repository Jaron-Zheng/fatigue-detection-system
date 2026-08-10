/**
 * motion.js — 动效引擎
 *
 * 只做三件 CSS 做不到的事：
 *   1. 判断元素何时进入视口，加 .is-inview（CSS 无法"只播一次"）
 *   2. 给同组元素编号，实现错峰进场
 *   3. 数字递增动画
 *   4. 顶栏滚动态
 *
 * 视差、缓动曲线、位移幅度全部留在 motion.css 里——
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
      rootMargin: '0px 0px -12% 0px',
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
function countUp(el, duration = 900) {
  const raw = (el.textContent || '').trim();
  // 允许前后有符号和单位，但必须以数字为主体
  const m = raw.match(/^([+-]?\d+(?:\.\d+)?)$/);
  if (!m) return;

  const target = parseFloat(m[1]);
  if (!Number.isFinite(target) || target === 0) return;

  // 保持与原文本相同的小数位数，否则 "0.0" 会变成 "0"
  const decimals = (m[1].split('.')[1] || '').length;

  const start = performance.now();
  // 与 CSS 的 --ease-reveal 同形：末段极缓，数字"停"得自然
  const ease = (t) => 1 - Math.pow(1 - t, 3);

  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const v = target * ease(t);
    el.textContent = v.toFixed(decimals);
    if (t < 1) requestAnimationFrame(frame);
    else el.textContent = target.toFixed(decimals);
  }
  requestAnimationFrame(frame);
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
 * 页面滚过一定距离后给顶栏加 .is-scrolled，
 * 让毛玻璃与分隔线浮现。停在顶端时顶栏与页面同色，看不出边界。
 */
function setupNavScroll() {
  const subnav = document.querySelector('.subnav');
  if (!subnav) return;

  let ticking = false;
  const update = () => {
    subnav.classList.toggle('is-scrolled', window.scrollY > 8);
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
  setupNavScroll();
}

/**
 * 给动态插入的内容补上进场动画（例如报告页渲染完的卡片）。
 */
export function refreshMotion(root = document) {
  setupReveal(root);
}
