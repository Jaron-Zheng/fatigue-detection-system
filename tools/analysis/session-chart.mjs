#!/usr/bin/env node
/**
 * session-chart.mjs — 疲劳检测指标 CSV → 一次会话的疲劳指数时间序列图
 *
 * 用法：node tools/analysis/session-chart.mjs <会话CSV> [会话JSON] [输出.svg]
 * 默认输入 tools/analysis/fixtures/session-demo.csv + session-demo.json，
 * 默认输出 docs-evidence/figures/会话疲劳指数时序.svg
 *
 * 论文位置："系统运行实例"一章的标配图：
 * 疲劳指数曲线 + 轻/中/重三级阈值参考线 + 报警触发点标注。
 * 报警点来自随会话导出的 JSON（events 中 type=alarm）；
 * 不提供 JSON 时只画曲线与阈值线。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, lineChart, num } from './svg-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const input = process.argv[2] || path.join(__dirname, 'fixtures/session-demo.csv');
const jsonInput = process.argv[3] || input.replace(/\.csv$/i, '.json');
const output = process.argv[4] || path.join(ROOT, 'docs-evidence/figures/会话疲劳指数时序.svg');

const rows = parseCsv(fs.readFileSync(input, 'utf8'));
const header = rows[0];
const colT = header.findIndex((h) => h === '时间(毫秒)' || h === 't_ms');
const colScore = header.findIndex((h) => h === '疲劳指数' || h === 'score');
const colRaw = header.findIndex((h) => h === '平滑前原始指数' || h === 'raw_score');
if (colT < 0 || colScore < 0) {
  console.error(`✗ ${input} 不是会话指标 CSV（找不到"时间(毫秒)"/"疲劳指数"列）`);
  process.exit(1);
}

const points = [];
const rawPoints = [];
for (const r of rows.slice(1)) {
  const tMin = num(r[colT]) / 60000;
  const s = num(r[colScore]);
  if (!Number.isFinite(tMin) || !Number.isFinite(s)) continue;
  points.push([tMin, s]);
  if (colRaw >= 0) {
    const rv = num(r[colRaw]);
    if (Number.isFinite(rv)) rawPoints.push([tMin, rv]);
  }
}
if (points.length < 2) {
  console.error('✗ CSV 中有效采样点不足');
  process.exit(1);
}

// 报警事件（可选 JSON）
const markers = [];
if (fs.existsSync(jsonInput)) {
  try {
    const data = JSON.parse(fs.readFileSync(jsonInput, 'utf8'));
    for (const e of data.events || []) {
      if (e.type === 'alarm') {
        markers.push({ x: (e.tMs || 0) / 60000, label: '报警', color: '#c11f1a' });
      }
    }
  } catch {
    console.warn('! 会话 JSON 解析失败，跳过报警点标注');
  }
}

const series = [
  { name: '疲劳指数（EMA 平滑）', color: '#e8730c', width: 2.4, points },
];
if (rawPoints.length) series.push({ name: '平滑前原始值', color: '#aeaeb2', width: 1.2, dash: '4 3', points: rawPoints });

const svg = lineChart({
  title: '一次检测会话的疲劳指数时间序列',
  xLabel: '时间（分钟）',
  yLabel: '疲劳指数（0–100）',
  yMin: 0,
  yMax: 100,
  series,
  refLines: [
    { y: 30, label: '轻度阈值 30', color: '#7a5a00', dash: '6 4' },
    { y: 52, label: '中度阈值 52', color: '#b34e00', dash: '6 4' },
    { y: 74, label: '重度阈值 74', color: '#c11f1a', dash: '6 4' },
  ],
  markers,
  xFmt: (v) => v.toFixed(1),
  note: `共 ${points.length} 个采样点（每 0.5s 一条）${markers.length ? `，标出 ${markers.length} 次报警触发` : ''}`,
});

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, svg, 'utf8');
console.log(`✓ 会话时序图 → ${output}（${points.length} 点${markers.length ? `，${markers.length} 次报警` : ''}）`);
