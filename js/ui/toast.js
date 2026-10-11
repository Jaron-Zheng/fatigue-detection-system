/** toast.js — 轻量通知（毛玻璃卡片，自动消失） */

import { el, $, svgUse } from '../util/dom.js';

const ICONS = { info: 'i', ok: '✓', warn: '!', error: '×' };

let host = null;

function ensureHost() {
  if (host && document.body.contains(host)) return host;
  host = $('.toast-host');
  if (!host) {
    host = el('div.toast-host', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  return host;
}

/**
 * @param {string} title 标题
 * @param {string} msg   说明（可省略）
 * @param {'info'|'ok'|'warn'|'error'} kind
 * @param {number} ms    停留时长
 */
export function toast(title, msg = '', kind = 'info', ms = 3600) {
  const h = ensureHost();
  const node = el('div.toast', { dataset: { kind } }, [
    el('div.toast-icon', { text: ICONS[kind] || 'i', 'aria-hidden': 'true' }),
    el('div.toast-body', {}, [
      el('div.toast-title', { text: title }),
      msg ? el('div.toast-msg', { text: msg }) : null,
    ]),
  ]);
  h.appendChild(node);

  // 同时最多显示 4 条，超出移除最旧
  while (h.children.length > 4) h.removeChild(h.firstChild);

  const remove = () => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  };
  const timer = setTimeout(remove, ms);
  node.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
  return node;
}

export const toastOk = (t, m, ms) => toast(t, m, 'ok', ms);
export const toastWarn = (t, m, ms) => toast(t, m, 'warn', ms ?? 5000);
export const toastError = (t, m, ms) => toast(t, m, 'error', ms ?? 7000);

/**
 * 行内二次确认（r3 P7）——替代原生 confirm()。
 *
 * 全应用的通知/确认都走自定义毛玻璃卡片，唯独原生 confirm 是系统级对话框：
 * 深色主题下视觉断裂、无法定制文案层级、在自动化测试环境里默认被 dismiss
 * 导致动作静默不执行。这里在 toast 卡片内放两枚按钮，返回 Promise<boolean>。
 *
 * 行为约定：
 *   · 不自动消失，也不响应"点卡片任意处关闭"（避免误触当成取消）；
 *   · Esc 视为取消；确认键自动聚焦，Enter 即确认（与原生 confirm 的键盘习惯一致）；
 *   · 同时只允许一个确认框：再次调用会先取消上一个（resolve(false)）。
 *
 * @param {string} title
 * @param {string} msg
 * @param {{confirmText?:string, cancelText?:string, kind?:'info'|'warn'|'error', danger?:boolean}} [opts]
 * @returns {Promise<boolean>}
 */
let activeConfirm = null;
export function toastConfirm(title, msg = '', opts = {}) {
  if (activeConfirm) activeConfirm(false);
  const { confirmText = '继续', cancelText = '取消', kind = 'warn', danger = false } = opts;
  const h = ensureHost();
  return new Promise((resolve) => {
    const btnOk = el('button.btn.btn-sm', {
      type: 'button',
      class: danger ? 'btn-danger' : 'btn-primary',
      text: confirmText,
    });
    const btnNo = el('button.btn.btn-sm.btn-secondary', { type: 'button', text: cancelText });
    const node = el('div.toast.toast-confirm', { dataset: { kind }, role: 'alertdialog', 'aria-label': title }, [
      el('div.toast-icon', { text: ICONS[kind] || '?', 'aria-hidden': 'true' }),
      el('div.toast-body', {}, [
        el('div.toast-title', { text: title }),
        msg ? el('div.toast-msg', { text: msg }) : null,
        el('div.toast-actions', {}, [btnNo, btnOk]),
      ]),
    ]);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      }
    };
    const settle = (ok) => {
      if (activeConfirm !== settle) return;
      activeConfirm = null;
      document.removeEventListener('keydown', onKey, true);
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 220);
      resolve(ok);
    };
    activeConfirm = settle;
    btnOk.addEventListener('click', (e) => {
      e.stopPropagation();
      settle(true);
    });
    btnNo.addEventListener('click', (e) => {
      e.stopPropagation();
      settle(false);
    });
    document.addEventListener('keydown', onKey, true);
    h.appendChild(node);
    while (h.children.length > 4) h.removeChild(h.firstChild);
    // 卡片有入场动画，聚焦放到下一帧以免被浏览器滚动定位打断
    requestAnimationFrame(() => btnOk.focus());
  });
}

/** 疲劳报警停留时长：等级越高停越久（点击任意处可提前关闭） */
const ALARM_MS = { mild: 5500, moderate: 7000, severe: 9000 };

/**
 * 疲劳报警通知 —— 与常规 toast（"专业模式已开启"等）同一视觉家族：
 * 同样的毛玻璃卡片、20px 图标章、标题 + 说明两行结构。
 * 等级区分只由三处随 data-level 变化的属性表达（CSS 驱动）：
 *  - 图标章底色与卡片左缘色条：轻度 warn 黄 / 中度 caution 橙 / 重度 danger 红
 *    （与检测记录时间轴的等级配色同源；图标用同款铃铛 i-bell）；
 *  - 停留时长递增；
 *  - role=alert：读屏以 assertive 优先级即时播报。
 */
export function toastAlarm(level, title, msg = '') {
  const node = toast(title, msg, 'alarm', ALARM_MS[level] || 6000);
  node.dataset.level = level;
  node.setAttribute('role', 'alert');
  const chip = node.querySelector('.toast-icon');
  if (chip) chip.replaceChildren(svgUse('i-bell', 12));
  return node;
}
