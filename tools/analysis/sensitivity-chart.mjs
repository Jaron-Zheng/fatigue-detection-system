#!/usr/bin/env node
/**
 * sensitivity-chart.mjs — 参数敏感性分析 CSV → 参数-指标曲线图
 *
 * 用法：node tools/analysis/sensitivity-chart.mjs <敏感性CSV> [输出目录]
 * 默认输入 tools/analysis/fixtures/sensitivity-demo.csv，
 * 默认输出目录 docs-evidence/figures/（每个参数一张图）
 *
 * 图表直观展示"稳定平台区"：曲线平坦且包含当前默认值的区间，
 * 说明结论对该参数不敏感——这是比引用文献范围更硬的取值依据。
 * 论文位置：参数选取依据/消融实验一节。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, lineChart, num } from './svg-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const input = process.argv[2] || path.join(__dirname, 'fixtures/sensitivity-demo.csv');
const outDir = process.argv[3] || path.join(ROOT, 'docs-evidence/figures');

const rows = parseCsv(fs.readFileSync(input, 'utf8'));
const header = rows[0];
if (header[0] !== '参数名') {
  console.error(`✗ ${input} 不是"敏感性分析 CSV"（首列应为"参数名"）`);
  process.exit(1);
}

// 按参数分组
const groups = new Map();
for (const r of rows.slice(1)) {
  if (!groups.has(r[0])) groups.set(r[0], []);
  groups.get(r[0]).push({
    value: num(r[1]),
    isCurrent: r[2] === '1',
    avgScore: num(r[4]),
    fatigueRatio: num(r[6]),
  });
}

/** 与产品端 findPlateau 同口径：相邻疲劳占比变化 ≤4pp 的最长连续段 */
function findPlateau(pts) {
  const segs = [];
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(pts[i].fatigueRatio - pts[i - 1].fatigueRatio) > 0.04) {
      if (i - start >= 2) segs.push([start, i - 1]);
      start = i;
    }
  }
  if (pts.length - start >= 2) segs.push([start, pts.length - 1]);
  if (!segs.length) return null;
  const best = segs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
  return { from: pts[best[0]].value, to: pts[best[1]].value };
}

fs.mkdirSync(outDir, { recursive: true });
let count = 0;
for (const [label, pts] of groups) {
  pts.sort((a, b) => a.value - b.value);
  const cur = pts.find((p) => p.isCurrent);
  const plateau = findPlateau(pts);
  const unit = ['EMA 平滑系数', 'PERCLOS 隶属下限'].includes(label) ? '' : (label.includes('时长') ? 'ms' : '分');
  // 注意：占比画成百分数，y 轴上限也要用百分数口径，否则曲线会画出图外
  const yTop = Math.max(10, ...pts.map((p) => p.fatigueRatio * 100), ...pts.map((p) => p.avgScore)) * 1.12;

  const svg = lineChart({
    title: `参数敏感性：${label}`,
    xLabel: `${label}${unit ? `（${unit}）` : ''}`,
    yLabel: '疲劳时间占比（%）',
    yMin: 0,
    yMax: yTop,
    series: [
      {
        name: '疲劳时间占比',
        color: '#e8730c',
        points: pts.map((p) => [p.value, p.fatigueRatio * 100]),
      },
      {
        name: '平均疲劳指数（右轴未分轴，仅形态参考）',
        color: '#0071e3',
        dash: '5 4',
        points: pts.map((p) => [p.value, p.avgScore]),
      },
    ],
    markers: cur ? [{ x: cur.value, label: '当前默认值', color: '#c11f1a' }] : [],
    note: plateau
      ? `疲劳占比在 [${plateau.from}, ${plateau.to}] 内变化 <4 个百分点：默认值落在不敏感的稳定平台区`
      : '该参数为单调敏感型：取值是灵敏度与误报率的直接权衡',
  });

  const safeName = label.replace(/[\\/:*?"<>|]/g, '_');
  const out = path.join(outDir, `敏感性_${safeName}.svg`);
  fs.writeFileSync(out, svg, 'utf8');
  console.log(`✓ ${label} → ${out}${plateau ? `（平台区 ${plateau.from}–${plateau.to}）` : ''}`);
  count++;
}
console.log(`共 ${count} 张参数敏感性图`);
