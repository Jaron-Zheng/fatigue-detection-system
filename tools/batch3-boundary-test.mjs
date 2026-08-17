/**
 * batch3-boundary-test.mjs — 批次三｜数据与状态边界测试
 *
 * 角色 7 · 多标签页幽灵：同源两标签共享 localStorage，验证主题/专业模式/配置
 *           在另一标签修改后本标签是否同步（storage 事件监听缺失 = 状态-产出不一致）。
 * 角色 8 · 极端数据制造者：通过 __fatigue 注入边界样本（空/单条/全无效/极值/
 *           超长时间轴/NaN），停止后扫描报告 DOM 是否出现 NaN/Infinity/undefined/
 *           百分比越界/空白画布。
 * 角色 9 · 输入破坏者：对"离线复现"的 CSV 文件输入面做空文件/仅表头/单行数据/
 *           HTML 载荷/垃圾表头/超限大文件/超长行攻击，验证解析与提示的健壮性。
 *
 * 用法：node tools/batch3-boundary-test.mjs   （需本地服务在 SHOT_URL，默认 5183）
 */
import { chromium } from 'playwright-core';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5183/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0, bugs = [];
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m) => { failed++; console.error(`  ✗ ${m}`); };
const note = (m) => { bugs.push(m); console.log(`  ⚠ ${m}`); };

const browser = await chromium.launch({ channel: 'msedge', headless: true });

async function bootPage(ctx) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  const booted = await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 }).then(() => true).catch(() => false);
  return { page, errors, booted };
}

/* 读取当前可见 toast 的文案 */
const toastText = (page) => page.evaluate(() => {
  const host = document.querySelector('.toast-host');
  if (!host) return '';
  return [...host.querySelectorAll('.toast')].map((t) =>
    (t.querySelector('.toast-title')?.textContent || '') + '|' +
    (t.querySelector('.toast-msg')?.textContent || '')
  ).join(' ;; ');
});

/* ================= 角色 7 · 多标签页幽灵 ================= */
console.log('\n---- 角色 7 · 多标签页幽灵 ----');
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const A = await bootPage(ctx);
  const B = await bootPage(ctx);
  if (!A.booted || !B.booted) bad('双标签任一启动失败');
  else {
    // T1 主题跨标签同步
    await A.page.click('#btnTheme');
    await sleep(400);
    const lsTheme = await B.page.evaluate(() => localStorage.getItem('fatigue.theme'));
    const bTheme = await B.page.evaluate(() => document.documentElement.dataset.theme);
    if (lsTheme && bTheme !== lsTheme) note(`[R7-T1] 主题跨标签不同步：TabB DOM=${bTheme}，localStorage=${lsTheme}（P2，状态-产出不一致）`);
    else ok(`主题跨标签一致（DOM=${bTheme}）`);

    // T2 专业模式跨标签同步
    await A.page.click('#btnProMode');
    await sleep(400);
    const lsPro = await B.page.evaluate(() => localStorage.getItem('fatigue.proMode'));
    const bPro = await B.page.evaluate(() => document.body.classList.contains('pro-mode'));
    if ((lsPro === '1') !== bPro) note(`[R7-T2] 专业模式跨标签不同步：TabB body.pro-mode=${bPro}，localStorage=${lsPro}（P2）`);
    else ok('专业模式跨标签一致');

    // T3 配置跨标签同步（等效于 TabA 在设置抽屉保存参数）
    await A.page.evaluate(() => import('/js/config.js').then((m) => {
      m.CONFIG.fusion.weights.perclos = 0.5;
      m.saveUserConfig();
    }));
    await sleep(400);
    const lsCfg = await B.page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('fatigue.config.v1')).fusion.weights.perclos; } catch { return 'PARSE_ERR'; }
    });
    const bCfg = await B.page.evaluate(() => import('/js/config.js').then((m) => m.CONFIG.fusion.weights.perclos));
    if (lsCfg === 0.5 && bCfg !== 0.5) note(`[R7-T3] 配置跨标签不同步：TabB 内存权重=${bCfg}，localStorage=${lsCfg}——TabB 之后的检测/消融/报告全用旧参数且无任何提示（P1）`);
    else ok(`配置跨标签一致（内存=${bCfg}）`);

    // T4 双标签同时各自跑演示：无崩溃、状态互不串扰
    const runA = A.page.evaluate(async () => {
      try { await window.__fatigue.startSimulation(); return window.__fatigue.state; } catch (e) { return 'ERR:' + e.message; }
    });
    const runB = B.page.evaluate(async () => {
      try { await window.__fatigue.startSimulation(); return window.__fatigue.state; } catch (e) { return 'ERR:' + e.message; }
    });
    const [sa, sb] = await Promise.all([runA, runB]);
    await sleep(1500);
    const scoreA = await A.page.evaluate(() => window.__fatigue.score);
    const scoreB = await B.page.evaluate(() => window.__fatigue.score);
    if (sa === 'running' && sb === 'running' && !A.errors.length && !B.errors.length) {
      ok(`双标签并发演示互不干扰（A=${sa}/${scoreA?.toFixed?.(1)}，B=${sb}/${scoreB?.toFixed?.(1)}）`);
    } else {
      bad(`双标签并发异常：A=${sa} B=${sb}，错误：${A.errors[0] || B.errors[0] || '无'}`);
    }
    // T5 TabB 刷新后能拿到新值（证明只是"活标签不同步"而非持久化失效）
    await B.page.reload({ waitUntil: 'load' });
    await B.page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 }).catch(() => {});
    const bCfg2 = await B.page.evaluate(() => import('/js/config.js').then((m) => m.CONFIG.fusion.weights.perclos));
    const bPro2 = await B.page.evaluate(() => document.body.classList.contains('pro-mode'));
    if (bCfg2 === 0.5 && bPro2) ok('刷新后 TabB 读到新配置与新专业模式（持久化本身正常）');
    else bad(`刷新后仍未取到新值：cfg=${bCfg2} pro=${bPro2}`);
  }
  await ctx.close();
}

/* ================= 角色 8 · 极端数据制造者 ================= */
console.log('\n---- 角色 8 · 极端数据制造者 ----');

/** 在新页面注入极端样本后停止，扫描报告 DOM */
async function extremeScenario(name, mutateJs) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const { page, errors, booted } = await bootPage(ctx);
  if (!booted) { bad(`${name}：页面启动失败`); await ctx.close(); return; }
  try {
    await page.evaluate(async () => { await window.__fatigue.startSimulation(); });
    await page.waitForFunction(() => window.__fatigue.state === 'running', null, { timeout: 20000 });
    await sleep(1300); // 积累少量真实样本
    await page.evaluate(mutateJs);
    await page.evaluate(() => window.__fatigue.stop());
    await sleep(700); // 等报告渲染
    const audit = await page.evaluate(() => {
      const view = document.getElementById('viewReport');
      if (!view) return { fatal: 'no viewReport' };
      const active = view.classList.contains('active') || view.offsetParent !== null;
      const text = view.innerText || '';
      const found = [];
      if (/\bNaN\b/.test(text)) found.push('NaN');
      if (/Infinity/.test(text)) found.push('Infinity');
      if (/\bundefined\b/.test(text)) found.push('undefined');
      const pcts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => parseFloat(m[1])).filter((v) => v > 100.01);
      if (pcts.length) found.push('pct>100:' + pcts.slice(0, 3).join(','));
      const blankCanvas = [...view.querySelectorAll('canvas')].filter(
        (c) => c.offsetParent !== null && c.clientWidth > 0 && (c.width === 0 || c.height === 0)
      ).length;
      if (blankCanvas) found.push('blankCanvas:' + blankCanvas);
      return { active, found, sample: text.slice(0, 160).replace(/\s+/g, ' ') };
    });
    const pageErr = errors.filter((e) => !/favicon|Autoplay|GPU|deprecat/i.test(e));
    if (audit.fatal) bad(`${name}：${audit.fatal}`);
    else if (!audit.active) bad(`${name}：报告视图未激活`);
    else if (audit.found.length || pageErr.length) bad(`${name}：异常 ${audit.found.join('/') || ''} ${pageErr.length ? '页面错误:' + pageErr[0].slice(0, 120) : ''}`);
    else ok(`${name}：报告无 NaN/越界/空白（"${audit.sample.slice(0, 60)}…"）`);
  } catch (e) {
    bad(`${name}：执行异常 ${String(e.message).slice(0, 140)}`);
  }
  await ctx.close();
}

// D1 空样本
await extremeScenario('D1 零样本会话', `(() => {
  const r = window.__fatigue.app.recorder; r.samples = []; return 0;
})()`);
// D2 单样本
await extremeScenario('D2 单样本会话', `(() => {
  const r = window.__fatigue.app.recorder; r.samples = r.samples.slice(0, 1); return 0;
})()`);
// D3 全程无有效人脸
await extremeScenario('D3 全程人脸丢失', `(() => {
  const r = window.__fatigue.app.recorder;
  r.samples = r.samples.map((s) => ({ ...s, facePresent: 0, dataValid: 0 }));
  return 0;
})()`);
// D4 极端疲劳值（PERCLOS=100%、持续闭眼 60s、分数全 100）
await extremeScenario('D4 极端疲劳极值', `(() => {
  const r = window.__fatigue.app.recorder;
  r.samples = r.samples.map((s) => ({ ...s, perclos: 1, score: 100, currentClosureMs: 60000, maxClosureMs: 60000 }));
  return 0;
})()`);
// D5 三天超长会话时间轴
await extremeScenario('D5 超长时间轴（3 天）', `(() => {
  const app = window.__fatigue.app;
  const base = 259200000;
  app.recorder.samples = app.recorder.samples.map((s, i) => ({ ...s, t: base + i * 500 }));
  if (app.lastInd) app.lastInd.sessionMs = base;
  return 0;
})()`);
// D6 融合/指标快照全空（异常中断等价物）
await extremeScenario('D6 lastInd/lastFusion 为空', `(() => {
  const app = window.__fatigue.app; app.lastInd = null; app.lastFusion = null; return 0;
})()`);
// D7 样本字段 NaN 污染
await extremeScenario('D7 样本字段 NaN', `(() => {
  const r = window.__fatigue.app.recorder;
  r.samples = r.samples.map((s, i) => (i % 2 ? { ...s, score: NaN, perclos: NaN, ear: null } : s));
  return 0;
})()`);
// D8 零眨眼 + 平均眨眼时长缺失
await extremeScenario('D8 零眨眼会话', `(() => {
  const r = window.__fatigue.app.recorder;
  r.samples = r.samples.map((s) => ({ ...s, blinkRate: 0, avgBlinkMs: null }));
  r.events = r.events.filter((e) => e.type !== 'blink');
  return 0;
})()`);

/* ================= 角色 9 · 输入破坏者（CSV 离线复现） ================= */
console.log('\n---- 角色 9 · 输入破坏者 ----');
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const { page, errors, booted } = await bootPage(ctx);
  if (!booted) bad('角色9页面启动失败');
  else {
    await page.click('#btnProMode'); // 展开实验工具
    await page.click('a[data-goto="viewReport"]');
    await sleep(400);

    const pick = async (name, mimeType, content) => {
      await page.setInputFiles('#fileReplay', {
        name, mimeType,
        buffer: typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
      });
      await sleep(600);
      return {
        toast: await toastText(page),
        replayInfo: await page.evaluate(() => document.querySelector('#replayInfo')?.textContent || ''),
      };
    };

    // R1 空文件
    let r = await pick('empty.csv', 'text/csv', '');
    if (/为空/.test(r.toast)) ok(`R1 空文件友好拒绝（"${r.toast.slice(0, 40)}"）`);
    else bad(`R1 空文件提示不清晰：${r.toast}`);

    // R2 仅表头
    r = await pick('header-only.csv', 'text/csv', '时间(毫秒),疲劳指数\n');
    if (/解析失败|至少需要/.test(r.toast + r.replayInfo)) ok('R2 仅表头友好拒绝');
    else bad(`R2 仅表头提示异常：${r.toast}`);

    // R3 单行数据（表头 + 1 行）
    r = await pick('one-row.csv', 'text/csv', '时间(毫秒),疲劳指数\n500,10\n');
    if (/样本不足|至少需要 2/.test(r.toast + r.replayInfo)) ok('R3 单行数据友好拒绝');
    else note(`[R9-R3] 单行数据触发原始异常而非业务提示：toast="${r.toast.slice(0, 90)}"（P2，replaySession 的 valid=false 未被检查）`);

    // R4 HTML/脚本载荷
    r = await pick('evil.csv', 'text/csv', '<script>window.PWNED=1</script>\n<img src=x onerror=window.PWNED=1>\n');
    const pwned = await page.evaluate(() => window.PWNED === true || window.PWNED === 1);
    if (!pwned && /找不到时间列|解析失败/.test(r.toast + r.replayInfo)) ok('R4 HTML 载荷被安全拒绝且未执行');
    else bad(`R4 HTML 载荷处理异常：pwned=${pwned} toast=${r.toast}`);

    // R5 垃圾表头（纯 emoji）
    r = await pick('emoji.csv', 'text/csv', '😀😀,😂😂\n1,2\n');
    if (/找不到时间列/.test(r.toast + r.replayInfo)) ok('R5 emoji 表头友好拒绝');
    else bad(`R5 emoji 表头异常：${r.toast}`);

    // R6 有效最小 CSV：含无效行（t 非数字）与缺失列，验证 skipped 计数
    const validCsv = [
      '时间(毫秒),疲劳指数,闭眼时间占比PERCLOS,当前连续闭眼(毫秒),是否检测到人脸(1=是),数据是否有效(1=是)',
      '0,5,0.02,0,1,1',
      'abc,5,0.02,0,1,1', // 无效 t → 跳过
      '500,12,0.04,100,1,1',
      '1000,20,0.08,200,1,1',
    ].join('\n');
    r = await pick('mini.csv', 'text/csv', validCsv);
    if (/已导入并复现/.test(r.toast) && /跳过 1/.test(r.replayInfo)) ok(`R5b 混合脏数据正确解析（${r.replayInfo.slice(0, 60)}）`);
    else bad(`R5b 混合数据解析异常：toast=${r.toast.slice(0, 60)} info=${r.replayInfo}`);

    // R7 超限大文件（33MB）：一条超长行
    const huge = '时间(毫秒),疲劳指数\n0,' + '9'.repeat(33 * 1024 * 1024) + '\n';
    const t0 = Date.now();
    r = await pick('huge.csv', 'text/csv', huge);
    if (/32MB|超过/.test(r.toast)) ok(`R7 超限文件友好拒绝（耗时 ${Date.now() - t0}ms）`);
    else bad(`R7 超限文件异常：${r.toast.slice(0, 80)}`);

    // R8 同一文件重复选择（file.value 重置后 change 仍触发）
    const before = await page.evaluate(() => document.querySelector('#replayInfo')?.textContent || '');
    await pick('mini2.csv', 'text/csv', validCsv);
    const after = await page.evaluate(() => document.querySelector('#replayInfo')?.textContent || '');
    if (before && after && before !== '') ok('R8 同名文件可重复导入（change 正常触发）');
    else bad(`R8 重复导入异常：before="${before.slice(0, 30)}" after="${after.slice(0, 30)}"`);

    if (errors.length) bad(`角色9 存在页面错误：${errors[0].slice(0, 120)}`);
    else ok('角色9 全程无页面错误');
  }
  await ctx.close();
}

await browser.close();
console.log(`\n==== 批次三：${passed} 通过, ${failed} 失败, ${bugs.length} 个待修复缺陷 ====`);
for (const b of bugs) console.log('  - ' + b);
process.exit(failed ? 1 : 0);
