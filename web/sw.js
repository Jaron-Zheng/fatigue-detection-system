/**
 * sw.js — Service Worker（第三轮角色十二，PWA 离线/安装支持；r3 P2 重做缓存填充）
 *
 * 设计原则（与服务器缓存策略不打架）：
 *   · 服务器对源码是 no-store（开发模式改完刷新即生效）。本 SW **默认不注册**，
 *     只有显式开启（?pwa=1，见 app.js）才生效——日常开发零影响；
 *   · 开启后用于"演示/安装模式"：断网也能加载首页并运行演示模式；
 *   · 缓存填充（r3 P2 修复）：
 *       - install 阶段一次性 **预缓存** 首页 + 全部同源 css/js/svg/json（PRECACHE_URLS，
 *         由 tools/gen-sw-precache.mjs 从 web/ 目录扫描生成）。此前依赖"运行时缓存自动填充"，
 *         但首页与全部源码的首次加载发生在 SW 接管之前、永远不经过 fetch 事件，
 *         "开启后立刻断网"必然 503——只有再联网手动刷新一次才能补齐，UI 又没有任何提示；
 *       - 预缓存请求带 cache:'reload'，绕过浏览器 HTTP 缓存直接回源，避免 GitHub Pages
 *         max-age=600 留下的旧文件混进新缓存（P8 的 SW 侧缓解）；
 *   · 缓存策略：
 *       - 页面导航与源码（css/js/svg）：network-first + 缓存兜底。
 *         在线时永远拿最新代码（等价于开发行为），离线时回退到最近一次缓存；
 *       - vendor/（MediaPipe WASM 与模型，锁定版本、内容不变）：cache-first，
 *         离线启动不必重新下载 26MB。**例外 vendor/inventory.json**：它是模型哈希清单，
 *         换模型版本时会变，若 cache-first 锁死，老用户会拿旧清单验新模型 → 误报"文件被篡改"
 *         且线上无法自救，因此走 network-first；
 *   · 缓存版本号 CACHE_NAME = 前缀 + 内容指纹（CACHE_FINGERPRINT，由生成工具按全部预缓存
 *     文件内容 SHA-256 计算）：任何源码改动 → 新缓存名 → activate 阶段自动删旧缓存；
 *     需要强制清缓存时也可以手动改 CACHE_PREFIX；
 *   · 页面可 postMessage({type:'GET_STATUS'}) 查询离线就绪状态（app.js 用它决定 toast 文案）；
 *   · 手动彻底关闭：访问 ?pwa=0（注销 SW 并清空缓存，见 app.js）。
 */
'use strict';

/* PRECACHE:BEGIN — 由 tools/gen-sw-precache.mjs 生成，勿手改 */
const CACHE_FINGERPRINT = 'efda95cc86f9';
const PRECACHE_URLS = [
  './',
  './css/base.css',
  './css/components.css',
  './css/layout.css',
  './css/motion.css',
  './css/tokens.css',
  './favicon.svg',
  './index.html',
  './js/app.js',
  './js/compat.js',
  './js/config.js',
  './js/core/alarm.js',
  './js/core/analysis.js',
  './js/core/calibration.js',
  './js/core/csv-schema.js',
  './js/core/evaluation.js',
  './js/core/evaluator.js',
  './js/core/face-engine.js',
  './js/core/features.js',
  './js/core/fusion.js',
  './js/core/indicators.js',
  './js/core/landmarks.js',
  './js/core/preflight.js',
  './js/core/quality.js',
  './js/core/recorder.js',
  './js/core/render-loop.js',
  './js/core/session-state-machine.js',
  './js/core/sim-driver.js',
  './js/core/video-source.js',
  './js/test-hooks.js',
  './js/ui/alarm-visuals.js',
  './js/ui/analysis-ui.js',
  './js/ui/app-chrome.js',
  './js/ui/chart.js',
  './js/ui/dashboard.js',
  './js/ui/evaluation-ui.js',
  './js/ui/export-report.js',
  './js/ui/frame-presenter.js',
  './js/ui/motion.js',
  './js/ui/overlay.js',
  './js/ui/report.js',
  './js/ui/session-actions.js',
  './js/ui/session-stage.js',
  './js/ui/settings-wiring.js',
  './js/ui/settings.js',
  './js/ui/timeline.js',
  './js/ui/toast.js',
  './js/ui/video-controls.js',
  './js/ui/view-router.js',
  './js/ui/workbench-charts.js',
  './js/util/dom.js',
  './js/util/math.js',
  './js/util/ring-buffer.js',
  './manifest.json',
];
/* PRECACHE:END */

// 2026-09 r3：install 预缓存 + 指纹版本 + inventory network-first（前缀手改可强制全量清缓存）
const CACHE_VERSION = 'fatigue-v6-' + CACHE_FINGERPRINT;
const CACHE_NAME = `fatigue-cache-${CACHE_VERSION}`;

/**
 * 缓存写入必须容错：Cache.put 在配额不足（vendor 单文件 22MB，受限存储环境常见）、
 * 隐私模式或响应体不可缓存时会 reject。此前直接 `cache.put(...)` 不 await 也不 catch，
 * 表现为 SW 内 unhandledrejection——对用户静默，但 DevTools 满屏红字，且部分浏览器
 * 会因此判定 SW 脚本异常。写入失败不影响本次响应（响应已返回），忽略即可，下次在线再试。
 */
async function safePut(cache, req, res) {
  try {
    await cache.put(req, res);
  } catch {
    /* 配额/不可缓存：忽略 */
  }
}

/**
 * 预缓存全部核心资源。任一核心文件失败即让 install 失败——宁可没有 SW，
 * 也不要一个"看起来离线可用、实际缺文件"的半成品缓存（离线时白屏比 503 更难排查）。
 * 逐个请求而不用 cache.addAll：便于把失败的 URL 报出来。
 */
async function precache() {
  const cache = await caches.open(CACHE_NAME);
  const failed = [];
  await Promise.all(
    PRECACHE_URLS.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await cache.put(url, res);
      } catch (err) {
        failed.push(`${url}（${(err && err.message) || err}）`);
      }
    })
  );
  if (failed.length) {
    // 让 install 失败并把明细留在 SW 控制台；页面侧通过 registration 状态得知未就绪
    throw new Error(`预缓存失败 ${failed.length}/${PRECACHE_URLS.length}：${failed.slice(0, 5).join('，')}`);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await precache();
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
      // 通知所有已打开页面：离线资源就绪（页面据此给出一次性 toast）
      const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      for (const c of clients) c.postMessage({ type: 'SW_READY', version: CACHE_VERSION, precached: PRECACHE_URLS.length });
    })()
  );
});

/** 页面查询：当前缓存版本、预缓存条目数、vendor 是否已入缓存（决定"真实检测能否离线"） */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'GET_STATUS') return;
  event.waitUntil(
    (async () => {
      let vendorReady = false;
      let cachedCount = 0;
      try {
        const cache = await caches.open(CACHE_NAME);
        const keys = await cache.keys();
        cachedCount = keys.length;
        const hasModel = keys.some((r) => /\/vendor\/models\/.+\.task$/.test(new URL(r.url).pathname));
        const hasWasm = keys.some((r) => /\/vendor\/tasks-vision\/wasm\/.+\.wasm$/.test(new URL(r.url).pathname));
        vendorReady = hasModel && hasWasm;
      } catch {
        /* caches 不可用：按未就绪汇报 */
      }
      const reply = {
        type: 'SW_STATUS',
        version: CACHE_VERSION,
        precached: PRECACHE_URLS.length,
        cachedCount,
        vendorReady,
      };
      if (event.source && typeof event.source.postMessage === 'function') event.source.postMessage(reply);
    })()
  );
});

/** 是否 vendor 目录下的"锁定版本不变资源"（inventory.json 例外，见文件头） */
function isImmutableVendor(pathname) {
  if (!pathname.includes('/vendor/')) return false;
  return !pathname.endsWith('/vendor/inventory.json');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 只管同源，外部请求绝不经过缓存

  if (isImmutableVendor(url.pathname)) {
    // 锁定版本的不变资源：缓存优先
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) event.waitUntil(safePut(cache, req, res.clone()));
        return res;
      })()
    );
    return;
  }

  // 其余同源资源（页面/源码/inventory.json）：网络优先，离线回退缓存
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const res = await fetch(req);
        if (res.ok) event.waitUntil(safePut(cache, req, res.clone()));
        return res;
      } catch {
        // 导航请求忽略 query：入口常带 ?pwa=1 / ?demo=1，精确匹配会让离线回退找不到已缓存首页
        const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
        if (hit) return hit;
        // 导航请求离线且无缓存时，回退到已缓存的首页
        if (req.mode === 'navigate') {
          const home =
            (await cache.match('./', { ignoreSearch: true })) || (await cache.match('./index.html', { ignoreSearch: true }));
          if (home) return home;
        }
        return new Response('离线且无缓存', { status: 503, statusText: 'Offline' });
      }
    })()
  );
});
