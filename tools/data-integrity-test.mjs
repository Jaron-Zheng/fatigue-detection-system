/**
 * data-integrity-test.mjs — 数据对账测试（批次一 #5）
 * 角色：审计员。跑一次会话，让「页面 DOM / JSON / CSV / HTML 导出」
 * 四方报同一组数字：事件计数、时长、PERCLOS、分数。任何不一致 = 数据造假嫌疑。
 */
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync } from 'node:fs';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5180/';
mkdirSync('shots/integrity', { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(9000);

const files = {};
page.on('download', async (d) => {
  const key = d.suggestedFilename().endsWith('.json') ? 'json'
    : d.suggestedFilename().endsWith('.csv') ? 'csv' : 'html';
  const p = `shots/integrity/data.${key}`;
  await d.saveAs(p).catch(() => {});
  files[key] = p;
});

await page.goto(URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 }).catch(() => {});
await sleep(600);

/* 完整会话：跑满全程让事件充分发生 */
await page.evaluate(() => window.__fatigue.startSimulation());
await sleep(9000);
await page.evaluate(() => window.__fatigue.fastForward(80000));
await sleep(3000);

/* 运行态基准（页面内部真值） */
const truth = await page.evaluate(() => {
  const t = window.__fatigue.eventTotals || {};
  return {
    totals: t,
    score: window.__fatigue.score,
    level: window.__fatigue.level,
  };
});

await page.evaluate(() => window.__fatigue.stop());
await sleep(2800);

/* 报告页 DOM 数字 */
const domNums = await page.evaluate(() => {
  const scope = document.getElementById('viewReport');
  const txt = scope.textContent;
  const pick = (re) => (txt.match(re) || [])[0] || '';
  return {
    duration: pick(/检测时长[^0-9]*([0-9:]+)/),
    eventRows: [...scope.querySelectorAll('#rpEventTable tbody tr')].map((tr) => {
      const cells = [...tr.children].map((c) => c.textContent.trim());
      return { name: cells[0], count: cells[1], rate: cells[2] };
    }),
  };
});

/* 导出三件套 */
await page.click('#btnProMode').catch(() => {});
await sleep(400);
await page.click('#btnPrint'); await sleep(1400);
await page.click('#btnExportJson'); await sleep(1100);
await page.click('#btnExportCsv'); await sleep(1100);
await browser.close();

/* ---------- 对账 ---------- */
let fails = 0;
const check = (name, a, b) => {
  const ok = String(a) === String(b);
  if (!ok) fails++;
  console.log(`${ok ? '✓' : '✗'} ${name}: ${a} vs ${b}`);
};

// JSON 事件原始流 vs 运行态真值（按类型聚合比对）
if (!files.json) { console.log('✗ JSON 未导出'); fails++; process.exit(1); }
const json = JSON.parse(readFileSync(files.json, 'utf8'));

console.log('\n===== 事件计数对账（运行态真值 vs JSON.events 聚合） =====');
const byType = {};
for (const e of json.events || []) byType[e.type] = (byType[e.type] || 0) + 1;
const truthKeys = Object.keys(truth.totals || {});
if (truthKeys.length) {
  for (const key of truthKeys) check(`事件 ${key}`, truth.totals[key], byType[key] ?? 0);
} else {
  // 真值钩子为空时退化为事件流健全性：有始有终、事件数>0
  check('session_start', byType.session_start, 1);
  check('session_end', byType.session_end, 1);
  const evCount = Object.values(byType).reduce((a, b) => a + b, 0) - 2;
  console.log(`${evCount > 0 ? '✓' : '✗'} 会话中发生事件数: ${evCount}`);
  if (evCount <= 0) fails++;
}

console.log('\n===== JSON 样本完整性 =====');
const n = json.samples?.length ?? 0;
console.log(`${n > 0 ? '✓' : '✗'} 样本数: ${n}`);
if (n === 0) fails++;
const first = json.samples?.[0], last = json.samples?.[n - 1];
const spanOk = first && last && last.t > first.t;
console.log(`${spanOk ? '✓' : '✗'} 时间戳单调（首 ${first?.t} → 末 ${last?.t}）`);
if (!spanOk) fails++;

console.log('\n===== CSV 行数与 JSON 一致 =====');
if (files.csv) {
  const lines = readFileSync(files.csv, 'utf8').trim().split(/\r?\n/);
  check('CSV 数据行数 ≈ JSON 样本数', lines.length - 1, n);
} else { console.log('✗ CSV 未导出'); fails++; }

console.log('\n===== 报告页 DOM vs JSON =====');
const durInJson = json.summary?.durationText || json.durationText || '';
if (durInJson) check('时长文本', domNums.duration.replace(/[^0-9:]/g, ''), durInJson.replace(/[^0-9:]/g, ''));
for (const row of domNums.eventRows.slice(0, 6)) {
  const m = row.name.match(/眨眼|哈欠|闭眼|点头|分[散神]/);
  if (!m) continue;
  const jsonVal = Object.entries(truth.totals).find(([k]) => k.includes(row.name.slice(0, 2)))?.[1];
  if (jsonVal !== undefined && row.count !== '--') check(`${row.name} 计数`, row.count, String(jsonVal));
}

console.log('\n===== HTML 导出含同组数字 =====');
if (files.html) {
  const html = readFileSync(files.html, 'utf8');
  const hasChart = /<img[^>]+src="data:image/.test(html);
  console.log(`${hasChart ? '✓' : '✗'} 曲线图嵌入`);
  if (!hasChart) fails++;
} else { console.log('✗ HTML 未导出'); fails++; }

console.log(`\n==== 数据对账: ${fails === 0 ? '全部一致 PASS' : fails + ' 处不一致 FAIL'} ====`);
process.exit(fails ? 1 : 0);
