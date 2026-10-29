/**
 * svg-lib.mjs — 论文图表 SVG 绘图基础库（零依赖）
 *
 * 第三轮角色十。环境没有 Python/matplotlib，按任务书的降级方案用
 * Node.js 直出 SVG 矢量图——论文插图要求矢量或 ≥150dpi，SVG 直接满足，
 * 且浏览器/Word/LaTeX 都能打开。中文字体在查看端按系统字体渲染。
 *
 * 风格约定（去掉绘图库默认样式，统一"论文观感"）：
 *   · 白底、细灰网格、黑轴文字
 *   · 中文标签、无衬线字体栈
 *   · 图例放右上角，不压数据线
 */

export const FONT = `'Microsoft YaHei','PingFang SC','Helvetica Neue',Arial,sans-serif`;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 生成一段带边框的完整 SVG 文档 */
export function svgDoc(width, height, body, { title = '' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">
${title ? `<title>${esc(title)}</title>` : ''}
<rect width="${width}" height="${height}" fill="#ffffff"/>
${body}
</svg>`;
}

export const text = (x, y, s, { size = 13, color = '#1d1d1f', anchor = 'middle', weight = 400, rotate = null } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" text-anchor="${anchor}" font-weight="${weight}"${rotate ? ` transform="rotate(${rotate} ${x} ${y})"` : ''}>${esc(s)}</text>`;

export const line = (x1, y1, x2, y2, { color = '#d2d2d7', width = 1, dash = null } = {}) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

export const rect = (x, y, w, h, { fill = '#0071e3', opacity = 1, stroke = null, rx = 0 } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" fill-opacity="${opacity}"${stroke ? ` stroke="${stroke}" stroke-width="1"` : ''} rx="${rx}"/>`;

/**
 * 折线图。
 * @param {object} o
 * @param {string} o.title
 * @param {Array<{name:string,color:string,points:[number,number][],dash?:string}>} o.series
 * @param {string} [o.xLabel] @param {string} [o.yLabel]
 * @param {number} [o.yMin] @param {number} [o.yMax]
 * @param {Array<{y:number,label:string,color?:string,dash?:string}>} [o.refLines]
 * @param {Array<{x:number,label:string,color?:string}>} [o.markers] 竖直标记线（如报警点）
 * @param {(v:number)=>string} [o.xFmt] @param {(v:number)=>string} [o.yFmt]
 * @param {string} [o.note] 图下方的小字说明
 */
export function lineChart(o) {
  const W = o.width || 860;
  const H = o.height || 460;
  const M = { top: 56, right: 150, bottom: 64, left: 72 };
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;

  const xs = o.series.flatMap((s) => s.points.map((p) => p[0]));
  const ys = o.series.flatMap((s) => s.points.map((p) => p[1]));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = o.yMin !== undefined ? o.yMin : Math.min(...ys, ...(o.refLines || []).map((r) => r.y));
  const yMax = o.yMax !== undefined ? o.yMax : Math.max(...ys, ...(o.refLines || []).map((r) => r.y));
  const sx = (x) => M.left + ((x - xMin) / (xMax - xMin || 1)) * iw;
  const sy = (y) => M.top + ih - ((y - yMin) / (yMax - yMin || 1)) * ih;
  const xFmt = o.xFmt || ((v) => String(Math.round(v * 100) / 100));
  const yFmt = o.yFmt || ((v) => String(Math.round(v * 100) / 100));

  let g = '';
  g += text(W / 2, 28, o.title, { size: 17, weight: 600 });

  // 网格与刻度
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + ((yMax - yMin) * i) / yTicks;
    const y = sy(v);
    g += line(M.left, y, M.left + iw, y, { color: i === 0 ? '#86868b' : '#ececef' });
    g += text(M.left - 10, y + 4, yFmt(v), { size: 11, color: '#515154', anchor: 'end' });
  }
  const xTicks = Math.min(8, Math.max(4, Math.floor(iw / 110)));
  for (let i = 0; i <= xTicks; i++) {
    const v = xMin + ((xMax - xMin) * i) / xTicks;
    const x = sx(v);
    g += line(x, M.top, x, M.top + ih, { color: '#f2f2f4' });
    g += text(x, M.top + ih + 20, xFmt(v), { size: 11, color: '#515154' });
  }
  g += line(M.left, M.top, M.left, M.top + ih, { color: '#86868b' });

  // 参考线与竖直标记
  for (const r of o.refLines || []) {
    g += line(M.left, sy(r.y), M.left + iw, sy(r.y), { color: r.color || '#c11f1a', dash: r.dash || '6 4' });
    g += text(M.left + iw - 4, sy(r.y) - 5, r.label, { size: 11, color: r.color || '#c11f1a', anchor: 'end' });
  }
  for (const m of o.markers || []) {
    g += line(sx(m.x), M.top, sx(m.x), M.top + ih, { color: m.color || '#c11f1a', width: 1.2, dash: '3 3' });
    if (m.label) g += text(sx(m.x) + 4, M.top + 12, m.label, { size: 10, color: m.color || '#c11f1a', anchor: 'start' });
  }

  // 数据线
  for (const s of o.series) {
    if (!s.points.length) continue;
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round"/>`;
  }

  // 图例
  let ly = M.top + 4;
  for (const s of o.series) {
    g += line(M.left + iw + 16, ly, M.left + iw + 40, ly, { color: s.color, width: 2.5, dash: s.dash });
    g += text(M.left + iw + 46, ly + 4, s.name, { size: 11.5, anchor: 'start', color: '#1d1d1f' });
    ly += 22;
  }

  if (o.xLabel) g += text(M.left + iw / 2, H - 14, o.xLabel, { size: 12.5, color: '#1d1d1f' });
  if (o.yLabel) g += text(20, M.top + ih / 2, o.yLabel, { size: 12.5, color: '#1d1d1f', rotate: -90 });
  if (o.note) g += text(W / 2, H - 1, o.note, { size: 10.5, color: '#6e6e73' });
  return svgDoc(W, H, g, { title: o.title });
}

/**
 * 条形图（水平标签，适合少量类别的贡献度对比）。
 * @param {object} o
 * @param {Array<{label:string,value:number,color?:string}>} o.items
 */
export function barChart(o) {
  const W = o.width || 860;
  const H = o.height || 440;
  const M = { top: 56, right: 40, bottom: 88, left: 72 };
  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;

  const vals = o.items.map((i) => i.value);
  const vMin = Math.min(0, ...vals);
  const vMax = Math.max(0, ...vals);
  const pad = (vMax - vMin) * 0.12 || 1;
  const lo = vMin - (vMin < 0 ? pad : 0);
  const hi = vMax + (vMax > 0 ? pad : 0);
  const sy = (v) => M.top + ih - ((v - lo) / (hi - lo)) * ih;
  const yFmt = o.yFmt || ((v) => String(Math.round(v * 100) / 100));

  let g = '';
  g += text(W / 2, 28, o.title, { size: 17, weight: 600 });
  for (let i = 0; i <= 5; i++) {
    const v = lo + ((hi - lo) * i) / 5;
    g += line(M.left, sy(v), M.left + iw, sy(v), { color: Math.abs(v) < 1e-9 ? '#86868b' : '#ececef' });
    g += text(M.left - 10, sy(v) + 4, yFmt(v), { size: 11, color: '#515154', anchor: 'end' });
  }
  const bw = Math.min(72, (iw / o.items.length) * 0.55);
  o.items.forEach((it, i) => {
    const cx = M.left + (iw * (i + 0.5)) / o.items.length;
    const y0 = sy(0);
    const y1 = sy(it.value);
    g += rect(cx - bw / 2, Math.min(y0, y1), bw, Math.abs(y1 - y0) || 1, { fill: it.color || '#0071e3', rx: 3 });
    g += text(cx, Math.min(y0, y1) - 7, yFmt(it.value), { size: 11.5, weight: 600 });
    // 长中文标签斜排，避免互相压
    g += text(cx + 4, M.top + ih + 18, it.label, { size: 11.5, anchor: 'end', rotate: -28, color: '#1d1d1f' });
  });
  g += line(M.left, M.top, M.left, M.top + ih, { color: '#86868b' });
  if (o.yLabel) g += text(20, M.top + ih / 2, o.yLabel, { size: 12.5, rotate: -90 });
  if (o.note) g += text(W / 2, H - 1, o.note, { size: 10.5, color: '#6e6e73' });
  return svgDoc(W, H, g, { title: o.title });
}

/**
 * 2×2 混淆矩阵热力图 + 右侧指标表。
 * @param {object} o
 * @param {{tp:number,fp:number,tn:number,fn:number}} o.matrix 计数（或时间毫秒）
 * @param {Array<[string,string]>} o.metrics [[名称, 数值字符串]]
 */
export function confusionChart(o) {
  const W = 860;
  const H = 430;
  const cx = 70;
  const cy = 86;
  const cell = 130;
  const { tp, fp, tn, fn } = o.matrix;
  const total = tp + fp + tn + fn || 1;
  const maxV = Math.max(tp, fp, tn, fn) || 1;

  // 绿=判对，红=判错；深浅按占比
  const cellFill = (v, ok) => {
    const a = 0.15 + 0.75 * (v / maxV);
    return ok ? `rgba(20,106,56,${a.toFixed(2)})` : `rgba(193,31,26,${a.toFixed(2)})`;
  };

  let g = '';
  g += text(W / 2, 28, o.title, { size: 17, weight: 600 });
  g += text(cx + cell, cy - 26, '系统判定', { size: 13, weight: 600 });
  g += text(cx + cell / 2, cy - 8, '正常', { size: 12, color: '#515154' });
  g += text(cx + cell * 1.5, cy - 8, '疲劳', { size: 12, color: '#515154' });
  g += text(cx - 40, cy + cell / 2, '人工标注', { size: 13, weight: 600, rotate: -90 });
  g += text(cx - 12, cy + cell / 2 + 4, '正常', { size: 12, color: '#515154', anchor: 'end' });
  g += text(cx - 12, cy + cell * 1.5 + 4, '疲劳', { size: 12, color: '#515154', anchor: 'end' });

  const cells = [
    [tn, cx, cy, true, 'TN'],
    [fp, cx + cell, cy, false, 'FP 误报'],
    [fn, cx, cy + cell, false, 'FN 漏报'],
    [tp, cx + cell, cy + cell, true, 'TP'],
  ];
  for (const [v, x, y, ok, lab] of cells) {
    g += rect(x, y, cell, cell, { fill: cellFill(v, ok), stroke: '#ffffff' });
    g += text(x + cell / 2, y + cell / 2 - 6, lab, { size: 12.5, color: '#1d1d1f', weight: 600 });
    g += text(x + cell / 2, y + cell / 2 + 16, `${v}（${((v / total) * 100).toFixed(1)}%）`, { size: 12, color: '#1d1d1f' });
  }

  // 指标表
  let ty = cy + 8;
  const tx = cx + cell * 2 + 70;
  g += text(tx, ty - 10, '评价指标', { size: 14, weight: 600, anchor: 'start' });
  for (const [name, val] of o.metrics) {
    g += text(tx, ty + 12, name, { size: 12, anchor: 'start', color: '#515154' });
    g += text(tx + 260, ty + 12, val, { size: 12.5, anchor: 'end', weight: 600 });
    ty += 26;
  }
  if (o.note) g += text(W / 2, H - 12, o.note, { size: 10.5, color: '#6e6e73' });
  return svgDoc(W, H, g, { title: o.title });
}

/** 简易 CSV 解析：支持引号包裹与 "" 转义（与导出端 csvCell 对应） */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  const s = text.replace(/^\ufeff/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  // 导出端对以 = - + @ 开头的文本加前导单引号防公式注入，读回来去掉
  return rows.map((r) => r.map((v) => (v.startsWith("'") ? v.slice(1) : v)));
}

export const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};
