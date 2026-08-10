#!/usr/bin/env node
/**
 * server.js — 零依赖本地静态服务器
 *
 * 设计要点（毕设答辩可讲）：
 * 1. 仅使用 Node 内置模块，无需 npm install，降低部署门槛。
 * 2. 仅监听 127.0.0.1：摄像头页面不暴露到局域网，避免他人访问本机检测页。
 * 3. http://localhost 属于浏览器"安全上下文(Secure Context)"，
 *    因此无需 HTTPS 证书即可调用 getUserMedia 访问摄像头。
 * 4. 正确设置 .wasm / .task / .mjs 的 MIME，否则 WebAssembly 流式编译会失败。
 * 5. 路径规范化 + 根目录越界校验，防止目录穿越读取任意文件。
 * 6. 支持 Range 请求，便于大模型文件（3.7MB）与 wasm（11MB）稳定加载。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', 'web');
const HOST = '127.0.0.1';
const DEFAULT_PORT = Number(process.env.PORT) || 5180;
const MAX_PORT_TRY = 20;
const NO_OPEN = process.argv.includes('--no-open') || process.env.NO_OPEN === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.binarypb': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.d.ts': 'text/plain; charset=utf-8',
};

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** 把 URL 路径安全解析为磁盘路径；越界返回 null */
function resolveSafe(reqPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(reqPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  if (decoded.endsWith('/')) decoded += 'index.html';
  const abs = path.resolve(ROOT, '.' + path.posix.normalize(decoded));
  // 必须仍在 ROOT 之内
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

function send(res, status, headers, body) {
  res.writeHead(status, {
    // no-store：开发/答辩场景下改完代码刷新即生效，不会命中浏览器模块缓存
    'Cache-Control': 'no-store, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  if (body) res.end(body);
  else res.end();
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' }, '405 Method Not Allowed');
  }

  // 用 WHATWG URL 解析（url.parse 已被 Node 标记为弃用，且有安全隐患）。
  // 这里的 base 只用于补全，不影响实际路由。
  let pathname;
  try {
    pathname = new URL(req.url, `http://${HOST}`).pathname;
  } catch {
    return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, '400 Bad Request');
  }

  const filePath = resolveSafe(pathname === '/' ? '/index.html' : pathname);
  if (!filePath) {
    return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, '403 Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      if (!err && stat.isDirectory()) {
        const idx = path.join(filePath, 'index.html');
        if (fs.existsSync(idx)) return streamFile(idx, fs.statSync(idx));
      }
      return send(res, 404, { 'Content-Type': 'text/html; charset=utf-8' }, notFoundPage(pathname));
    }
    streamFile(filePath, stat);
  });

  function streamFile(fp, stat) {
    const type = contentType(fp);
    const range = req.headers.range;
    // vendor 下是 26MB 的模型与 wasm，允许强缓存以加快二次启动；
    // 其余源码一律 no-store，保证修改后刷新即生效。
    const isVendor = fp.includes(`${path.sep}vendor${path.sep}`);
    const baseHeaders = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Last-Modified': stat.mtime.toUTCString(),
      'Cache-Control': isVendor ? 'public, max-age=86400' : 'no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    };

    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        let start = m[1] === '' ? null : parseInt(m[1], 10);
        let end = m[2] === '' ? null : parseInt(m[2], 10);
        if (start === null && end !== null) {
          start = Math.max(0, stat.size - end);
          end = stat.size - 1;
        } else {
          if (start === null) start = 0;
          if (end === null || end >= stat.size) end = stat.size - 1;
        }
        if (start > end || start >= stat.size) {
          return send(res, 416, { 'Content-Range': `bytes */${stat.size}` }, '');
        }
        res.writeHead(206, {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': end - start + 1,
        });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(fp, { start, end }).pipe(res);
      }
    }

    res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(fp).pipe(res);
  }
});

function notFoundPage(p) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>404</title><style>
body{font:400 17px/1.5 "SF Pro SC","PingFang SC",-apple-system,sans-serif;background:#f5f5f7;color:#1d1d1f;
display:grid;place-items:center;height:100vh;margin:0}
.box{text-align:center}h1{font-size:48px;font-weight:600;margin:0 0 8px}
code{background:#e8e8ed;padding:2px 8px;border-radius:6px}
a{color:#0066cc;text-decoration:none}</style>
<div class="box"><h1>404</h1><p>找不到 <code>${String(p).replace(/[<>&"]/g, '')}</code></p>
<p><a href="/">返回首页</a></p></div></html>`;
}

function openBrowser(target) {
  try {
    if (process.platform === 'win32') {
      // 用 cmd 的 start；第一个空参数是窗口标题占位，避免带引号 URL 被当标题
      spawn('cmd', ['/c', 'start', '""', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 打不开浏览器不影响服务本身 */
  }
}

/**
 * 端口自选。
 *
 * 注意：server.listen(port, host, cb) 的 cb 是以 'listening' 监听器的形式注册的。
 * 若首次 listen 因端口占用失败后直接递归重试，上一轮注册的 listening 监听器
 * 并不会自动移除，成功时会一并触发——表现为重复打印启动横幅，
 * 且旧闭包里捕获的是旧端口号，打印出错误的访问地址。
 * 因此这里显式成对注册/移除两个监听器。
 */
function listen(port, attempt = 0) {
  const onError = (err) => {
    server.removeListener('listening', onListening);
    if (err.code === 'EADDRINUSE' && attempt < MAX_PORT_TRY) {
      console.log(`  端口 ${port} 被占用，尝试 ${port + 1} ...`);
      return listen(port + 1, attempt + 1);
    }
    console.error('服务器启动失败：', err.message);
    process.exit(1);
  };

  const onListening = () => {
    server.removeListener('error', onError);
    const target = `http://${HOST}:${port}/`;
    const missing = checkVendor();
    console.log('');
    console.log('  ┌──────────────────────────────────────────────────────┐');
    console.log('  │   驾驶员疲劳检测系统 · 本地服务已启动                │');
    console.log('  └──────────────────────────────────────────────────────┘');
    console.log('');
    console.log(`   访问地址 : ${target}`);
    console.log(`   静态根目录: ${ROOT}`);
    console.log(`   Node     : ${process.version}  平台: ${os.platform()} ${os.arch()}`);
    if (missing.length) {
      console.log('');
      console.log('   [提示] 以下本地推理资源缺失，请先运行: node tools\\fetch-vendor.js');
      missing.forEach((f) => console.log('          - ' + f));
    } else {
      console.log('   推理资源 : 已本地化，可离线运行 ✓');
    }
    console.log('');
    console.log('   按 Ctrl+C 停止服务');
    console.log('');
    if (!NO_OPEN) openBrowser(target);
  };

  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, HOST);
}

function checkVendor() {
  const required = [
    'vendor/tasks-vision/vision_bundle.mjs',
    'vendor/tasks-vision/wasm/vision_wasm_internal.wasm',
    'vendor/models/face_landmarker.task',
  ];
  return required.filter((r) => {
    const p = path.join(ROOT, r);
    return !fs.existsSync(p) || fs.statSync(p).size === 0;
  });
}

process.on('SIGINT', () => {
  console.log('\n  服务已停止。');
  process.exit(0);
});

listen(DEFAULT_PORT);
