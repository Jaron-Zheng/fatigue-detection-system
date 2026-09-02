#!/usr/bin/env node
/**
 * confusion-chart.mjs — 视频评测指标汇总 CSV → 混淆矩阵热力图 + 指标表
 *
 * 用法：node tools/analysis/confusion-chart.mjs <指标汇总CSV> [输出.svg]
 * 输入支持两种格式（行名模糊匹配，自动兼容）：
 *   ① 工作台"视频评测"导出的指标汇总 CSV（默认 fixtures/eval-metrics-demo.csv）
 *   ② node tools/accuracy-eval.mjs 生成的 figures/accuracy-summary.csv（论文口径）
 * 默认输出 docs-evidence/figures/混淆矩阵.svg
 *
 * 论文位置：实验结果章"系统检出效果"一节。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, confusionChart, num } from './svg-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const input = process.argv[2] || path.join(__dirname, 'fixtures/eval-metrics-demo.csv');
const output = process.argv[3] || path.join(ROOT, 'docs-evidence/figures/混淆矩阵.svg');

const rows = parseCsv(fs.readFileSync(input, 'utf8'));
const header = rows[0];
if (header[0] !== '指标') {
  console.error(`✗ ${input} 不是"视频评测指标汇总 CSV"（首列应为"指标"）`);
  process.exit(1);
}

/**
 * 行名模糊匹配：同时兼容两种导出的行名差异——
 * 工作台导出（"真阳例 TP（时间列为毫秒）"/"灵敏度/召回率 Sensitivity"/"马修斯相关系数 MCC"）
 * 与 accuracy-eval 汇总（"TP（时间列为毫秒）"/"灵敏度 Sensitivity"/"MCC"）。
 * 规则：行名包含全部 token 即命中。
 */
const find = (tokens, colIdx) => {
  const list = Array.isArray(tokens) ? tokens : [tokens];
  const r = rows.find((x) => list.every((t) => x[0].includes(t)));
  return r ? num(r[colIdx]) : NaN;
};

// 混淆矩阵四格：取"按采样点计数"列（与文献对照口径）
const tp = find(['TP', '时间列为毫秒'], 2);
const tn = find(['TN', '时间列为毫秒'], 2);
const fp = find(['FP', '时间列为毫秒'], 2);
const fn = find(['FN', '时间列为毫秒'], 2);
if ([tp, tn, fp, fn].some((v) => !Number.isFinite(v))) {
  console.error('✗ 汇总 CSV 中缺少 TP/TN/FP/FN 行，无法绘制混淆矩阵');
  process.exit(1);
}

const pct = (v) => (Number.isFinite(v) ? (v * 100).toFixed(1) + '%' : '--');
const numStr = (v) => (Number.isFinite(v) ? v.toFixed(3) : '--');
const metrics = [
  ['准确率 Accuracy', pct(find('准确率', 2))],
  ['灵敏度 Sensitivity', pct(find('灵敏度', 2))],
  ['特异度 Specificity', pct(find('特异度', 2))],
  ['查准率 Precision', pct(find('精确率', 2))],
  ['平衡准确率 Balanced Acc.', pct(find('平衡准确率', 2))],
  ['F1 分数', numStr(find('F1', 2))],
  ["Youden's J", numStr(find('Youden', 2))],
  ['MCC', numStr(find('MCC', 2))],
  ['漏报率 FNR', pct(find('FNR', 2))],
  ['误报率 FPR', pct(find('FPR', 2))],
];

const svg = confusionChart({
  title: '疲劳检出混淆矩阵与评价指标（按采样点计数）',
  matrix: { tp, tn, fp, fn },
  metrics,
  note: '二分类口径：轻度及以上等级判为"疲劳"；指标值取"按采样点计数"列',
});

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, svg, 'utf8');
console.log(`✓ 混淆矩阵图 → ${output}`);
console.log(`  TP=${tp} TN=${tn} FP=${fp} FN=${fn}`);
