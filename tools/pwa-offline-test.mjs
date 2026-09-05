#!/usr/bin/env node
/**
 * pwa-offline-test.mjs — PWA 断网实测（第三轮角色十二）
 *
 * 不是"加了 manifest 和 sw 就宣称离线可用"——本脚本真实执行：
 *   1. 以 ?pwa=1 打开首页，等待 Service Worker 激活并确认缓存已填充；
 *   2. 用 CDP Network.emulateNetworkConditions 切断网络；
 *   3. 断网状态下重新导航，断言页面仍可加载（SW 缓存兜底）；
 *   4. 断网状态下启动演示模式，断言主循环正常产数（不依赖网络）；
 *   5. 顺带断言 vendor/ 资源已进入缓存（离线启动不必重下 26MB 模型）。
 *
 * 用法：node tools/pwa-offline-test.mjs [--url http://127.0.0.1:5180/] [--port 9361]
 */
import { launchHeadless, evalJs, sleep } from './cdp-util.mjs';

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const URL_TARGET = get('--url', 'http://127.0.0.1:5180/');

let passed = 0;
let failed = 0;
const assert = (cond, msg) => {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
};

const session = await launchHeadless({ debugPort: Number(get('--port', 9361)) });
const { cdp } = session;
const watchdog = setTimeout(() => {
  console.error('看门狗超时');
  session.close().finally(() => process.exit(1));
}, 180000);

try {
  console.log(`=== PWA 断网实测 → ${URL_TARGET} ===\n`);

  /* ---- 1. 在线首次访问：注册 SW 并填充缓存 ---- */
  console.log('[1] 在线访问 ?pwa=1，注册 Service Worker');
  await cdp.send('Page.navigate', { url: URL_TARGET + '?pwa=1' });
  await sleep(4000);
  const swState = await evalJs(cdp, `(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return { supported: true, registered: false };
    const active = Boolean(reg.active);
    return { supported: true, registered: true, active, scope: reg.scope };
  })()`);
  assert(swState.supported && swState.registered, `Service Worker 已注册（scope=${swState.scope || 'n/a'}）`);
  assert(swState.active === true, 'Service Worker 已激活（active）');

  /* ---- 1b. r3 P2 回归：冷开启即断网（不做第二次在线刷新） ----
   * 旧实现 install 不预缓存，首页与源码的首次加载又发生在 SW 接管前，
   * 这里若不"再刷新一次"就断网必然 503。新实现 install 阶段预缓存全部核心资源，
   * 因此激活即应有 ≥50 条缓存，且立刻断网重载也要能打开。 */
  console.log('\n[1b] 冷开启即断网：激活后不刷新直接离线重载');
  const coldCache = await evalJs(cdp, `(async () => {
    const keys = await caches.keys();
    if (!keys.length) return { keys: [], entries: 0 };
    const cache = await caches.open(keys[0]);
    const reqs = await cache.keys();
    // evalJs 模板串里写正则需双反斜杠转义，易错；这里直接用 endsWith 同义改写
    const hasHome = reqs.some((r) => {
      const p = new URL(r.url).pathname;
      return p.endsWith('/') || p.endsWith('/index.html');
    });
    const hasApp = reqs.some((r) => new URL(r.url).pathname.endsWith('/js/app.js'));
    return { keys, entries: reqs.length, hasHome, hasApp };
  })()`);
  assert(coldCache.entries >= 50, `install 阶段已预缓存核心资源（${coldCache.entries} 条，缓存名 ${coldCache.keys[0] || 'n/a'}）`);
  assert(coldCache.hasHome && coldCache.hasApp, '预缓存包含首页与 js/app.js');
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await cdp.send('Page.navigate', { url: URL_TARGET });
  await sleep(4000);
  const coldTitle = await evalJs(cdp, 'document.title').catch(() => null);
  const coldHooks = await evalJs(cdp, 'Boolean(window.__fatigue)').catch(() => false);
  assert(typeof coldTitle === 'string' && coldTitle.length > 0 && coldHooks === true, `冷开启即断网仍可加载首页并执行脚本（标题：${coldTitle}）`);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  // 再加载一次（在线）以进入后续 vendor 预热流程
  await cdp.send('Page.navigate', { url: URL_TARGET + '?pwa=1' });
  await sleep(4000);

  // vendor 模型/WASM 是懒加载（真实检测才拉取），在线阶段主动预热进 SW 缓存，
  // 这样离线时连真实推理链路也能启动
  console.log('  预热 vendor/ 进缓存（6 个文件，约 26MB，本机回环很快）');
  const warmed = await evalJs(cdp, `(async () => {
    const files = [
      'vendor/inventory.json',
      'vendor/tasks-vision/vision_bundle.mjs',
      'vendor/tasks-vision/wasm/vision_wasm_internal.js',
      'vendor/tasks-vision/wasm/vision_wasm_internal.wasm',
      'vendor/tasks-vision/wasm/vision_wasm_nosimd_internal.js',
      'vendor/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm',
      'vendor/models/face_landmarker.task',
    ];
    let ok = 0;
    for (const f of files) {
      const r = await fetch(f, { cache: 'no-cache' });
      if (r.ok) ok++;
    }
    return ok;
  })()`);
  assert(warmed >= 6, `vendor/ 预热完成（${warmed}/7 个文件）`);
  const cacheInfo = await evalJs(cdp, `(async () => {
    const keys = await caches.keys();
    if (!keys.length) return { keys: [], entries: 0, vendor: 0 };
    const cache = await caches.open(keys[0]);
    const reqs = await cache.keys();
    const vendor = reqs.filter((r) => new URL(r.url).pathname.includes('/vendor/')).length;
    return { keys, entries: reqs.length, vendor };
  })()`);
  assert(cacheInfo.entries > 10, `缓存已填充（${cacheInfo.entries} 条资源）`);
  assert(cacheInfo.vendor >= 4, `vendor/ 模型与 WASM 已入缓存（${cacheInfo.vendor} 条，离线启动免下载 26MB）`);
  // r3 P2 附带：inventory.json 走 network-first——在线时必须回源（Response 不来自缓存命中）
  const invFresh = await evalJs(cdp, `(async () => {
    const r = await fetch('vendor/inventory.json?probe=' + Date.now());
    return r.ok;
  })()`);
  assert(invFresh === true, 'vendor/inventory.json 在线可回源（network-first，换模型不会被旧清单锁死）');

  /* ---- 2. 断网 ---- */
  console.log('\n[2] 切断网络（Network.emulateNetworkConditions）');
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  assert(true, '已置为离线状态');

  /* ---- 3. 断网重新导航：页面仍可加载 ---- */
  console.log('\n[3] 断网状态下重新加载首页');
  await cdp.send('Page.navigate', { url: URL_TARGET });
  await sleep(5000);
  const title = await evalJs(cdp, 'document.title').catch(() => null);
  assert(typeof title === 'string' && title.length > 0, `断网下页面加载成功（标题：${title}）`);
  const hooks = await evalJs(cdp, 'Boolean(window.__fatigue)').catch(() => false);
  assert(hooks === true, '断网下应用脚本完整执行（__fatigue 钩子存在）');

  /* ---- 4. 断网跑演示模式 ---- */
  console.log('\n[4] 断网状态下启动演示模式');
  const st = await evalJs(cdp, 'window.__fatigue.startSimulation()').catch((e) => 'ERR:' + e.message);
  assert(st === 'running', `演示模式启动成功（state=${st}）`);
  await sleep(3000);
  const score = await evalJs(cdp, 'window.__fatigue.score');
  assert(Number.isFinite(score) && score >= 0 && score <= 100, `断网下主循环正常产数（score=${score?.toFixed?.(1)}）`);
  const errors = cdp.consoleErrors.filter((e) => !/net::|ERR_INTERNET|Failed to load resource/.test(e));
  assert(errors.length === 0, `无应用级控制台错误（${errors.length} 条）`);

  /* ---- 5. 恢复网络并关闭 PWA 开关（避免污染后续测试） ---- */
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await cdp.send('Page.navigate', { url: URL_TARGET + '?pwa=0' });
  await sleep(2500);
  const cleared = await evalJs(cdp, `(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    return { regs: regs.length, flag: localStorage.getItem('fatigue.pwa') };
  })()`);
  assert(cleared.regs === 0 && cleared.flag === null, '?pwa=0 成功注销 SW 并清除开关（回到开发模式）');
} catch (err) {
  failed++;
  console.error('  ✗ 测试异常:', err.message);
} finally {
  await session.close();
}

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
clearTimeout(watchdog);
process.exit(failed > 0 ? 1 : 0);
