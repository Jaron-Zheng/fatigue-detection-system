// download-tools.cjs — 下载打包所需工具（Inno Setup + Node.js portable + 中文语言文件）
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PACK_DIR = path.join(__dirname, '..', '_pack');
const NODE_DIR = path.join(PACK_DIR, 'node');
const INNO_DIR = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6');

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest, redirects + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (e) => {
      file.close();
      try { fs.unlinkSync(dest); } catch {}
      reject(e);
    });
  });
}

async function step1_downloadNode() {
  console.log('[1] 下载 Node.js 22 portable...');
  const nodeUrl = 'https://nodejs.org/dist/v22.17.0/node-v22.17.0-win-x64.zip';
  const zipPath = path.join(PACK_DIR, 'node.zip');
  
  if (fs.existsSync(path.join(NODE_DIR, 'node.exe'))) {
    console.log('  已存在，跳过');
    return;
  }

  console.log(`  下载 ${nodeUrl}...`);
  await download(nodeUrl, zipPath);
  console.log(`  ✓ 下载完成 (${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)`);
  
  // 解压
  console.log('  解压中...');
  fs.mkdirSync(NODE_DIR, { recursive: true });
  execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${PACK_DIR}\\node-tmp' -Force"`, { stdio: 'inherit' });
  // 移动内容（node-v22... 目录 → node 目录）
  const subDir = fs.readdirSync(path.join(PACK_DIR, 'node-tmp')).find(d => d.startsWith('node-v'));
  if (subDir) {
    const src = path.join(PACK_DIR, 'node-tmp', subDir);
    // 移动所有文件
    for (const item of fs.readdirSync(src)) {
      const from = path.join(src, item);
      const to = path.join(NODE_DIR, item);
      fs.renameSync(from, to);
    }
    fs.rmdirSync(src);
  }
  fs.rmdirSync(path.join(PACK_DIR, 'node-tmp'));
  fs.unlinkSync(zipPath);
  console.log(`  ✓ Node.js: ${path.join(NODE_DIR, 'node.exe')}`);
}

async function step2_installInnoSetup() {
  console.log('[2] 安装 Inno Setup 6...');
  
  if (fs.existsSync(path.join(INNO_DIR, 'ISCC.exe'))) {
    console.log('  已存在，跳过');
  } else {
    const innoUrl = 'https://jrsoftware.org/download.php/is.exe';
    const innoInstaller = path.join(PACK_DIR, 'innosetup.exe');
    console.log(`  下载 ${innoUrl}...`);
    await download(innoUrl, innoInstaller);
    console.log(`  ✓ 下载完成 (${(fs.statSync(innoInstaller).size / 1024 / 1024).toFixed(1)} MB)`);
    
    // 静默安装
    console.log('  安装中（静默）...');
    execSync(`"${innoInstaller}" /VERYSILENT /CURRENTUSER /NORESTART`, { stdio: 'inherit' });
    fs.unlinkSync(innoInstaller);
    console.log(`  ✓ Inno Setup: ${path.join(INNO_DIR, 'ISCC.exe')}`);
  }

  // 中文语言文件
  const islPath = path.join(INNO_DIR, 'Languages', 'ChineseSimplified.isl');
  if (!fs.existsSync(islPath)) {
    console.log('  下载中文语言文件...');
    const islUrl = 'https://raw.githubusercontent.com/jrsoftware/issrc/main/Files/Languages/ChineseSimplified.isl';
    const islData = await new Promise((resolve, reject) => {
      https.get(islUrl, (res) => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
    fs.mkdirSync(path.dirname(islPath), { recursive: true });
    fs.writeFileSync(islPath, islData);
    console.log(`  ✓ 中文语言文件: ${islPath} (${islData.length} bytes)`);
  } else {
    console.log('  中文语言文件已存在');
  }
}

async function step3_installPostject() {
  console.log('[3] 安装 postject（SEA 注入工具）...');
  const postjectPath = path.join(NODE_DIR, 'node_modules', 'postject', 'dist', 'cli.js');
  if (fs.existsSync(postjectPath)) {
    console.log('  已存在，跳过');
    return;
  }
  execSync(`"${path.join(NODE_DIR, 'npm.cmd')}" install postject`, {
    cwd: NODE_DIR,
    stdio: 'inherit',
  });
  console.log('  ✓ postject 已安装');
}

async function main() {
  fs.mkdirSync(PACK_DIR, { recursive: true });
  await step1_downloadNode();
  await step2_installInnoSetup();
  await step3_installPostject();
  console.log('\n✓ 所有工具准备就绪！');
}

main().catch(e => {
  console.error('错误:', e.message);
  process.exit(1);
});
