#!/usr/bin/env node
/**
 * deploy-github.cjs — 部署疲劳检测系统到 GitHub Pages
 *
 * 流程：
 *   1. 用令牌创建新仓库（如果不存在）
 *   2. 复制 web/ 到临时目录，初始化 git，提交并推送到 gh-pages 分支
 *   3. 通过 API 启用 GitHub Pages
 *   4. 输出访问链接
 *
 * 令牌安全（2026-09 泄漏事故根修）：
 *   · 令牌优先经 GH_TOKEN 环境变量传入（argv[2] 兼容保留）；
 *   · 令牌只出现在 push 命令参数里，从不写入任何 git config——
 *     旧版向本仓库添加带令牌的 deploy remote，且失败路径直接
 *     process.exit(1) 跳过收尾清理，令牌随 git remote -v / git
 *     config 输出泄漏进终端日志（实际发生过一次）；
 *   · 临时部署目录 try/finally 无条件清理（成功与失败路径都删）；
 *   · 所有对外输出经 redact() 脱敏（git 报错常回显完整 URL）。
 *   · 已接受的残余风险：push 参数在进程列表中有秒级瞬时可见（本机窗口期）。
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const TOKEN = process.argv[2] || process.env.GH_TOKEN;
const REPO_NAME = 'fatigue-detection-system';
const ROOT = path.resolve(__dirname, '..');

if (!TOKEN) {
  console.error('需要 GitHub 令牌：设置 GH_TOKEN 环境变量，或作为第一个参数传入');
  process.exit(1);
}

/** 把输出里出现的令牌替换为 ***（git 报错常回显完整 remote URL） */
const redact = (s) => (s == null ? '' : String(s).split(TOKEN).join('***'));

function ghRequest(method, endpoint, data) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: endpoint,
        method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'fatigue-detection-deploy',
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          try {
            const json = chunks ? JSON.parse(chunks) : {};
            resolve({ status: res.statusCode, data: json, headers: res.headers });
          } catch {
            resolve({ status: res.statusCode, data: chunks, headers: res.headers });
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  console.log('══════════════════════════════════════════════════════');
  console.log('  部署到 GitHub Pages');
  console.log('══════════════════════════════════════════════════════');
  console.log('');

  // 1. 获取用户信息（失败时尚无任何令牌落盘状态，直接退出是安全的）
  console.log('[1] 获取 GitHub 用户信息...');
  const userResp = await ghRequest('GET', '/user');
  if (userResp.status !== 200) {
    console.error('  令牌无效:', userResp.status, userResp.data.message || '');
    process.exit(1);
  }
  const username = userResp.data.login;
  console.log(`  ✓ 用户: ${username}`);

  // 2. 检查仓库是否已存在
  console.log('');
  console.log('[2] 检查仓库是否存在...');
  const checkResp = await ghRequest('GET', `/repos/${username}/${REPO_NAME}`);
  const repoExists = checkResp.status === 200;

  if (repoExists) {
    console.log(`  ✓ 仓库已存在: ${username}/${REPO_NAME}`);
  } else {
    // 3. 创建仓库
    console.log('  仓库不存在，正在创建...');
    const createResp = await ghRequest('POST', '/user/repos', {
      name: REPO_NAME,
      description: '基于面部多特征融合的Web端驾驶员疲劳检测系统',
      public: true,
      auto_init: false,
    });
    if (createResp.status !== 201) {
      console.error('  创建仓库失败:', createResp.status, createResp.data.message || '');
      process.exit(1);
    }
    console.log(`  ✓ 仓库已创建: https://github.com/${username}/${REPO_NAME}`);
  }

  // 4. 准备 git 推送
  console.log('');
  console.log('[3] 准备 Git 推送...');

  /* 令牌只经 push 命令参数传递，从不写入本仓库 git config 的 remote URL
   * （旧版在此 git remote add deploy <token-url>，正是泄漏根因，已删）。 */
  const remoteUrl = `https://${username}:${TOKEN}@github.com/${username}/${REPO_NAME}.git`;

  // 配置 git
  execSync('git config user.name "Jaron"', { cwd: ROOT });
  execSync('git config user.email "jiahe.zheng@outlook.com"', { cwd: ROOT });

  // 创建 .gitignore 确保不推送大文件
  const gitignorePath = path.join(ROOT, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(
      gitignorePath,
      `_pack/
node_modules/
*.log
.playwright-mcp/
`
    );
  }

  // 5. 提交代码（只推送 web/ 目录到 gh-pages 分支，Pages 需要纯静态文件）
  console.log('');
  console.log('[4] 提交代码...');

  // 创建临时目录用于 Pages 部署
  const deployDir = path.join(ROOT, '_gh-pages-deploy');
  if (fs.existsSync(deployDir)) {
    execSync(`rd /s /q "${deployDir}"`, { stdio: 'pipe' });
  }
  fs.mkdirSync(deployDir, { recursive: true });

  try {
    // 复制 web/ 目录内容
    console.log('  复制 web/ 目录...');
    execSync(`xcopy /E /I /Y /Q "${path.join(ROOT, 'web')}" "${path.join(deployDir)}"`, { stdio: 'pipe' });

    // 添加 .nojekyll 防止 GitHub Pages 的 Jekyll 处理
    fs.writeFileSync(path.join(deployDir, '.nojekyll'), '');

    // 初始化 git 并推送
    console.log('  初始化 Git 仓库...');
    execSync('git init', { cwd: deployDir, stdio: 'pipe' });
    execSync('git config user.name "Jaron"', { cwd: deployDir });
    execSync('git config user.email "jiahe.zheng@outlook.com"', { cwd: deployDir });
    execSync('git add -A', { cwd: deployDir, stdio: 'pipe' });

    // 检查是否有文件可提交
    try {
      execSync('git commit -m "deploy: 疲劳检测系统部署到 GitHub Pages"', { cwd: deployDir, stdio: 'pipe' });
    } catch {
      console.log('  (没有新提交，继续推送)');
    }

    // 强制推送到 gh-pages 分支（git init 默认分支名随版本可能是 master 或 main）
    console.log('  推送到 gh-pages 分支...');
    const pushResult = spawnSync('git', ['push', '--force', remoteUrl, 'master:gh-pages'], {
      cwd: deployDir,
      stdio: 'pipe',
      encoding: 'utf8',
    });

    if (pushResult.status !== 0 && !(pushResult.stdout || '').includes('Everything up-to-date')) {
      // 尝试 main 分支
      const pushResult2 = spawnSync('git', ['push', '--force', remoteUrl, 'main:gh-pages'], {
        cwd: deployDir,
        stdio: 'pipe',
        encoding: 'utf8',
      });

      if (pushResult2.status !== 0 && !(pushResult2.stdout || '').includes('Everything up-to-date')) {
        // 抛出而非 process.exit：finally 清理仍会执行
        throw new Error('推送失败: ' + redact((pushResult.stderr || pushResult2.stderr || '').trim()));
      }
    }
    console.log('  ✓ 代码已推送到 gh-pages 分支');

    // 6. 启用 GitHub Pages
    console.log('');
    console.log('[5] 启用 GitHub Pages...');

    const pagesResp = await ghRequest('POST', `/repos/${username}/${REPO_NAME}/pages`, {
      source: { branch: 'gh-pages', path: '/' },
    });

    if (pagesResp.status === 201) {
      console.log('  ✓ GitHub Pages 已启用');
    } else if (pagesResp.status === 422) {
      console.log('  Pages 可能已启用，尝试更新...');
      const updateResp = await ghRequest('PUT', `/repos/${username}/${REPO_NAME}/pages`, {
        source: { branch: 'gh-pages', path: '/' },
      });
      if (updateResp.status === 200) {
        console.log('  ✓ GitHub Pages 已更新');
      } else {
        console.log('  (Pages 可能已启用)');
      }
    } else {
      console.log(`  Pages 响应: ${pagesResp.status}`, pagesResp.data.message || '');
    }

    // 7. 获取 Pages URL
    console.log('');
    console.log('[6] 获取访问链接...');
    const pagesInfo = await ghRequest('GET', `/repos/${username}/${REPO_NAME}/pages`);
    const pagesUrl = pagesInfo.data.html_url || `https://${username}.github.io/${REPO_NAME}/`;

    console.log('');
    console.log('══════════════════════════════════════════════════════');
    console.log('  ✓ 部署完成！');
    console.log('══════════════════════════════════════════════════════');
    console.log('');
    console.log('  访问链接: ' + pagesUrl);
    console.log('  仓库地址: https://github.com/' + username + '/' + REPO_NAME);
    console.log('');
    console.log('  注意: GitHub Pages 首次部署可能需要 1-2 分钟生效。');
    console.log('');
  } finally {
    /* 无条件清理临时部署目录（含其 .git）。旧版失败路径直接退出，
     * 目录残留在磁盘上；现在无论成功、抛错还是 API 非致命异常都清掉。 */
    try {
      if (fs.existsSync(deployDir)) execSync(`rd /s /q "${deployDir}"`, { cwd: ROOT, stdio: 'pipe' });
    } catch {
      /* 清理失败不阻断主流程 */
    }
  }
}

main().catch((e) => {
  console.error('部署失败:', redact(e.message));
  process.exit(1);
});
