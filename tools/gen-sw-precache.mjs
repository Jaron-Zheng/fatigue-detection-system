#!/usr/bin/env node
/**
 * gen-sw-precache.mjs — 生成 / 校验 web/sw.js 的预缓存清单与缓存版本号（零依赖，Node 18+）
 *
 * 背景（r3 P2）：SW 此前 install 阶段不做任何预缓存，首页与全部 js/css 的首次加载
 * 又发生在 SW 接管之前，永远不会进入运行时缓存——"开启 ?pwa=1 后断网也能打开"
 * 只有在"联网状态下又手动刷新过一次"的隐含序列下才成立。
 *
 * 本工具扫描 web/ 下全部同源静态资源（排除 vendor/ 与 sw.js 本身），
 *   ① 写入 sw.js 的 PRECACHE_URLS 数组（install 阶段一次性抓取）；
 *   ② 对这些文件内容做 SHA-256，取前 12 位作为 CACHE_VERSION 的指纹后缀——
 *      任何一处源码改动都会得到新的缓存名，activate 阶段自动淘汰旧缓存。
 *      这同时缓解 P8（静态资源无指纹 + GitHub Pages max-age=600）：
 *      开启 PWA 的用户在 SW 更新时以 cache:'reload' 绕过 HTTP 缓存重新抓取全部资源，
 *      不会出现"新 HTML 配旧 JS"。
 *
 * 用法：
 *   node tools/gen-sw-precache.mjs           # 重写 web/sw.js（内容变化时）
 *   node tools/gen-sw-precache.mjs --check   # 只校验：清单/指纹过期则退出码 1（接入门禁）
 *
 * 部署前必须执行一次（deploy-github*.cjs 已自动调用）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const SW = path.join(WEB, 'sw.js');

/** 不进预缓存的路径：vendor（26MB，运行时 cache-first）、SW 自身、部署标记文件 */
const EXCLUDE = new Set(['sw.js', '.nojekyll']);
const EXCLUDE_DIRS = new Set(['vendor']);
/** 只收录浏览器会请求的静态类型 */
const INCLUDE_EXT = new Set(['.html', '.css', '.js', '.mjs', '.svg', '.json', '.png', '.ico', '.webmanifest', '.woff2']);

function walk(dir, base = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      out.push(...walk(path.join(dir, ent.name), rel));
    } else if (ent.isFile()) {
      if (EXCLUDE.has(rel)) continue;
      if (!INCLUDE_EXT.has(path.extname(ent.name).toLowerCase())) continue;
      out.push(rel);
    }
  }
  return out;
}

export function computePrecache() {
  const files = walk(WEB);
  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(f);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(WEB, f)));
    hash.update('\0');
  }
  const fingerprint = hash.digest('hex').slice(0, 12);
  // 首页同时以 './' 与 './index.html' 两种 URL 入缓存：导航请求命中前者，直链命中后者
  const urls = ['./', ...files.map((f) => `./${f}`)];
  return { files, urls, fingerprint };
}

const BEGIN = '/* PRECACHE:BEGIN — 由 tools/gen-sw-precache.mjs 生成，勿手改 */';
const END = '/* PRECACHE:END */';

export function renderSw(src, { urls, fingerprint }) {
  const b = src.indexOf(BEGIN);
  const e = src.indexOf(END);
  if (b < 0 || e < 0 || e < b) throw new Error('web/sw.js 缺少 PRECACHE:BEGIN/END 标记');
  const body =
    `${BEGIN}\n` +
    `const CACHE_FINGERPRINT = '${fingerprint}';\n` +
    `const PRECACHE_URLS = [\n` +
    urls.map((u) => `  '${u}',`).join('\n') +
    `\n];\n${END}`;
  return src.slice(0, b) + body + src.slice(e + END.length);
}

function main() {
  const check = process.argv.includes('--check');
  const src = fs.readFileSync(SW, 'utf8');
  const info = computePrecache();
  const next = renderSw(src, info);
  const stale = next !== src;
  if (check) {
    if (stale) {
      console.error(
        `✗ web/sw.js 预缓存清单/指纹已过期（当前指纹 ${info.fingerprint}，${info.urls.length} 项）。` +
          `请运行 node tools/gen-sw-precache.mjs 后重新提交。`
      );
      process.exit(1);
    }
    console.log(`✓ sw.js 预缓存清单最新（指纹 ${info.fingerprint} · ${info.urls.length} 项）`);
    return;
  }
  if (stale) {
    fs.writeFileSync(SW, next);
    console.log(`已更新 web/sw.js：指纹 ${info.fingerprint} · 预缓存 ${info.urls.length} 项`);
  } else {
    console.log(`web/sw.js 无需更新（指纹 ${info.fingerprint} · ${info.urls.length} 项）`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
