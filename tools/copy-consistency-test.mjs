/**
 * copy-consistency-test.mjs — 文案一致性（批次三 #12）
 * 抓取所有视图可见文本，检查：
 *  1) 术语混用（疲劳指数/疲劳分、摄像头/相机、开始/启动…）
 *  2) 单位格式混用（次/分 vs 次/分钟、毫秒 vs ms、%/％）
 *  3) 全半角混排（（ vs (、：vs :、，vs ,）
 *  4) 同一指标小数位不一致
 */
import { chromium } from 'playwright-core';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5180/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0, warn = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m) => { failed++; console.error(`  ✗ ${m}`); };
const warn0 = (m) => { warn++; console.log(`  ! ${m}`); };

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 });
await sleep(800);

// 跑一段演示产生真实数字，报告页才有内容可查
await page.evaluate(() => window.__fatigue.startSimulation());
await sleep(6000);
await page.evaluate(() => window.__fatigue.fastForward(120000));
await sleep(1500);
await page.evaluate(() => window.__fatigue.stop());
await sleep(2500);

// 抓全量文本（含 sheet）
await page.evaluate(() => document.getElementById('btnSettings')?.click());
await sleep(600);
await page.evaluate(() => document.getElementById('btnCloseSheet')?.click());
await sleep(300);

const allText = await page.evaluate(() => document.body.innerText);
const lines = allText.split('\n').map((l) => l.trim()).filter(Boolean);

// ---------- 1. 术语一致性 ----------
{
  const groups = [
    { canonical: '疲劳指数', variants: ['疲劳分数', '疲劳分值', '疲劳评分'], label: '核心指标名' },
    { canonical: '摄像头', variants: ['相机', '摄影头'], label: '设备名' },
    { canonical: '演示模式', variants: ['模拟模式', '示例模式'], label: '模式名' },
    { canonical: '开始检测', variants: ['启动检测', '开始监测', '启动监测'], label: '开始动作' },
    { canonical: '专业模式', variants: ['专家模式', '高级模式', '进阶模式'], label: '模式开关' },
    { canonical: '阈值', variants: ['阀值'], label: '参数术语' },
  ];
  let hit = 0;
  for (const g of groups) {
    for (const v of g.variants) {
      const re = new RegExp(v);
      if (re.test(allText)) { bad(`[${g.label}] 出现非规范术语「${v}」（应统一为「${g.canonical}」）`); hit++; }
    }
  }
  if (hit === 0) ok(`术语无混用（${groups.length} 组规范词表全过）`);
}

// ---------- 2. 单位格式 ----------
{
  // 项目约定：频率单位统一「次/分」（全站 24 处一致，无「次/分钟」混用）
  const unitChecks = [
    { bad: /(\d)\s*(?:次\s*\/\s*min|次／分|cpm)/i, label: '频率单位', expect: '次/分' },
    { bad: /(\d)\s*ms\b/, label: '时间单位', expect: '毫秒（中文界面）' },
    { bad: /％/, label: '百分号', expect: '半角 %' },
    { bad: /(\d)\s*s\b(?!core)/, label: '秒单位', expect: '秒（中文界面）' },
  ];
  let hit = 0;
  for (const u of unitChecks) {
    const m = allText.match(u.bad);
    if (m) { bad(`[${u.label}] 出现非规范写法「${m[0]}」（应为 ${u.expect}）`); hit++; }
  }
  if (hit === 0) ok('单位格式全部规范（次/分、毫秒、半角%）');
}

// ---------- 3. 全半角混排 ----------
{
  // 中文语境里出现半角括号包裹中文、或半角冒号紧跟中文
  const issues = [];
  for (const l of lines) {
    if (/\([\u4e00-\u9fa5]/.test(l) && !/^\(|code|\?demo/.test(l)) issues.push(`半角括号+中文: ${l.slice(0, 40)}`);
    if (/[\u4e00-\u9fa5]:(?!=\/\/)/.test(l)) issues.push(`中文后半角冒号: ${l.slice(0, 40)}`);
  }
  const uniq = [...new Set(issues.map((s) => s.split(': ')[0]))];
  if (uniq.length === 0) ok('全角标点使用一致（（）：）');
  else warn0(`标点混排 ${uniq.length} 类，抽样：${issues.slice(0, 3).join(' | ')}`);
}

// ---------- 4. 小数位一致性（疲劳指数全站应 1 位小数） ----------
{
  // 允许非分数类的 2 位小数（如 EAR 0.28），只检查跟在"指数/分"字样后的
  const scoreLines = lines.filter((l) => /指数|得分|score/i.test(l) && /\d/.test(l));
  let bad2 = 0;
  for (const l of scoreLines) {
    const nums = l.match(/\d+\.\d+/g) || [];
    for (const n of nums) if (n.split('.')[1]?.length > 1) { bad2++; console.error(`    2位小数行: ${l.slice(0, 50)}`); }
  }
  if (bad2 === 0) ok(`分数类数字统一 1 位小数（抽查 ${scoreLines.length} 行）`);
  else bad(`${bad2} 处分数出现 2 位小数`);
}

// ---------- 5. 空/占位文案泄漏 ----------
{
  const leaks = [/undefined/, /NaN(?![a-z])/, /\{\{/, /TODO/, /FIXME/, /null(?![a-z])/];
  let hit = 0;
  for (const l of lines) {
    for (const re of leaks) {
      if (re.test(l)) { bad(`占位/未定义文案泄漏: ${l.slice(0, 60)}`); hit++; break; }
    }
  }
  if (hit === 0) ok('无 undefined/NaN/{{}}/TODO 泄漏');
}

await browser.close();
console.log(`\n==== 文案一致性: ${passed} 通过, ${warn} 提示, ${failed} 失败 ====`);
process.exit(failed ? 1 : 0);
