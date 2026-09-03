/**
 * chart.js — 自研轻量 Canvas 折线图
 *
 * 为什么不用 ECharts / Chart.js？
 *   ① 保持零依赖与离线可用；
 *   ② 本场景每秒重绘 20+ 次，通用图表库的 DOM/SVG 开销与动画机制反而是负担；
 *   ③ 需要绘制"阈值参考线 + 等级色带"这类定制元素，自己画更直接。
 *
 * 实现要点：设备像素比适配（Retina 不模糊）、时间轴右对齐滚动、
 * 数据抽稀（同一像素列只取一个点）、渐变面积填充。
 */

import { fitCanvas, cssVar } from '../util/dom.js';

/**
 * Canvas 的 ctx.font 是独立的 CSS 解析器，不支持 var()——
 * 写成 '10px var(--font-sans, ...)' 会被判为非法值静默忽略，
 * 刻度文字回退到默认 10px sans-serif，与全站 Inter 字族脱节。
 * 这里直接写具体字族栈（与 tokens.css 的 --font-sans 保持一致）。
 */
const CHART_FONT =
  '10px Inter, "Inter var", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif';

export class LineChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   *   series: [{ key, color, width, fill, yMin, yMax, dash }]
   *   yMin/yMax: 全局 Y 范围（不传则自动）
   *   bands: [{ from, to, color }] 背景色带（用于疲劳等级区间）
   *   refLines: [{ y, color, label, dash }] 阈值参考线
   *   windowMs: 时间窗宽度
   *   interactive: 悬停十字准线 + 数值气泡（报告等静态图用；
   *                实时图每秒重绘 20+ 次，不开启以保持轻量）
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = {
      padding: { top: 10, right: 8, bottom: 18, left: 34 },
      yMin: null,
      yMax: null,
      windowMs: 30000,
      series: [],
      bands: [],
      refLines: [],
      yTicks: 4,
      showXAxis: true,
      interactive: false,
      ...opts,
    };
    this.w = 0;
    this.h = 0;
    this.ctx = canvas.getContext('2d');
    // 悬停交互状态：_hoverX 为最近一次鼠标的画布内横坐标（null 表示未悬停）
    this._hoverX = null;
    this._lastData = null;
    this._lastNow = null;
    if (this.opts.interactive) this._bindHover();
  }

  resize() {
    const r = fitCanvas(this.canvas);
    this.ctx = r.ctx;
    this.w = r.w;
    this.h = r.h;
  }

  /**
   * 每帧校验画布几何，尺寸变了就重新适配。
   *
   * 为什么不能只在 w/h 为 0 时才 resize：
   * 元素处于 display:none 时 getBoundingClientRect() 返回 0，
   * 而 fitCanvas 会把它钳到 1×1 —— 1 是个"真值"，于是这个错误尺寸
   * 会被一直沿用下去。切换视图、打开专业模式这类"隐藏→显示"的场景里，
   * 只要外部漏调一次 resize()，图表就会永久画在 1×1 的画布上（表现为空白）。
   * 在这里比对实际 CSS 尺寸，任何漏掉的 resize 都能在下一帧自愈。
   */
  _ensureSize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w !== this.w || h !== this.h) this.resize();
  }

  /**
   * @param {object} data { seriesKey: [{t, v}, ...] }
   * @param {number} nowTs 当前时间戳（右边界）
   */
  render(data, nowTs) {
    this._ensureSize();
    const { ctx, w, h } = this;
    const o = this.opts;
    const pad = o.padding;
    const plotW = Math.max(1, w - pad.left - pad.right);
    const plotH = Math.max(1, h - pad.top - pad.bottom);

    ctx.clearRect(0, 0, w, h);

    const t1 = nowTs;
    const t0 = nowTs - o.windowMs;

    // ---- Y 轴范围 ----
    let yMin = o.yMin;
    let yMax = o.yMax;
    if (yMin === null || yMax === null) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const s of o.series) {
        const arr = data[s.key] || [];
        for (const p of arr) {
          if (!Number.isFinite(p.v)) continue;
          if (p.v < lo) lo = p.v;
          if (p.v > hi) hi = p.v;
        }
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        lo = 0;
        hi = 1;
      }
      if (hi - lo < 1e-6) {
        hi = lo + 1;
      }
      const margin = (hi - lo) * 0.16;
      yMin = yMin === null ? lo - margin : yMin;
      yMax = yMax === null ? hi + margin : yMax;
    }
    const yRange = yMax - yMin || 1;

    const tSpan = t1 - t0 || 1;
    const X = (t) => pad.left + ((t - t0) / tSpan) * plotW;
    const Y = (v) => pad.top + plotH - ((v - yMin) / yRange) * plotH;

    // ---- 背景色带（疲劳等级区间） ----
    for (const b of o.bands) {
      const y1 = Y(Math.min(b.to, yMax));
      const y2 = Y(Math.max(b.from, yMin));
      if (y2 <= y1) continue;
      ctx.fillStyle = b.color;
      ctx.fillRect(pad.left, y1, plotW, y2 - y1);
    }

    // ---- 网格与 Y 轴刻度 ----
    const gridColor = cssVar('--chart-grid', 'rgba(0,0,0,0.06)');
    const axisColor = cssVar('--chart-axis', '#aeaeb2');
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.fillStyle = axisColor;
    ctx.font = CHART_FONT;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= o.yTicks; i++) {
      const v = yMin + (yRange * i) / o.yTicks;
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
      ctx.fillText(this._fmtTick(v, yRange), pad.left - 6, y);
    }

    // ---- X 轴时间刻度 ----
    if (o.showXAxis) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const steps = 4;
      for (let i = 0; i <= steps; i++) {
        const t = t0 + ((t1 - t0) * i) / steps;
        const x = Math.round(X(t)) + 0.5;
        ctx.strokeStyle = gridColor;
        ctx.beginPath();
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, pad.top + plotH);
        ctx.stroke();
        const secAgo = Math.round((t1 - t) / 1000);
        ctx.fillStyle = axisColor;
        ctx.fillText(secAgo === 0 ? '现在' : `-${secAgo}s`, x, pad.top + plotH + 4);
      }
    }

    // ---- 阈值参考线 ----
    for (const rl of o.refLines) {
      if (!Number.isFinite(rl.y) || rl.y < yMin || rl.y > yMax) continue;
      const y = Math.round(Y(rl.y)) + 0.5;
      ctx.save();
      ctx.strokeStyle = rl.color || axisColor;
      ctx.lineWidth = 1.2;
      ctx.setLineDash(rl.dash || [4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
      ctx.restore();
      if (rl.label) {
        // 标签靠右放置并加半透明底衬：靠左会压住 Y 轴刻度数字，
        // 不加底衬则在与曲线、色带重叠时读不清。
        const tw = ctx.measureText(rl.label).width;
        const tx = pad.left + plotW - 5;
        const ty = y - 3;
        ctx.fillStyle = cssVar('--bg-elevated', '#fff');
        ctx.globalAlpha = 0.82;
        ctx.fillRect(tx - tw - 4, ty - 11, tw + 8, 13);
        ctx.globalAlpha = 1;
        ctx.fillStyle = rl.color || axisColor;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(rl.label, tx, ty);
      }
    }

    // ---- 曲线 ----
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, pad.top, plotW, plotH);
    ctx.clip();

    for (const s of o.series) {
      const arr = data[s.key] || [];
      if (arr.length < 2) continue;

      // 抽稀：同一像素列只保留一个点
      const pts = [];
      let lastPx = -1e9;
      for (const p of arr) {
        if (!Number.isFinite(p.v)) continue;
        if (p.t < t0 - 500) continue;
        const px = X(p.t);
        if (px - lastPx < 0.75) {
          pts[pts.length - 1] = { x: px, y: Y(p.v) };
        } else {
          pts.push({ x: px, y: Y(p.v) });
          lastPx = px;
        }
      }
      if (pts.length < 2) continue;

      // 面积填充
      if (s.fill) {
        const g = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
        g.addColorStop(0, s.fill);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pad.top + plotH);
        for (const p of pts) ctx.lineTo(p.x, p.y);
        ctx.lineTo(pts[pts.length - 1].x, pad.top + plotH);
        ctx.closePath();
        ctx.fill();
      }

      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 1.8;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (s.dash) ctx.setLineDash(s.dash);
      else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.setLineDash([]);

      // 末端光点：强调"当前值"
      const last = pts[pts.length - 1];
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(last.x, last.y, 2.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      ctx.arc(last.x, last.y, 6.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // ---- 悬停十字准线 + 数值气泡（interactive 模式）----
    // 缓存最近一次的数据与右边界，mousemove 时复用同一条 render 路径重绘
    this._lastData = data;
    this._lastNow = nowTs;
    if (this.opts.interactive && this._hoverX !== null) {
      this._drawHover(ctx, { pad, plotW, plotH, t0, t1, X, Y });
    }
  }

  /**
   * 悬停交互（仅 interactive: true 的静态图，见构造函数注释）。
   * 报告数据是静态数组、单次绘制成本低，复用 render() 比另做增量
   * 图层简单，且天然继承主题/尺寸变化后的重绘。
   *
   * E2 rAF 合帧节流：mousemove 事件最高可达 125Hz（高刷鼠标），
   * 原先每次事件都全量重绘（7200 点报告图单次 2~6ms），一秒内白做
   * 上百次。改为事件里只记录 _hoverX，pending 标志保证同一帧内多次
   * 事件合并为下一次 rAF 的一次重绘——"每帧至多重绘一次"正好是屏幕
   * 实际呈现上限，比 util/dom.js 的定时 throttle(ms) 更贴合该语义
   * （throttle 的固定间隔与刷新率脱节，仍可能一帧画两次或跳帧）。
   */
  _bindHover() {
    this._repaintPending = false;
    this.canvas.addEventListener('mousemove', (e) => {
      // offsetX 即相对 canvas 左上角的 CSS 像素坐标，与 this.w 同一坐标系
      this._hoverX = Math.max(0, Math.min(this.w, e.offsetX));
      this._scheduleRepaint();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this._hoverX = null;
      this._scheduleRepaint();
    });
  }

  /** 把悬停重绘合并到下一动画帧；已有排程则直接复用 */
  _scheduleRepaint() {
    if (this._repaintPending) return;
    this._repaintPending = true;
    requestAnimationFrame(() => {
      this._repaintPending = false;
      this._repaint();
    });
  }

  _repaint() {
    if (this._lastData) this.render(this._lastData, this._lastNow);
  }

  /** 在最近数据点处画竖直准线、点标记与"时间 · 数值"气泡 */
  _drawHover(ctx, { pad, plotW, plotH, t0, t1, X, Y }) {
    // 找横坐标最接近悬停位置的采样点：数据按时间升序且为静态数组，
    // 线性扫描即可（几千点量级）；以第一个有数据的序列为准（报告图单序列）
    const o = this.opts;
    let best = null;
    for (const s of o.series) {
      const arr = this._lastData[s.key] || [];
      for (const p of arr) {
        if (!Number.isFinite(p.v) || p.t < t0 || p.t > t1) continue;
        const d = Math.abs(X(p.t) - this._hoverX);
        if (!best || d < best.d) best = { d, t: p.t, v: p.v, color: s.color };
      }
      if (best) break;
    }
    if (!best) return;
    const x = X(best.t);
    const y = Y(best.v);

    // 竖直准线
    ctx.save();
    ctx.strokeStyle = cssVar('--chart-axis', '#aeaeb2');
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, pad.top);
    ctx.lineTo(Math.round(x) + 0.5, pad.top + plotH);
    ctx.stroke();
    ctx.restore();

    // 悬停点标记
    ctx.fillStyle = best.color;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // 气泡文字：时间 mm:ss · 数值
    const sec = Math.max(0, Math.round(best.t / 1000));
    const label = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} · ${best.v.toFixed(1)}`;
    ctx.font = CHART_FONT;
    const tw = ctx.measureText(label).width;
    const bw = tw + 12;
    const bh = 18;
    const bx = Math.min(Math.max(pad.left, x - bw / 2), pad.left + plotW - bw);
    let by = y - bh - 8;
    if (by < pad.top) by = Math.min(y + 8, pad.top + plotH - bh); // 顶部越界改放点下方
    ctx.fillStyle = cssVar('--bg-elevated', '#fff');
    ctx.strokeStyle = cssVar('--chart-grid', 'rgba(0,0,0,0.12)');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(bx, by, bw, bh);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = cssVar('--text', '#1d1d1f');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + bw / 2, by + bh / 2 + 0.5);
  }

  _fmtTick(v, range) {
    if (range >= 50) return String(Math.round(v));
    if (range >= 5) return v.toFixed(1);
    return v.toFixed(2);
  }
}

/**
 * 条形分布图：用于报告页展示各等级驻留时长占比。
 */
export function renderDistribution(container, ratios, labels, colors) {
  container.innerHTML = '';
  const order = ['awake', 'mild', 'moderate', 'severe'];
  for (const k of order) {
    const pct = (ratios[k] || 0) * 100;
    if (pct <= 0.05) continue;
    const seg = document.createElement('div');
    seg.className = 'dist-seg';
    seg.style.flexBasis = pct + '%';
    seg.style.background = colors[k];
    // 精度与图例（title、dist-legend）一致取 1 位小数，避免同一数字两处口径不同；
    // 过窄分段（<8%）放不下文字，靠 title 悬浮提示补全
    seg.textContent = pct >= 8 ? `${pct.toFixed(1)}%` : '';
    seg.title = `${labels[k]} ${pct.toFixed(1)}%`;
    /* 文字色不再在这里硬编码：CSS 的 .dist-seg 走 --on-lv 令牌
     * （等级色为单一配色、中等明度，两主题统一白字） */
    container.appendChild(seg);
  }
  if (!container.children.length) {
    const seg = document.createElement('div');
    seg.className = 'dist-seg';
    seg.style.flexBasis = '100%';
    seg.style.background = 'var(--fill-tertiary)';
    container.appendChild(seg);
  }
}
