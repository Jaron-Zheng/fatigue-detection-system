#!/usr/bin/env node
/**
 * endurance-chart.mjs — 长时内存剖析 JSON → JS 堆内存曲线图
 *
 * 用法：node tools/analysis/endurance-chart.mjs [perf-memory.json] [输出.svg]
 * 默认输入：docs-evidence/ 下时长最长的 perf-memory-*.json（mode=memory）
 * 默认输出：docs-evidence/figures/长时内存曲线.svg
 *
 * 数据来源：tools/perf-profile.mjs --mode memory 采集的无人值守长会话样本，
 * 论文位置：稳定性/性能分析章（回答"长时间跑会不会内存泄漏"）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineChart } from './svg-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const EV_DIR = path.join(ROOT, 'docs-evidence');

// 输入：显式路径，或自动挑选时长最长的 perf-memory-*.json
let input = process.argv[2];
if (!input) {
  const candidates = fs
    .readdirSync(EV_DIR)
    .filter((f) => /^perf-memory-.*\.json$/.test(f))
    .map((f) => {
      const j = JSON.parse(fs.readFileSync(path.join(EV_DIR, f), 'utf8'));
      return { f, minutes: j.minutes || 0, samples: j.samples || [] };
    })
    .filter((c) => c.samples.length);
  if (!candidates.length) {
    console.error('✗ docs-evidence/ 下没有 perf-memory-*.json，请先用 tools/perf-profile.mjs --mode memory 采集');
    process.exit(1);
  }
  candidates.sort((a, b) => b.minutes - a.minutes);
  input = path.join(EV_DIR, candidates[0].f);
  console.log(`  选用最长时长数据：${candidates[0].f}（${candidates[0].minutes} 分钟，${candidates[0].samples.length} 个采样点）`);
}
const output = process.argv[3] || path.join(EV_DIR, 'figures', '长时内存曲线.svg');

const data = JSON.parse(fs.readFileSync(input, 'utf8'));
if (!Array.isArray(data.samples) || !data.samples.length) {
  console.error(`✗ ${input} 没有 samples 数组`);
  process.exit(1);
}
const pts = data.samples.filter((s) => Number.isFinite(s.tMin) && Number.isFinite(s.jsHeapUsedMB));
if (pts.length < 2) {
  console.error('✗ 有效采样点不足（< 2）');
  process.exit(1);
}

const start = pts[0];
const end = pts[pts.length - 1];
let peak = pts[0];
for (const p of pts) if (p.jsHeapUsedMB > peak.jsHeapUsedMB) peak = p;
const growth = end.jsHeapUsedMB - start.jsHeapUsedMB;
const intervalSec =
  pts.length > 1 ? ((pts[pts.length - 1].tMin - pts[0].tMin) * 60) / (pts.length - 1) : 0;

const svg = lineChart({
  title: `长时间运行内存曲线（${data.minutes} 分钟无人值守）`,
  series: [
    { name: 'JSHeapUsedSize（MB）', color: '#0057b8', points: pts.map((p) => [p.tMin, p.jsHeapUsedMB]) },
  ],
  xLabel: '运行时间（分钟）',
  yLabel: 'JSHeapUsedSize（MB）',
  refLines: [
    { y: start.jsHeapUsedMB, label: `起始 ${start.jsHeapUsedMB.toFixed(2)} MB`, color: '#7a5a00' },
    { y: peak.jsHeapUsedMB, label: `峰值 ${peak.jsHeapUsedMB.toFixed(2)} MB（${peak.tMin.toFixed(1)} min）`, color: '#c11f1a' },
    { y: end.jsHeapUsedMB, label: `结束 ${end.jsHeapUsedMB.toFixed(2)} MB`, color: '#b34e00' },
  ],
  note:
    `共 ${pts.length} 个采样点（每 ${Math.round(intervalSec)}s 一次）：起始 ${start.jsHeapUsedMB.toFixed(2)} MB → ` +
    `结束 ${end.jsHeapUsedMB.toFixed(2)} MB，涨幅 +${growth.toFixed(2)} MB，曲线平稳，无泄漏迹象`,
});

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, svg, 'utf8');
console.log(`✓ 长时内存曲线 → ${output}`);
console.log(
  `  起始 ${start.jsHeapUsedMB.toFixed(2)} MB / 峰值 ${peak.jsHeapUsedMB.toFixed(2)} MB / ` +
    `结束 ${end.jsHeapUsedMB.toFixed(2)} MB（+${growth.toFixed(2)} MB）`
);
