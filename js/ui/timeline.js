/**
 * timeline.js — 事件时间轴
 *
 * 只渲染增量：每次把新事件插到列表顶部，超出上限时移除尾部节点。
 * 合并策略：同级连续报警（含 suppressed 冷却期重复事件）折叠为一行，
 * 显示「×N」计数和最后触发时间，避免重复话术刷屏。
 */

import { el, clear, setText, svgUse } from '../util/dom.js';
import { eventLabel } from '../core/recorder.js';
import { CONFIG } from '../config.js';

/* 事件类型 → SVG symbol id（index.html sprite，Feather 风格 24×24 stroke=2）。
 * 语义化的线性图标随 data-level 变色（currentColor） */
const ICON = {
  blink: 'i-eye',
  microsleep: 'i-eye-closed',
  critical_closure: 'i-eye-closed',
  yawn: 'i-yawn',
  nod: 'i-nod',
  distraction: 'i-look-away',
  face_lost: 'i-face-off',
  face_found: 'i-user',
  quality_low: 'i-sun-low',
  quality_ok: 'i-check',
  alarm: 'i-bell',
  calibrated: 'i-target',
  session_start: 'i-play',
  session_end: 'i-stop',
};

const MAX_ROWS = 120;

/**
 * 事件 detail 的展示层统一术语（type → 格式化函数）。
 * message 由 core/indicators.js 生成，本层不拥有、不去改它；
 * 这里只在渲染时按事件类型做替换，保证与指标卡、报告页用语一致。
 */
const DETAIL_BY_TYPE = {
  // 阈值读 CONFIG（与事件判定同源），不写死数字
  microsleep: (ev) =>
    `长闭眼 ≥${(CONFIG.event.microsleepMs / 1000).toFixed(1)}s：${((ev.durationMs || 0) / 1000).toFixed(2)} 秒`,
};

/**
 * 展示层事件分级（type → data-level）。
 * 事件源自带的 level 多数笼统为 warn，这里按类型重新分配严重度；
 * 未列出的类型沿用事件自带 level。
 */
const LEVEL_BY_TYPE = {
  microsleep: 'danger',
  critical_closure: 'danger',
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

/* 报警事件 alarmLevel → 展示档位映射到设计系统四档语义色 */
const ALARM_LEVEL_MAP = { mild: 'warn', moderate: 'caution', severe: 'danger' };

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

  /* 设置时间基准（会话开始时刻） */
  setBase(t0) {
    this.t0 = t0;
  }

  /* 设置只显示异常事件的过滤 */
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

  /* 批量追加事件 */
  add(events) {
    if (!this.host || !events || !events.length) return;
    for (const ev of events) {
      // 眨眼过于频繁，不逐条进时间轴
      if (ev.type === 'blink' || ev.type === 'yawn_end') {
        this.total++;
        continue;
      }

      // 同级连续报警合并到顶部已有同类记录
      if (ev.type === 'alarm' && this._tryMergeAlarm(ev)) {
        this.total++;
        if (this.countEl) setText(this.countEl, `${this.total} 条`);
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

  /**
   * 尝试将报警事件合并到列表顶部已有的同类记录中。
   * 合并条件：列表顶部是同类同级报警事件（包括 suppressed 冷却期事件）。
   * 合并后更新计数「×N」与时间戳，返回 true 表示已合并。
   */
  _tryMergeAlarm(ev) {
    const top = this.buffer[0];
    if (!top || top.type !== 'alarm' || top.alarmLevel !== ev.alarmLevel) return false;
    top._mergeCount = (top._mergeCount || 1) + 1;
    top._lastTs = ev.ts;
    top.ts = ev.ts;
    if (ev.message) top.message = ev.message;
    if (ev.suppressed) top._hasSuppressed = true;

    // 同步 DOM：如果顶部行可见，就地更新内容
    if (this.host && !this._empty && this._visible(top)) {
      const firstChild = this.host.firstChild;
      if (firstChild && firstChild._ev === top) {
        this._updateRow(firstChild, top);
      }
    }
    return true;
  }

  /* 判断事件是否在当前过滤下可见 */
  _visible(ev) {
    if (!this.onlyAbnormal) return true;
    return ev.level === 'warn' || ev.level === 'danger';
  }

  /* 全量重建列表（过滤变化时调用） */
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

  /* 构建单行事件 DOM */
  _row(ev) {
    const rel = Math.max(0, ev.ts - this.t0);
    const mm = String(Math.floor(rel / 60000)).padStart(2, '0');
    const ss = String(Math.floor((rel % 60000) / 1000)).padStart(2, '0');
    const detail = this._detail(ev);
    const icon = el('div.tl-icon', { 'aria-hidden': 'true' });
    icon.appendChild(svgUse(ICON[ev.type] || 'i-activity'));
    const row = el('div.tl-item', { dataset: { level: this._level(ev) } }, [
      el('div.tl-time', { text: `${mm}:${ss}` }),
      icon,
      el('div.tl-text', {}, [
        el('b', { text: eventLabel(ev.type) }),
        detail ? el('div.tl-detail', { text: detail }) : null,
      ]),
    ]);
    row._ev = ev; // 保存引用，供合并时就地更新
    return row;
  }

  /* 就地更新已合并的行内容 */
  _updateRow(row, ev) {
    const rel = Math.max(0, ev.ts - this.t0);
    const mm = String(Math.floor(rel / 60000)).padStart(2, '0');
    const ss = String(Math.floor((rel % 60000) / 1000)).padStart(2, '0');
    const timeEl = row.querySelector('.tl-time');
    if (timeEl) timeEl.textContent = `${mm}:${ss}`;
    const detail = this._detail(ev);
    const detailEl = row.querySelector('.tl-detail');
    if (detail) {
      if (detailEl) detailEl.textContent = detail;
      else {
        const textEl = row.querySelector('.tl-text');
        if (textEl) textEl.appendChild(el('div.tl-detail', { text: detail }));
      }
    } else if (detailEl) {
      detailEl.remove();
    }
  }

  /* 展示层分级：报警事件按疲劳等级映射到语义色档，其余按类型映射 */
  _level(ev) {
    if (ev.type === 'alarm')
      return ALARM_LEVEL_MAP[ev.alarmLevel] || (ev.level === 'danger' ? 'danger' : 'warn');
    return LEVEL_BY_TYPE[ev.type] || ev.level || 'info';
  }

  /* 生成事件详情文本 */
  _detail(ev) {
    // 先查展示层术语映射，命中的类型不走 indicators 生成的 message
    const fmt = DETAIL_BY_TYPE[ev.type];
    if (fmt) return fmt(ev);
    if (ev.message) {
      // 合并的报警事件追加「×N」计数
      if (ev._mergeCount && ev._mergeCount > 1) {
        const suppressed = ev._hasSuppressed ? '（含冷却期内重复）' : '';
        return `${ev.message} · ×${ev._mergeCount}${suppressed}`;
      }
      return ev.message;
    }
    if (Number.isFinite(ev.durationMs)) return `持续 ${(ev.durationMs / 1000).toFixed(2)}s`;
    return '';
  }
}
