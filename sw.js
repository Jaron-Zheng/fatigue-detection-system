/**
 * sw.js — Service Worker（第三轮角色十二，PWA 离线/安装支持）
 *
 * 设计原则（与服务器缓存策略不打架）：
 *   · 服务器对源码是 no-store（开发模式改完刷新即生效）。本 SW **默认不注册**，
 *     只有显式开启（?pwa=1，见 app.js）才生效——日常开发零影响；
 *   · 开启后用于"演示/安装模式"：断网也能加载首页并运行演示模式；
 *   · 缓存策略：
 *       - 页面导航与源码（css/js/svg）：network-first + 缓存兜底。
 *         在线时永远拿最新代码（等价于开发行为），离线时回退到最近一次缓存；
 *       - vendor/（MediaPipe WASM 与模型，锁定版本、内容不变）：cache-first，
 *         离线启动不必重新下载 26MB；
 *   · 缓存版本号 CACHE_VERSION：需要强制清缓存时改这个常量，
 *     activate 阶段会自动删掉旧版本缓存；
 *   · 手动彻底关闭：访问 ?pwa=0（注销 SW 并清空缓存，见 app.js）。
 */
'use strict';

const CACHE_VERSION = 'fatigue-v5-r1'; // 2026-09 质量加固 r2：缓存写入容错 + 导航回退忽略 query
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

self.addEventListener('install', () => {
  // 不做静态预缓存：首次在线访问时运行时缓存自动填充全部资源
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 只管同源，外部请求绝不经过缓存

  const isVendor = url.pathname.startsWith('/vendor/') || url.pathname.includes('/vendor/');

  if (isVendor) {
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

  // 其余同源资源（页面/源码）：网络优先，离线回退缓存
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
