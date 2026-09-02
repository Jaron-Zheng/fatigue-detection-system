#!/usr/bin/env node
/**
 * integration-test.mjs — 服务器集成与安全测试
 *
 * 前置条件：服务器已在本机运行（npm run serve 或一键启动）。
 * 用法：node tools/integration-test.mjs [--port 5180]
 *
 * 覆盖：
 *   · 关键静态资源可访问且 MIME 正确（含 wasm/task 的流式编译前提）
 *   · 安全响应头齐备（CSP / nosniff / Permissions-Policy 等）
 *   · 目录穿越被拒绝（403），非法编码被拒绝（400/403）
 *   · 非 GET 方法被拒绝（405）
 *   · 不存在资源返回 404 且不泄露磁盘路径
 *   · Range 请求可用（大模型文件稳定加载的前提）
 */
const args = process.argv.slice(2);
const PORT = (() => { const i = args.indexOf('--port'); return i >= 0 ? Number(args[i + 1]) : 5180; })();
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function assert(cond, name, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  [' + detail + ']' : ''}`); }
}

async function req(pathname, options = {}) {
  return fetch(BASE + pathname, options);
}

/** 原始 HTTP 请求：fetch 会把 /../ 规范化掉，穿越测试必须发送未处理的路径 */
import http from 'node:http';
function rawReq(pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 200000) res.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

console.log(`\n=== 服务器集成测试 → ${BASE} ===\n`);

/* ---------- 1. 关键资源 ---------- */
console.log('[1] 关键静态资源');
const pages = [
  ['/', 'text/html'],
  ['/css/tokens.css', 'text/css'],
  ['/js/app.js', 'text/javascript'],
  ['/favicon.svg', 'image/svg+xml'],
  ['/vendor/tasks-vision/vision_bundle.mjs', 'text/javascript'],
  ['/vendor/tasks-vision/wasm/vision_wasm_internal.wasm', 'application/wasm'],
  ['/vendor/models/face_landmarker.task', 'application/octet-stream'],
];
for (const [p, mime] of pages) {
  const r = await req(p);
  const ct = r.headers.get('content-type') || '';
  assert(r.status === 200, `GET ${p} → 200`, `实际 ${r.status}`);
  assert(ct.startsWith(mime), `    MIME = ${mime}`, `实际 ${ct}`);
}

/* ---------- 2. 安全头 ---------- */
console.log('\n[2] 安全响应头');
{
  const r = await req('/');
  const h = r.headers;
  assert((h.get('content-security-policy') || '').includes("default-src 'self'"), 'CSP default-src self');
  assert((h.get('content-security-policy') || '').includes('frame-ancestors'), 'CSP 禁止被 iframe 嵌入');
  assert(h.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff');
  assert((h.get('permissions-policy') || '').includes('camera='), 'Permissions-Policy 约束摄像头');
  assert(h.get('referrer-policy') === 'no-referrer', 'Referrer-Policy: no-referrer');
  assert(h.get('cross-origin-opener-policy') === 'same-origin', 'COOP same-origin（跨源隔离前提）');
}

/* ---------- 3. 目录穿越与非法请求 ---------- */
console.log('\n[3] 目录穿越与非法请求防护（原始请求，不经 fetch 规范化）');
{
  const r1 = await rawReq('/../package.json');
  assert([400, 403, 404].includes(r1.status), 'GET /../package.json 被拒绝', `实际 ${r1.status}`);
  assert(!r1.body.includes('"scripts"'), '    未泄露 package.json 内容');
  const r2 = await rawReq('/%2e%2e/package.json');
  assert([400, 403, 404].includes(r2.status) || !r2.body.includes('"scripts"'), 'URL 编码穿越被拒绝', `实际 ${r2.status}`);
  const r3 = await rawReq('/..%2fserver%2fserver.js');
  assert([400, 403, 404].includes(r3.status) || !r3.body.includes('http.createServer'), '%2f 编码穿越被拒绝', `实际 ${r3.status}`);
  const r4 = await rawReq('/server/server.js');
  assert(r4.status === 404, '服务器源码不可经 web 访问', `实际 ${r4.status}`);
  const r5 = await rawReq('/', 'POST');
  assert(r5.status === 405, 'POST 被拒绝（405）', `实际 ${r5.status}`);
  const r6 = await rawReq('/not-exist-xyz');
  assert(r6.status === 404, '不存在资源 → 404', `实际 ${r6.status}`);
  assert(!r6.body.includes('C:\\') && !r6.body.includes('/Users/'), '404 页面不泄露磁盘路径');
  const r7 = await rawReq('/%zz-invalid');
  assert([400, 403].includes(r7.status), '非法百分号编码被拒绝', `实际 ${r7.status}`);
  const r8 = await rawReq('/js/app.js%00.css');
  assert([400, 403, 404].includes(r8.status), '空字节注入被拒绝', `实际 ${r8.status}`);
}

/* ---------- 4. Range 请求 ---------- */
console.log('\n[4] Range 请求（大文件稳定加载前提）');
{
  const r = await req('/vendor/tasks-vision/wasm/vision_wasm_internal.wasm', { headers: { Range: 'bytes=0-1023' } });
  assert(r.status === 206, 'Range 请求返回 206', `实际 ${r.status}`);
  const buf = await r.arrayBuffer();
  assert(buf.byteLength === 1024, '返回长度 = 1024', `实际 ${buf.byteLength}`);
  const head = new Uint8Array(buf).slice(0, 4);
  assert(head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d, '首字节为 wasm 魔数 \\0asm');
}

/* ---------- 5. 首页结构完整性 ---------- */
console.log('\n[5] 首页关键元素');
{
  const html = await (await req('/')).text();
  // alarmBanner 已随 UI 改版移除，声光报警改为 alarmVeil 视觉蒙层 + toast 家族
  for (const id of ['viewHome', 'viewWork', 'viewReport', 'sheet', 'alarmVeil', 'video', 'chartScore']) {
    assert(html.includes(`id="${id}"`), `包含 #${id}`);
  }
  // <a href> 超链接仅在被用户点击时才导航，不构成页面加载期的自动资源请求，
  // 剔除后再检测；face-engine.js 的 CDN 镜像链由 isLocalEnv() 保证本地形态同源。
  const htmlNoReq = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<a\s[^>]*href\s*=\s*(?:"[^"]*"|'[^']*')/gi, '<a');
  assert(!/https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+\.[a-z]{2}/i.test(htmlNoReq), '首页无外部域名请求（离线可用）');
}

console.log(`\n=== 结果: ${pass} 通过, ${fail} 失败 ===\n`);
// 不调用 process.exit：fetch 的 keep-alive 连接在强退时会触发 Windows libuv 断言。
// 只设退出码，连接由 undici 在几秒内自行关闭后进程自然退出。
process.exitCode = fail ? 1 : 0;
