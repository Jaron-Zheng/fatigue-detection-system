/**
 * timeline.js — 事件时间轴
 *
 * 只渲染增量：每次把新事件插到列表顶部，超出上限时移除尾部节点。
 * 若每次都全量重建列表，在长会话（数百条事件）下会造成明显卡顿。
 */

import { el, clear, setText } from '../util/dom.js';
import { eventLabel } from '../core/recorder.js';

const ICON = {
  blink: '·',
  microsleep: '◐',
  critical_closure: '●',
  yawn: 'A',
  nod: '↓',
  distraction: '→',
  face_lost: '?',
  face_found: '✓',
  quality_low: '◌',
  quality_ok: '✓',
  alarm: '!',
  calibrated: '✓',
  session_start: '▶',
  session_end: '■',
};

const MAX_ROWS = 120;

export class Timeline {
  constructor(hostId, countId) {
    this.host = document.getElementById(hostId);
    this.countEl = document.getElementById(countId);
    this.t0 = performance.now();
    this.total = 0;
    this.onlyAbnormal = false;
    this.buffer = [];
    this._empty = true;
  }

  setBase(t0) {
    this.t0 = t0;
  }

  setFilter(onlyAbnormal) {
    this.onlyAbnormal = onlyAbnormal;
    this._rebuild();
  }

  clear() {
    this.buffer = [];
    this.total = 0;
    this._empty = true;
    if (this.host) {
      clear(this.host);
      this.host.appendChild(el('div.empty', { text: '暂无事件' }));
    }
    if (this.countEl) setText(this.countEl, '0 条');
  }

  /** 批量追加事件 */
  add(events) {
    if (!this.host || !events || !events.length) return;
    for (const ev of events) {
      // 眨眼过于频繁，不逐条进时间轴（否则会把重要事件挤走）
      if (ev.type === 'blink' || ev.type === 'yawn_end') {
        this.total++;
        continue;
      }
      this.buffer.unshift(ev);
      this.total++;
      if (this.buffer.length > MAX_ROWS) this.buffer.pop();

      if (this._visible(ev)) {
        if (this._empty) {
          clear(this.host);
          this._empty = false;
        }
        this.host.insertBefore(this._row(ev), this.host.firstChild);
        while (this.host.children.length > MAX_ROWS) this.host.removeChild(this.host.lastChild);
      }
    }
    if (this.countEl) setText(this.countEl, `${this.total} 条`);
  }

  _visible(ev) {
    if (!this.onlyAbnormal) return true;
    return ev.level === 'warn' || ev.level === 'danger';
  }

  _rebuild() {
    if (!this.host) return;
    clear(this.host);
    const list = this.buffer.filter((e) => this._visible(e));
    if (!list.length) {
      this.host.appendChild(el('div.empty', { text: this.onlyAbnormal ? '暂无异常事件' : '暂无事件' }));
      this._empty = true;
      return;
    }
    this._empty = false;
    for (const ev of list) this.host.appendChild(this._row(ev));
  }

  _row(ev) {
    const rel = Math.max(0, ev.ts - this.t0);
    const mm = String(Math.floor(rel / 60000)).padStart(2, '0');
    const ss = String(Math.floor((rel % 60000) / 1000)).padStart(2, '0');
    const detail = this._detail(ev);
    return el('div.tl-item', { dataset: { level: ev.level || 'info' } }, [
      el('div.tl-time', { text: `${mm}:${ss}` }),
      el('div.tl-icon', { text: ICON[ev.type] || '•', 'aria-hidden': 'true' }),
      el('div.tl-text', {}, [
        el('b', { text: eventLabel(ev.type) }),
        detail ? el('div.tl-detail', { text: detail }) : null,
      ]),
    ]);
  }

  _detail(ev) {
    if (ev.message) return ev.message;
    if (Number.isFinite(ev.durationMs)) return `持续 ${(ev.durationMs / 1000).toFixed(2)}s`;
    return '';
  }
}
