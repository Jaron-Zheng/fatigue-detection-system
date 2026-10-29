#!/usr/bin/env node
/**
 * ablation-chart.mjs — 权重消融实验 CSV → 特征贡献度条形图
 *
 * 用法：node tools/analysis/ablation-chart.mjs <消融CSV> [输出.svg]
 * 默认输入 tools/analysis/fixtures/ablation-demo.csv，
 * 默认输出 docs-evidence/figures/权重消融贡献度.svg
 *
 * 贡献度口径："扣除该特征后平均疲劳指数的变化量"——
 * 变化越大说明融合结论越依赖该特征。
 * 论文位置：消融实验一节（回答"每个指标到底有没有用"）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, barChart, num } from './svg-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const input = process.argv[2] || path.join(__dirname, 'fixtures/ablation-demo.csv');
const output = process.argv[3] || path.join(ROOT, 'docs-evidence/figures/权重消融贡献度.svg');

const rows = parseCsv(fs.readFileSync(input, 'utf8'));
if (rows[0][0] !== '被扣除的指标') {
  console.error(`✗ ${input} 不是"权重消融实验 CSV"（首列应为"被扣除的指标"）`);
  process.exit(1);
}

const base = rows.find((r) => r[0].includes('基线'));
const items = rows
  .slice(1)
  .filter((r) => !r[0].includes('基线'))
  .map((r) => ({
    label: r[0],
    deltaAvg: num(r[3]),
    deltaRatio: num(r[6]),
  }))
  // 贡献大的排前面；升序后翻转，让"扣掉后分数掉得最多"的指标最显眼
  .sort((a, b) => a.deltaAvg - b.deltaAvg);

const palette = ['#c11f1a', '#b34e00', '#7a5a00', '#146a38', '#0057b8', '#6e6e73'];
const svg = barChart({
  title: '权重消融实验：扣除单一特征后平均疲劳指数的变化',
  yLabel: '平均疲劳指数变化量（分）',
  items: items.map((it, i) => ({ label: it.label, value: it.deltaAvg, color: palette[i % palette.length] })),
  note: base
    ? `完整模型基线：平均 ${base[2]} 分，峰值 ${base[4]} 分，结论「${base[7]}」；负值=扣除后分数下降=该特征有贡献`
    : '负值=扣除后分数下降=该特征有贡献',
});

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, svg, 'utf8');
console.log(`✓ 消融贡献度图 → ${output}`);
for (const it of items) {
  console.log(`  ${it.label}: Δ均值=${it.deltaAvg.toFixed(2)} 分, Δ疲劳占比=${(it.deltaRatio * 100).toFixed(1)}pp`);
}
