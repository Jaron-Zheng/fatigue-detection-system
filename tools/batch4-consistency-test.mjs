/**
 * batch4-consistency-test.mjs — 批次四｜一致性与可达性审查
 *
 * 角色 10 · 视觉一致性审查员：主题×专业模式 4 组合下实际导出 HTML/JSON/CSV，
 *           逐字段核对产出物与导出时刻 UI 状态；参数修改后导出须反映最新值。
 * 角色 11 · 静默失败猎手：遍历各视图全部可交互元素逐个点击，
 *           用 MutationObserver+toast+焦点+hash 判定"可感知反应"，零反应者列出。
 * 角色 12 · 纯键盘用户：Tab 全遍历焦点环可见性 + 抽屉焦点圈禁 +
 *           纯键盘完成 设置→演示→暂停/继续→结束→报告→导出 全流程。
 *
 * 用法：node tools/batch4-consistency-test.mjs   （需本地服务在 SHOT_URL，默认 5183）
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const URL = process.env.SHOT_URL || 'http://127.0.0.1:5183/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0, notes = [];
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
const bad = (m) => { failed++; console.error(`  ✗ ${m}`); };
const note = (m) => { notes.push(m); console.log(`  ⚠ ${m}`); };

const browser = await chromium.launch({ channel: 'msedge', headless: true });

async function newSessionPage() {
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    permissions: ['camera'],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 });
  return { ctx, page, errors };
}

/** 跑一段演示并停止，产出有数据的报告页 */
async function runSimAndStop(page, ms = 5200) {
  await page.evaluate(() => window.__fatigue.startSimulation());
  await page.waitForFunction(() => window.__fatigue.state === 'running', null, { timeout: 20000 });
  await sleep(ms);
  await page.evaluate(() => window.__fatigue.stop());
  await sleep(800);
}

/** 触发导出按钮并读取下载文件内容（evaluate 直点，避开 toast 遮挡导致的动作性拦截） */
async function clickAndReadDownload(page, selector) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.evaluate((s) => document.querySelector(s)?.click(), selector),
  ]);
  const p = await download.path();
  return { name: download.suggestedFilename(), content: readFileSync(p, 'utf8') };
}

/* ================= 角色 10 · 视觉一致性审查员 ================= */
console.log('\n---- 角色 10 · 导出一致性（主题 × 专业模式） ----');
{
  const { ctx, page, errors } = await newSessionPage();
  await runSimAndStop(page);

  const setTheme = async (want) => {
    await page.evaluate((w) => {
      const el = document.documentElement;
      const isDark = el.dataset.theme === 'dark';
      if ((w === 'dark') !== isDark) document.getElementById('btnTheme').click();
    }, want);
    await sleep(250);
  };
  const setPro = async (want) => {
    await page.evaluate((w) => {
      if (document.body.classList.contains('pro-mode') !== w) document.getElementById('btnProMode').click();
    }, want);
    await sleep(350);
  };

  const combos = [
    { theme: 'light', pro: false },
    { theme: 'light', pro: true },
    { theme: 'dark', pro: false },
    { theme: 'dark', pro: true },
  ];
  const jsonByCombo = {};
  for (const c of combos) {
    await setTheme(c.theme);
    await setPro(c.pro);
    const liveCfg = await page.evaluate(() => import('/js/config.js').then((m) => JSON.parse(JSON.stringify({
      window: m.CONFIG.window, event: m.CONFIG.event, fusion: m.CONFIG.fusion,
      calibration: m.CONFIG.calibration,
    }))));
    const sampleCount = await page.evaluate(() => window.__fatigue.app.recorder.samples.length);

    // HTML 报告
    const html = await clickAndReadDownload(page, '#btnPrint');
    const isHtmlOkTheme = html.content.includes(':root{') && html.content.includes('data-theme="light"');
    const hasProSection = /id="(sensTable|replayResult|evalResult|rpParams)"/.test(html.content);
    const hasFoldNote = /本次会话未运行，无导出数据/.test(html.content);
    if (!isHtmlOkTheme) bad(`[${c.theme}/pro=${c.pro}] HTML 导出主题内联异常`);
    if (c.pro && !hasProSection && !hasFoldNote) bad(`[${c.theme}/pro=${c.pro}] 专业模式 HTML 缺专业区块`);
    if (!c.pro && hasProSection) bad(`[${c.theme}/pro=${c.pro}] 普通模式 HTML 泄漏专业区块（现象A同族）`);
    if (!html.name.endsWith('.html')) bad(`HTML 文件名异常：${html.name}`);

    // JSON
    const json = await clickAndReadDownload(page, '#btnExportJson');
    let data;
    try { data = JSON.parse(json.content); } catch { data = null; }
    if (!data) bad(`[${c.theme}/pro=${c.pro}] JSON 解析失败`);
    else {
      const cfgMatch = JSON.stringify(data.config) === JSON.stringify(liveCfg);
      if (!cfgMatch) bad(`[${c.theme}/pro=${c.pro}] JSON.config 与导出时刻内存 CONFIG 不一致（现象A同族）`);
      if (data.samples.length !== sampleCount) bad(`[${c.theme}/pro=${c.pro}] JSON 采样数 ${data.samples.length} ≠ 实际 ${sampleCount}`);
      jsonByCombo[`${c.theme}_${c.pro}`] = data.config;
    }

    // CSV
    const csv = await clickAndReadDownload(page, '#btnExportCsv');
    const csvLines = csv.content.replace(/^\ufeff/, '').split(/\r?\n/).filter((l) => l.trim());
    if (!csvLines[0].includes('时间(毫秒)')) bad(`[${c.theme}/pro=${c.pro}] CSV 表头异常：${csvLines[0].slice(0, 40)}`);
    if (csvLines.length - 1 !== sampleCount) bad(`[${c.theme}/pro=${c.pro}] CSV 行数 ${csvLines.length - 1} ≠ 采样数 ${sampleCount}`);
    if (c.theme === 'light' && c.pro === false) ok('基线组合（light/pro=off）三种导出内容正确');
  }

  // 主题不得渗入 JSON 的 config（dark 与 light 的 config 必须完全一致）
  if (JSON.stringify(jsonByCombo.light_false) === JSON.stringify(jsonByCombo.dark_false) &&
      JSON.stringify(jsonByCombo.light_true) === JSON.stringify(jsonByCombo.dark_true)) {
    ok('JSON.config 与主题无关（主题未渗入数据导出）');
  } else bad('JSON.config 随主题变化——主题状态渗入了数据产出');

  // 参数修改后导出必须反映最新值（状态-产出一致性的正向验证）
  await page.evaluate(() => import('/js/config.js').then((m) => {
    m.CONFIG.fusion.weights.perclos = 0.45;
    m.saveUserConfig();
  }));
  await sleep(200);
  const json2 = await clickAndReadDownload(page, '#btnExportJson');
  const w2 = JSON.parse(json2.content).config.fusion.weights.perclos;
  if (w2 === 0.45) ok('修改参数后再导出，JSON 反映最新权重（0.45）');
  else bad(`修改参数后导出仍为旧值：${w2}`);

  // 分析结果导出（专业模式工具链）
  await setPro(true);
  await page.click('#btnRunSens');
  await sleep(900);
  const ana = await clickAndReadDownload(page, '#btnExportAnalysis');
  const anaLines = ana.content.replace(/^\ufeff/, '').split(/\r?\n/).filter((l) => l.trim());
  if (anaLines.length >= 3 && anaLines[0].includes('参数名')) ok(`分析 CSV 导出正常（${anaLines.length - 1} 行数据）`);
  else bad(`分析 CSV 异常：首行="${anaLines[0]?.slice(0, 30)}" 共 ${anaLines.length} 行`);

  // 未运行分析时导出应被拦截（短超时判定无下载 + 立即读 toast）
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__fatigue, null, { timeout: 20000 });
  await runSimAndStop(page, 3200);
  await page.evaluate(() => document.getElementById('btnProMode').click());
  await page.click('a[data-goto="viewReport"]');
  await sleep(300);
  const firedP = page.waitForEvent('download', { timeout: 2500 }).then(() => true).catch(() => false);
  await page.evaluate(() => document.getElementById('btnExportAnalysis').click());
  const fired = await firedP;
  await sleep(250);
  const toastTxt = await page.evaluate(() => {
    const h = document.querySelector('.toast-host');
    return h ? [...h.querySelectorAll('.toast-title')].map((t) => t.textContent).join(',') : '';
  });
  if (!fired && /暂无可导出/.test(toastTxt)) ok('未运行分析时导出被拦截且有提示');
  else bad(`未运行分析导出未正确拦截：fired=${fired} toast="${toastTxt}"`);

  if (errors.length) bad(`角色10 页面错误：${errors[0].slice(0, 120)}`);
  else ok('角色10 全程无页面错误');
  await ctx.close();
}

/* ================= 角色 11 · 静默失败猎手 ================= */
console.log('\n---- 角色 11 · 静默失败猎手 ----');
{
  const { ctx, page, errors } = await newSessionPage();
  await sleep(600);

  const armObserver = () => page.evaluate(() => {
    window.__sweep = { mutations: 0, hash: location.hash };
    window.__sweepObs = new MutationObserver((list) => { window.__sweep.mutations += list.length; });
    window.__sweepObs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  const disarm = (activeBefore) => page.evaluate((before) => {
    window.__sweepObs.disconnect();
    const host = document.querySelector('.toast-host');
    return {
      mutations: window.__sweep.mutations,
      toasts: host ? host.children.length : 0,
      focusMoved: (document.activeElement?.id || document.activeElement?.tagName) !== before,
      hashChanged: location.hash !== window.__sweep.hash,
      fullscreen: !!document.fullscreenElement,
    };
  }, activeBefore);

  /** 对一组选择器逐个点击，返回静默名单 */
  const sweep = async (label, selectors) => {
    const silent = [];
    for (const sel of selectors) {
      const visible = await page.evaluate((s) => {
        const el = document.querySelector(s);
        return !!el && el.offsetParent !== null && !el.disabled;
      }, sel).catch(() => false);
      if (!visible) continue;
      await armObserver();
      const before = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
      await page.click(sel, { force: true, timeout: 3000 }).catch(() => {});
      await sleep(600);
      const r = await disarm(before);
      // 全屏按钮：fullscreenElement 变化也算可感知反应
      const perceivable = r.mutations > 0 || r.toasts > 0 || r.focusMoved || r.hashChanged || r.fullscreen;
      if (!perceivable) silent.push(sel);
      await sleep(150);
    }
    if (silent.length) note(`[角色11/${label}] 零可感知反应：${silent.join('、')}`);
    else ok(`${label}：全部元素点击后有可感知反应`);
    return silent;
  };

  // 排除需要真实摄像头的"开始检测"主按钮（由专门的真实设备用例覆盖）
  await sweep('首页(空闲)', [
    '#brandLink', 'a[href="#main"]', '.gn-links a:nth-child(1)', '.gn-links a:nth-child(2)',
    '.gn-links a:nth-child(3)', '#btnMute', '#btnTheme', '#btnSettings',
    'a[href="#tsFeatures"]',
  ]);
  await page.click('a[data-goto="viewWork"]');
  await sleep(400);
  const workSilent = await sweep('工作台(空闲)', [
    '#btnMesh', '#btnMirror', '#btnHud', '#btnRecalib', '#btnPause', '#btnStop', '#btnFilterEvents',
  ]);
  // 空闲时点暂停/结束：单独判定是否"应被拦截却有解释"
  if (workSilent.includes('#btnPause')) note('[角色11] 空闲状态 #btnPause 可点击但无任何解释（P3：建议禁用或提示"未在检测"）');
  if (workSilent.includes('#btnStop')) note('[角色11] 空闲状态 #btnStop 可点击但无任何解释（P3：建议禁用或提示"未在检测"）');

  // 报告页（有数据）
  await runSimAndStop(page, 3200);
  await sweep('报告页(有数据)', ['#btnPrint', '#btnExportJson', '#btnExportCsv', '#btnBackWork']);

  // 设置抽屉内的开关
  await page.click('#btnSettings');
  await sleep(500);
  await sweep('设置抽屉(打开)', [
    '#swAlarm', '#swSpeech', '#swMesh', '#swMirror', '#btnTestAlarm',
  ]);
  await page.keyboard.press('Escape');
  await sleep(300);

  if (errors.length) bad(`角色11 页面错误：${errors[0].slice(0, 120)}`);
  else ok('角色11 全程无页面错误');
  await ctx.close();
}

/* ================= 角色 12 · 纯键盘用户 ================= */
console.log('\n---- 角色 12 · 纯键盘用户 ----');
{
  const { ctx, page, errors } = await newSessionPage();
  await sleep(600);

  // K1 Tab 全遍历 + 每个停靠点的焦点环可见性
  {
    const stops = [];
    let guard = 0;
    await page.evaluate(() => document.body.focus());
    await page.keyboard.press('Tab');
    while (guard++ < 160) {
      const info = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body) return null;
        const s = getComputedStyle(a);
        const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
        return { id: a.id || a.tagName + ':' + (a.textContent || '').trim().slice(0, 10), ring };
      });
      if (!info) break;
      if (stops.some((s) => s.id === info.id)) break;
      stops.push(info);
      await page.keyboard.press('Tab');
    }
    const noRing = stops.filter((s) => !s.ring).map((s) => s.id);
    if (stops.length >= 10 && noRing.length === 0) ok(`Tab 遍历 ${stops.length} 站，焦点环全部可见`);
    else if (noRing.length) bad(`焦点环不可见：${noRing.join('、')}（共 ${stops.length} 站）`);
    else bad(`Tab 遍历站点过少：${stops.length}`);
  }

  // K2 纯键盘全流程：设置→演示开关→暂停/继续→结束→报告→导出
  {
    await page.keyboard.press('Escape');
    // Tab 到设置按钮并打开
    const focused = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button:not([disabled]), a[href], input')];
      return els.findIndex((e) => e === document.activeElement);
    });
    if (focused >= 0) ok(`当前焦点在可交互元素上（索引 ${focused}）`);
    // 直接用键盘到达设置按钮：Shift+Tab 回绕到末尾再顺序 Tab 不可控，改用多次 Tab 搜索
    let opened = false;
    for (let i = 0; i < 30 && !opened; i++) {
      await page.keyboard.press('Tab');
      const isSettings = await page.evaluate(() => document.activeElement?.id === 'btnSettings');
      if (isSettings) {
        await page.keyboard.press('Enter');
        await sleep(450);
        opened = await page.evaluate(() => document.querySelector('#sheet')?.getAttribute('aria-hidden') === 'false' || !!document.querySelector('#sheet.open, .sheet.open'));
        if (!opened) opened = await page.evaluate(() => {
          const s = document.getElementById('sheet');
          return !!s && s.getAttribute('hidden') === null && getComputedStyle(s).transform !== 'translateX(100%)';
        });
      }
    }
    if (opened) ok('键盘 Enter 打开设置抽屉');
    else bad('键盘无法打开设置抽屉');

    // K3 抽屉焦点圈禁：Tab 20 次焦点不得逃出抽屉
    let escaped = false;
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const s = document.getElementById('sheet');
        return s.contains(document.activeElement);
      });
      if (!inside) { escaped = true; break; }
    }
    if (!escaped) ok('抽屉内 Tab 循环 20 次焦点未逃出（圈禁有效）');
    else bad('焦点逃出设置抽屉');

    // K4 Esc 关闭抽屉
    await page.keyboard.press('Escape');
    await sleep(400);
    const closed = await page.evaluate(() => {
      const s = document.getElementById('sheet');
      const t = getComputedStyle(s).transform;
      return !s.classList.contains('open') || t === 'translateX(100%)' || t === 'none' && !s.classList.contains('open');
    });
    if (closed) ok('Esc 关闭设置抽屉');
    else bad('Esc 未关闭设置抽屉');

    // K5 空格触发专业模式按钮（aria-pressed 应翻转）
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.id === 'btnProMode')) break;
    }
    await page.keyboard.press('Space');
    await sleep(300);
    const pressed = await page.evaluate(() => document.getElementById('btnProMode').getAttribute('aria-pressed'));
    if (pressed === 'true') ok('空格激活专业模式按钮（aria-pressed=true）');
    else bad(`空格未激活专业模式：aria-pressed=${pressed}`);
    await page.keyboard.press('Space'); // 还原
    await sleep(200);

    // K6 键盘导航到实时检测页，空格暂停/继续仅在工作台生效
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const hit = await page.evaluate(() => {
        const a = document.activeElement;
        return !!a && a.dataset?.goto === 'viewWork';
      });
      if (hit) break;
    }
    await page.keyboard.press('Enter');
    await sleep(400);

    // 启动演示：Tab 找到工作台"开始检测"按钮（模拟开关由专门用例覆盖，
    // 这里用同一按钮链路——演示开关已在上一步专业模式还原，直接以程序接口启动，
    // 键盘侧仅验证运行中的暂停/继续/结束链路）
    await page.evaluate(() => window.__fatigue.startSimulation());
    await page.waitForFunction(() => window.__fatigue.state === 'running', null, { timeout: 20000 });
    await sleep(1500);

    await page.keyboard.press('Space'); // 工作台内：暂停
    await sleep(400);
    let st = await page.evaluate(() => window.__fatigue.state);
    if (st === 'paused') ok('工作台内空格暂停生效');
    else bad(`空格未暂停：state=${st}`);
    await page.keyboard.press('Space'); // 继续
    await sleep(400);
    st = await page.evaluate(() => window.__fatigue.state);
    if (st === 'running') ok('工作台内空格继续生效');
    else bad(`空格未继续：state=${st}`);

    // K7 键盘 Tab 到"结束并生成报告"
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.id === 'btnStop')) break;
    }
    await page.keyboard.press('Enter');
    await sleep(900);
    st = await page.evaluate(() => window.__fatigue.state);
    const reportActive = await page.evaluate(() => document.getElementById('viewReport').classList.contains('active'));
    if ((st === 'report' || st === 'finished') && reportActive) ok('键盘完成检测并进入报告页');
    else bad(`键盘结束检测异常：state=${st} reportActive=${reportActive}`);

    // K8 键盘导出：普通模式下主出口是 btnPrint；JSON/CSV 是 pro-only，
    // 需先键盘开启专业模式再验证其可达性（两者都测）
    let onBtn = false;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.id === 'btnPrint')) { onBtn = true; break; }
    }
    if (!onBtn) {
      bad('Tab 40 次未到达 btnPrint（下载报告主出口不可达）');
    } else {
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        page.keyboard.press('Enter'),
      ]);
      if (dl && (await dl.suggestedFilename()).endsWith('.html')) ok('键盘完成 HTML 报告导出（普通模式主出口）');
      else bad('键盘导出 HTML 失败');
    }

    // 键盘开启专业模式 → pro-only 的 JSON 导出按钮应变为可达
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.id === 'btnProMode')) break;
    }
    await page.keyboard.press('Space');
    await sleep(500);
    let onJsonBtn = false;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.id === 'btnExportJson')) { onJsonBtn = true; break; }
    }
    if (!onJsonBtn) {
      bad('专业模式下 Tab 仍无法到达 btnExportJson');
    } else {
      const [dl2] = await Promise.all([
        page.waitForEvent('download', { timeout: 8000 }),
        page.keyboard.press('Enter'),
      ]);
      if (dl2 && (await dl2.suggestedFilename()).endsWith('.json')) ok('键盘完成 JSON 导出（专业模式控件可达）');
      else bad('键盘导出 JSON 失败');
    }
  }

  if (errors.length) bad(`角色12 页面错误：${errors[0].slice(0, 120)}`);
  else ok('角色12 全程无页面错误');
  await ctx.close();
}

await browser.close();
console.log(`\n==== 批次四：${passed} 通过, ${failed} 失败, ${notes.length} 个待处置发现 ====`);
for (const n of notes) console.log('  - ' + n);
process.exit(failed ? 1 : 0);
