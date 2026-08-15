/**
 * timeline.js — 事件时间轴
 *
 * 只渲染增量：每次把新事件插到列表顶部，超出上限时移除尾部节点。
 * 若每次都全量重建列表，在长会话（数百条事件）下会造成明显卡顿。
 */

import { el, clear, setText } from '../util/dom.js';
import { eventLabel } from '../core/recorder.js';
import { CONFIG } from '../config.js';

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

/**
 * 事件 detail 的展示层统一术语（type → 格式化函数）。
 * message 由 core/indicators.js 生成，本层不拥有、不去改它；
 * 这里只在渲染时按事件类型做替换，保证与指标卡、报告页用语一致。
 */
const DETAIL_BY_TYPE = {
  // indicators 原文「长时闭眼 0.53s」→ 统一为「长闭眼 ≥0.5s：0.53 秒」，
  // 阈值读 CONFIG（与事件判定同源），不写死数字
  microsleep: (ev) =>
    `长闭眼 ≥${(CONFIG.event.microsleepMs / 1000).toFixed(1)}s：${((ev.durationMs || 0) / 1000).toFixed(2)} 秒`,
};

/**
 * 展示层事件分级（type → data-level）。
 * 事件源自带的 level 多数笼统为 warn，这里按类型重新分配严重度；
 * 未列出的类型沿用事件自带 level。报警事件单独处理（见 _level）。
 */
const LEVEL_BY_TYPE = {
  microsleep: 'danger', // 长闭眼/微睡眠：疲劳强信号
  critical_closure: 'danger', // 危险闭眼：最高级
  yawn: 'warn',
  nod: 'warn',
  distraction: 'warn',
  quality_low: 'warn',
  face_lost: 'info',
  face_found: 'info',
  quality_ok: 'info',
  calibrated: 'info',
  session_start: 'info',
  session_end: 'info',
  blink: 'info',
  yawn_end: 'info',
};

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
    return el('div.tl-item', { dataset: { level: this._level(ev) } }, [
      el('div.tl-time', { text: `${mm}:${ss}` }),
      el('div.tl-icon', { text: ICON[ev.type] || '•', 'aria-hidden': 'true' }),
      el('div.tl-text', {}, [
        el('b', { text: eventLabel(ev.type) }),
        detail ? el('div.tl-detail', { text: detail }) : null,
      ]),
    ]);
  }

  /** 展示层分级：报警事件用其疲劳等级，其余按类型映射 */
  _level(ev) {
    if (ev.type === 'alarm') return ev.alarmLevel || ev.level || 'warn';
    return LEVEL_BY_TYPE[ev.type] || ev.level || 'info';
  }

  _detail(ev) {
    // 先查展示层术语映射，命中的类型不走 indicators 生成的 message
    const fmt = DETAIL_BY_TYPE[ev.type];
    if (fmt) return fmt(ev);
    if (ev.message) return ev.message;
    if (Number.isFinite(ev.durationMs)) return `持续 ${(ev.durationMs / 1000).toFixed(2)}s`;
    return '';
  }
}
