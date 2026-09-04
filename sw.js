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

const CACHE_VERSION = 'fatigue-v4-r1'; // 2026-09 黑屏根修版本：强制刷新旧缓存
const CACHE_NAME = `fatigue-cache-${CACHE_VERSION}`;

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
        if (res.ok) cache.put(req, res.clone());
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
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        const hit = await cache.match(req);
        if (hit) return hit;
        // 导航请求离线且无缓存时，回退到已缓存的首页
        if (req.mode === 'navigate') {
          const home = await cache.match('./');
          if (home) return home;
        }
        return new Response('离线且无缓存', { status: 503, statusText: 'Offline' });
      }
    })()
  );
});
