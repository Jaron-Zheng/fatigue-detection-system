/** toast.js — 轻量通知（毛玻璃卡片，自动消失） */

import { el, $ } from '../util/dom.js';

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
