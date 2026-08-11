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
 * 刻度文字回退到默认 10px sans-serif，与全站 SF Pro 字族脱节。
 * 这里直接写具体字族栈（与 tokens.css 的 --font-sans 保持一致）。
 */
const CHART_FONT = '10px -apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", Arial, sans-serif';

export class LineChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   *   series: [{ key, color, width, fill, yMin, yMax, dash }]
   *   yMin/yMax: 全局 Y 范围（不传则自动）
   *   bands: [{ from, to, color }] 背景色带（用于疲劳等级区间）
   *   refLines: [{ y, color, label, dash }] 阈值参考线
   *   windowMs: 时间窗宽度
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
      ...opts,
    };
    this.w = 0;
    this.h = 0;
    this.ctx = canvas.getContext('2d');
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
    seg.textContent = pct >= 8 ? `${pct.toFixed(0)}%` : '';
    seg.title = `${labels[k]} ${pct.toFixed(1)}%`;
    /* 文字色不再在这里硬编码：CSS 的 .dist-seg 用 --on-lv 分主题给出
     * （浅色四档加深后配白字，深色高明度色配近黑字） */
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
