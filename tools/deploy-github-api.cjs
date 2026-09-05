#!/usr/bin/env node
/**
 * deploy-github-api.cjs — 通过 GitHub API 直接上传文件部署到 Pages
 *
 * 由于 git push 超时，改用 GitHub Contents API 逐文件上传：
 *   1. 仓库已在 deploy-github.cjs 中创建好了
 *   2. 递归上传 web/ 目录下所有文件到 gh-pages 分支
 *   3. 添加 .nojekyll
 *   4. 启用 GitHub Pages
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN = process.argv[2];
const REPO = 'fatigue-detection-system';
const OWNER = 'Jaron-Zheng';
const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');

function ghRequest(method, endpoint, data, isBinary) {
  return new Promise((resolve, reject) => {
    let body = null;
    if (data) {
      if (isBinary) {
        body = data;
      } else {
        body = JSON.stringify(data);
      }
    }
    const headers = {
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'fatigue-detection-deploy',
    };
    if (data && !isBinary) {
      headers['Content-Type'] = 'application/json';
    } else if (data && isBinary) {
      headers['Content-Type'] = 'application/octet-stream';
    }

    const req = https.request({
      hostname: 'api.github.com',
      path: endpoint,
      method,
      headers,
    }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        try {
          resolve({ status: res.statusCode, data: text ? JSON.parse(text) : {}, headers: res.headers });
        } catch {
          resolve({ status: res.statusCode, data: text, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function walkDir(dir, base = '') {
  const results = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const relPath = base ? `${base}/${item.name}` : item.name;
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results.push(...walkDir(fullPath, relPath));
    } else {
      results.push({ path: relPath, fullPath });
    }
  }
  return results;
}

async function uploadFile(filePath, content) {
  // 检查文件是否已存在
  const checkResp = await ghRequest('GET', `/repos/${OWNER}/${REPO}/contents/${filePath}?ref=gh-pages`);
  let sha = null;
  if (checkResp.status === 200) {
    sha = checkResp.data.sha;
  }

  // 上传/更新文件
  const uploadResp = await ghRequest('PUT', `/repos/${OWNER}/${REPO}/contents/${filePath}`, {
    message: `deploy: ${filePath}`,
    content: content.toString('base64'),
    branch: 'gh-pages',
    ...(sha ? { sha } : {}),
  });

  return uploadResp.status === 200 || uploadResp.status === 201;
}

async function main() {
  console.log('══════════════════════════════════════════════════════');
  console.log('  通过 GitHub API 部署到 Pages');
  console.log('══════════════════════════════════════════════════════');
  console.log('');

  // 0. r3 P2/P8：部署前刷新 sw.js 预缓存清单与内容指纹（否则线上 SW 会带旧指纹/缺文件）
  console.log('[0] 刷新 Service Worker 预缓存清单...');
  {
    const r = require('child_process').spawnSync(process.execPath, [path.join(ROOT, 'tools', 'gen-sw-precache.mjs')], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      console.error('  生成 sw.js 预缓存清单失败，终止部署。');
      process.exit(1);
    }
  }

  // 1. 收集所有需要上传的文件
  console.log('[1] 收集文件...');
  const files = walkDir(WEB_DIR);
  console.log(`  ✓ 共 ${files.length} 个文件`);
  console.log('');

  // 2. 创建 .nojekyll
  console.log('[2] 上传 .nojekyll...');
  await uploadFile('.nojekyll', Buffer.from(''));
  console.log('  ✓ .nojekyll');
  console.log('');

  // 3. 逐文件上传
  console.log('[3] 上传文件...');
  let success = 0, failed = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const content = fs.readFileSync(f.fullPath);
    try {
      const ok = await uploadFile(f.path, content);
      if (ok) {
        success++;
        if ((i + 1) % 10 === 0 || i === files.length - 1) {
          console.log(`  [${i + 1}/${files.length}] ${f.path}`);
        }
      } else {
        failed++;
        console.log(`  ✗ [${i + 1}/${files.length}] ${f.path}`);
      }
    } catch (e) {
      failed++;
      console.log(`  ✗ [${i + 1}/${files.length}] ${f.path}: ${e.message}`);
    }
    // 避免触发 rate limit
    if ((i + 1) % 30 === 0) {
      console.log('  (等待 1 秒避免 rate limit...)');
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log('');
  console.log(`  ✓ 成功: ${success}, 失败: ${failed}`);
  console.log('');

  // 4. 启用 GitHub Pages
  console.log('[4] 启用 GitHub Pages...');
  const pagesResp = await ghRequest('POST', `/repos/${OWNER}/${REPO}/pages`, {
    source: { branch: 'gh-pages', path: '/' },
  });

  if (pagesResp.status === 201) {
    console.log('  ✓ GitHub Pages 已启用');
  } else if (pagesResp.status === 422) {
    console.log('  Pages 已存在，更新源...');
    await ghRequest('PUT', `/repos/${OWNER}/${REPO}/pages`, {
      source: { branch: 'gh-pages', path: '/' },
    });
    console.log('  ✓ Pages 源已更新');
  } else {
    console.log(`  Pages: ${pagesResp.status}`, pagesResp.data.message || '');
  }

  // 5. 获取 Pages URL
  const pagesInfo = await ghRequest('GET', `/repos/${OWNER}/${REPO}/pages`);
  const url = pagesInfo.data.html_url || `https://${OWNER}.github.io/${REPO}/`;

  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log('  ✓ 部署完成！');
  console.log('══════════════════════════════════════════════════════');
  console.log('');
  console.log('  访问链接: ' + url);
  console.log('  仓库地址: https://github.com/' + OWNER + '/' + REPO);
  console.log('');
  console.log('  注意: Pages 首次生效需要 1-2 分钟。');
  console.log('');
}

main().catch(e => {
  console.error('部署失败:', e.message);
  process.exit(1);
});
