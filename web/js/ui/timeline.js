/**
 * timeline.js — 事件时间轴
 *
 * 只渲染增量：每次把新事件插到列表顶部，超出上限时移除尾部节点。
 * 若每次都全量重建列表，在长会话（数百条事件）下会造成明显卡顿。
 *
 * 合并策略：同级连续报警（含 suppressed 冷却期重复事件）折叠为一行，
 * 显示「×N」计数和最后触发时间，避免检测记录被重复话术刷屏。
 */

import { el, clear, setText, svgUse } from '../util/dom.js';
import { eventLabel } from '../core/recorder.js';
import { CONFIG } from '../config.js';

/* 事件类型 → SVG symbol id（index.html sprite，Feather 风格 24×24 stroke=2）。
 * 语义化的线性图标替代旧文本字符（◐ A ↓ ? !）：
 * 与全站按钮/导航图标同一套视觉语言，随 data-level 变色（currentColor）。 */
const ICON = {
  blink: 'i-eye', // 眨眼（不渲染，仅计数）
  microsleep: 'i-eye-closed', // 长闭眼：闭合眼睑+睫毛
  critical_closure: 'i-eye-closed', // 危险闭眼：同闭眼图标，靠 danger 配色区分
  yawn: 'i-yawn', // 打哈欠：张大的嘴
  nod: 'i-nod', // 点头：头部+向下 chevron
  distraction: 'i-look-away', // 分神：瞳孔偏移
  face_lost: 'i-face-off', // 人脸丢失：头肩像+否定斜杠
  face_found: 'i-user', // 人脸找回：头肩像
  quality_low: 'i-sun-low', // 质量低：短射线弱光太阳
  quality_ok: 'i-check', // 质量恢复：勾
  alarm: 'i-bell', // 疲劳报警：铃铛
  calibrated: 'i-target', // 校准完成：靶心（复用现有）
  session_start: 'i-play', // 会话开始（复用现有）
  session_end: 'i-stop', // 会话结束（复用现有）
};

/** 引用 sprite symbol 的内联 SVG 由 util/dom.js 的 svgUse 提供（与 toast 共用） */

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

/** 报警事件 alarmLevel → 展示档位。
 * mild/moderate/severe 没有对应 CSS 档，直接落到 data-level 会掉回
 * 默认灰底（此前铃铛不分级的根因）；映射到设计系统四档语义色：
 * 轻度=warn 黄、中度=caution 橙、重度=danger 红。 */
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

      // 合并策略：同级连续报警（含 suppressed 冷却期事件）折叠为一行，
      // 不新增行，而是更新顶部已有同类记录的计数与时间，避免重复话术刷屏。
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
   * 合并后更新计数「×N」与时间戳，详情展示最近一次的 reason。
   * 返回 true 表示已合并，false 表示需新增行。
   */
  _tryMergeAlarm(ev) {
    const top = this.buffer[0];
    if (!top || top.type !== 'alarm' || top.alarmLevel !== ev.alarmLevel) return false;
    // 合并：更新顶部记录的计数与时间
    top._mergeCount = (top._mergeCount || 1) + 1;
    top._lastTs = ev.ts;
    top.ts = ev.ts; // 同步主时间戳，保证后续排序/过滤一致
    if (ev.message) top.message = ev.message; // 用最新话术
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

  /** 就地更新已合并的行内容 */
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

  /** 展示层分级：报警事件按疲劳等级映射到语义色档，其余按类型映射 */
  _level(ev) {
    if (ev.type === 'alarm')
      return ALARM_LEVEL_MAP[ev.alarmLevel] || (ev.level === 'danger' ? 'danger' : 'warn');
    return LEVEL_BY_TYPE[ev.type] || ev.level || 'info';
  }

  _detail(ev) {
    // 先查展示层术语映射，命中的类型不走 indicators 生成的 message
    const fmt = DETAIL_BY_TYPE[ev.type];
    if (fmt) return fmt(ev);
    if (ev.message) {
      // 合并的报警事件追加「×N」计数，让用户知道这是多起同类事件
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
