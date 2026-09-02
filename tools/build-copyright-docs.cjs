#!/usr/bin/env node
/**
 * build-copyright-docs.cjs — 生成软著登记鉴别材料（HTML，再用 Playwright 打印成 PDF）
 *
 * 产出（软著材料/ 目录）：
 *   srcdoc.html  — 源程序鉴别材料：前连续30页 + 后连续30页，每页50行，
 *                  页眉含软件全称/版本号/页码（保留原始页码，中间跳页即"前30+后30"）
 *   manual.html  — 软件说明书（文档鉴别材料）：含界面截图，全文提交（<60页）
 *   img/fig*.png — 说明书用截图（从既有截图复制，自包含）
 *
 * 用法：node tools/build-copyright-docs.cjs
 * 打印：Playwright 打开 HTML → page.pdf({ format:'A4', margin:0, printBackground:true })
 *   （.page 固定 210mm×297mm，分页完全由 CSS 控制，与页数校验一一对应）
 *
 * 源程序文件顺序：config → app → core → ui → util → test-hooks → server
 *                → index.html → css（开头是核心算法逻辑，结尾是界面资源）
 * 行数口径：声明源程序量 17861 行（逻辑行）；本文档物理行含文件分隔注释与
 * 长行折行，页码按物理行每页50行计算——总页数即页眉"共 N 页"。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '软著材料');
fs.mkdirSync(path.join(OUT, 'img'), { recursive: true });

const NAME = '基于面部多特征融合的驾驶员疲劳检测系统';
const VER = 'V1.0.0';
const LINES_PER_PAGE = 50;
const PAGES_SUBMIT = 30; // 前30页 + 后30页

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- 1. 收集源文件 ---------- */
const jsDir = (rel) =>
  fs
    .readdirSync(path.join(ROOT, rel))
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => `${rel}/${f}`);

const rels = [
  'web/js/config.js',
  'web/js/app.js',
  ...jsDir('web/js/core'),
  ...jsDir('web/js/ui'),
  ...jsDir('web/js/util'),
  'web/js/test-hooks.js',
  'server/server.js',
  'web/index.html',
  ...fs
    .readdirSync(path.join(ROOT, 'web/css'))
    .filter((f) => f.endsWith('.css'))
    .sort()
    .map((f) => `web/css/${f}`),
];

/* ---------- 2. 物理行（长行按视觉宽度折行） ---------- */
// 12.5px 等宽字体：ASCII ≈ 6.9px，全角 ≈ 12.5px；内容区宽约 704px，折行阈值 660px
const chW = (ch) => (ch.charCodeAt(0) > 0xff ? 12.5 : 6.9);
const wrapLine = (line) => {
  const out = [];
  let cur = '';
  let w = 0;
  for (const ch of line) {
    const cw = chW(ch);
    if (w + cw > 660) {
      out.push(cur);
      cur = ch;
      w = cw;
    } else {
      cur += ch;
      w += cw;
    }
  }
  out.push(cur);
  return out;
};

const phys = [];
for (const rel of rels) {
  const abs = path.join(ROOT, rel);
  phys.push(`/* ===== ${rel} ===== */`);
  const text = fs
    .readFileSync(abs, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  for (const raw of text.split('\n')) {
    phys.push(...wrapLine(raw.replace(/\t/g, '  ')));
  }
}

const totalPages = Math.ceil(phys.length / LINES_PER_PAGE);

/* ---------- 3. 源程序鉴别材料 HTML ---------- */
const keptPages = [];
for (let p = 0; p < totalPages; p++) {
  if (p < PAGES_SUBMIT || p >= totalPages - PAGES_SUBMIT) keptPages.push(p);
}

let srcHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${NAME} 源程序</title><style>
@page{size:A4;margin:0}
*{box-sizing:border-box}
body{margin:0;background:#fff}
.page{width:210mm;height:297mm;padding:10mm 12mm 8mm;page-break-after:always;overflow:hidden}
.page:last-child{page-break-after:auto}
.hdr{display:flex;justify-content:space-between;align-items:baseline;
  font:500 9px/1.4 'Microsoft YaHei',sans-serif;color:#333;
  border-bottom:.75px solid #666;padding-bottom:2mm;margin-bottom:3mm}
pre{margin:0;font:12.5px/20.4px Consolas,'Courier New',monospace;
  white-space:pre;color:#111}
</style></head><body>`;

for (const p of keptPages) {
  const lines = phys.slice(p * LINES_PER_PAGE, p * LINES_PER_PAGE + LINES_PER_PAGE);
  srcHtml += `<div class="page"><div class="hdr"><span>${NAME} ${VER}</span><span>第 ${p + 1} 页 共 ${totalPages} 页</span></div><pre>${esc(lines.join('\n'))}</pre></div>`;
}
srcHtml += '</body></html>';
fs.writeFileSync(path.join(OUT, 'srcdoc.html'), srcHtml);

/* ---------- 4. 说明书截图（复制到 img/，自包含） ---------- */
const figSrc = [
  ['fig01.png', 'c:/Users/jiahe/Desktop/ppt/shots/01-hero.png'],
  ['fig02.png', 'c:/Users/jiahe/Desktop/ppt/shots/02-signals.png'],
  ['fig03.png', 'c:/Users/jiahe/Desktop/ppt/shots/03-dataflow.png'],
  ['fig04.png', 'c:/Users/jiahe/Desktop/ppt/shots/04-numbers.png'],
  ['fig05.png', 'c:/Users/jiahe/Desktop/ppt/shots/05-workbench.png'],
  ['fig06.png', 'c:/Users/jiahe/Desktop/ppt/shots/06-alarm.png'],
  ['fig07.png', 'c:/Users/jiahe/Desktop/ppt/shots/09-severe2.png'],
  ['fig08.png', 'c:/Users/jiahe/Desktop/参赛作品/竞赛材料/_work/check/03_设置抽屉.png'],
  ['fig09.png', 'c:/Users/jiahe/Desktop/ppt/shots/07-report.png'],
  ['fig10.png', 'c:/Users/jiahe/Desktop/参赛作品/竞赛材料/_work/check/07_浅色参照.png'],
  ['fig11.png', 'c:/Users/jiahe/Desktop/参赛作品/竞赛材料/_work/check/08_深色主题.png'],
];
for (const [dst, src] of figSrc) {
  fs.copyFileSync(src, path.join(OUT, 'img', dst));
}

/* ---------- 5. 软件说明书 HTML（固定页，手动分页） ---------- */
const hdr = (p, n) =>
  `<div class="hdr"><span>${NAME} ${VER}</span><span>软件说明书 · 第 ${p} 页 / 共 ${n} 页</span></div>`;

const sec = (p, n, inner) =>
  `<div class="page doc">${hdr(p, n)}${inner}</div>`;

const fig = (no, cap, file) =>
  `<figure><img src="img/${file}" alt="${cap}"><figcaption>图${no} ${cap}</figcaption></figure>`;

const pages = [];
pages.push(`<div class="page cover">
  <div class="cv"><h1>${NAME}</h1><h2>软件说明书</h2>
  <p class="ver">${VER}</p><p class="date">2026 年 8 月</p></div></div>`);

pages.push(`<div class="page doc">${hdr(2, 16)}<h2>目录</h2>
<ul class="toc">
<li>一、软件概述</li>
<li>二、运行环境</li>
<li>三、安装与启动</li>
<li>四、功能操作说明</li>
<li class="sub">4.1 首页与功能概览</li>
<li class="sub">4.2 多特征信号体系</li>
<li class="sub">4.3 数据处理流程</li>
<li class="sub">4.4 实时指标监测</li>
<li class="sub">4.5 检测工作台操作</li>
<li class="sub">4.6 疲劳分级报警</li>
<li class="sub">4.7 参数设置</li>
<li class="sub">4.8 检测报告与数据导出</li>
<li class="sub">4.9 深浅主题切换</li>
<li>五、技术特点</li>
<li>六、隐私与数据安全说明</li>
</ul></div>`);

pages.push(sec(3, 16, `<h2>一、软件概述</h2>
<p>${NAME}（${VER}）面向道路交通安全领域，基于浏览器端计算机视觉技术实现对驾驶员疲劳状态的实时监测与分级预警。软件通过摄像头采集驾驶员面部视频，在本机内完成全部面部特征提取、疲劳指标计算与疲劳分级判定，无需联网、不上传任何影像数据。</p>
<p>软件监测的眼部特征包括眼睑开合度、眨眼事件与持续闭眼时长；嘴部特征为张嘴度；头部特征为姿态角变化。多特征经加权融合后输出四级疲劳状态（清醒、轻度、中度、重度），并触发相应的声光报警，用于提醒驾驶员及时休息，降低疲劳驾驶引发的交通事故风险。</p>
<p>软件适用于车辆驾驶安全监测、驾驶行为研究、驾驶培训评估等场景，可作为车载驾驶员监测系统（DMS）的软件方案与实验平台。</p>`));

pages.push(sec(4, 16, `<h2>二、运行环境</h2>
<p><b>硬件环境：</b>配备摄像头的 PC 兼容机，Intel Core i3 及以上处理器、8GB 及以上内存。</p>
<p><b>软件环境：</b>Windows 10/Windows 11、macOS 等主流桌面操作系统；Google Chrome、Microsoft Edge、Mozilla Firefox 等现代 Web 浏览器（需支持 WebAssembly）。</p>
<p><b>网络环境：</b>全部模型与资源本地内置，可完全离线运行；检测数据不经网络传输。</p>`));

pages.push(sec(5, 16, `<h2>三、安装与启动</h2>
<p><b>方式一（免安装）：</b>解压软件目录后，双击"一键启动.bat"，系统自动启动本地服务并调起默认浏览器进入软件首页。</p>
<p><b>方式二（安装包）：</b>运行"疲劳检测系统_Setup_v1.0.0.exe"，按安装向导完成安装，从开始菜单或桌面快捷方式启动。</p>
<p>首次使用检测功能时，浏览器会请求摄像头权限，点击"允许"即可。若 15 秒内未授权，软件提供手动重试入口。</p>`));

pages.push(sec(6, 16, `<h2>四、功能操作说明</h2>
<h3>4.1 首页与功能概览</h3>
<p>启动后进入首页，展示系统核心能力、技术指标与功能入口。点击主操作按钮进入检测工作台开始使用。</p>
${fig(1, '软件首页', 'fig01.png')}`));

pages.push(sec(7, 16, `<h3>4.2 多特征信号体系</h3>
<p>软件实时提取眼部、嘴部与头部三类特征信号：眼睑开合度（EAR）、张嘴度（MAR）与头部姿态角，构成疲劳判定的多通道数据基础。</p>
${fig(2, '多特征信号体系示意', 'fig02.png')}`));

pages.push(sec(8, 16, `<h3>4.3 数据处理流程</h3>
<p>视频帧经面部关键点检测后计算几何特征，滑动时间窗聚合为疲劳指标，融合与平滑后输出疲劳指数与等级，全程在本机内存中完成。</p>
${fig(3, '数据处理流程', 'fig03.png')}`));

pages.push(sec(9, 16, `<h3>4.4 实时指标监测</h3>
<p>工作台实时显示 PERCLOS、眨眼频率、眼睑开合度等指标数值与疲劳指数，以仪表和曲线形式呈现当前状态。</p>
${fig(4, '实时指标监测', 'fig04.png')}`));

pages.push(sec(10, 16, `<h3>4.5 检测工作台操作</h3>
<p>工作台分视频画面区、状态指示区与操作控制区。画面区叠加面部关键点网格：常态为白色单线稿，闭眼事件以红色标注、张嘴事件以黄色标注。使用控制区按钮完成开始、暂停、恢复、结束检测，空格键可快捷暂停。</p>
${fig(5, '检测工作台', 'fig05.png')}`));

pages.push(sec(11, 16, `<h3>4.6 疲劳分级报警</h3>
<p>疲劳程度达到轻度、中度时，界面出现对应等级的色彩警示并伴随提示音；达到重度时触发全屏强提示，明确建议驾驶员停车休息。</p>
${fig(6, '疲劳分级报警', 'fig06.png')}
${fig(7, '重度疲劳全屏强提示', 'fig07.png')}`));

pages.push(sec(12, 16, `<h3>4.7 参数设置</h3>
<p>点击导航栏设置图标打开设置面板，可调节闭眼判定阈值、轻度/重度疲劳分界、平滑系数、危险闭眼时长等五项核心算法参数。所有参数内置钳制保护，超出安全范围的输入会被自动约束，避免误配置导致误报。</p>
${fig(8, '参数设置面板', 'fig08.png')}`));

pages.push(sec(13, 16, `<h3>4.8 检测报告与数据导出</h3>
<p>检测结束后进入报告页，查看疲劳指数时序曲线、分级时间占比与报警事件记录，并可导出 CSV、JSON、HTML 三种格式的检测报告。另有离线评测模式，可加载录制视频或 CSV 数据回放，输出准确率、灵敏度、特异度与混淆矩阵等统计指标。</p>
${fig(9, '检测报告页', 'fig09.png')}`));

pages.push(sec(14, 16, `<h3>4.9 深浅主题切换</h3>
<p>软件支持深色与浅色双主题，可跟随系统自动切换或手动设定，满足不同光照环境下的使用需求。</p>
${fig(10, '浅色主题', 'fig10.png')}
${fig(11, '深色主题', 'fig11.png')}`));

pages.push(sec(15, 16, `<h2>五、技术特点</h2>
<p>（1）全部推理在浏览器本地完成（WebAssembly 加速），影像数据不落盘、不上传，检测会话结束即释放，保护用户隐私。</p>
<p>（2）双通道多特征加权融合与指数平滑算法，输出四级疲劳状态，兼顾灵敏度与误报控制。</p>
<p>（3）工程化质量验证：175 项回归测试、41 项集成与安全测试、20 个混沌对抗场景全部通过，实验图表支持脚本一键复现。</p>
<p>（4）五项核心算法参数开放调节并带钳制保护，支持个体化标定。</p>
<p>（5）界面遵循主流人机界面设计规范，支持深浅双主题与响应式布局。</p>`));

pages.push(sec(16, 16, `<h2>六、隐私与数据安全说明</h2>
<p>本软件视频流仅在内存中处理，任何影像数据不写入磁盘、不经网络传输。导出的检测报告仅包含数值型指标（疲劳指数、PERCLOS、事件时间戳等），不含图像内容。软件运行无需互联网连接（模型资源本地内置），可在完全离线环境中使用。</p>`));

const manualHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${NAME} 软件说明书</title><style>
@page{size:A4;margin:0}
*{box-sizing:border-box}
body{margin:0;background:#fff}
.page{width:210mm;height:297mm;padding:10mm 15mm 8mm;page-break-after:always;overflow:hidden}
.page:last-child{page-break-after:auto}
.hdr{display:flex;justify-content:space-between;align-items:baseline;
  font:500 9px/1.4 'Microsoft YaHei',sans-serif;color:#333;
  border-bottom:.75px solid #666;padding-bottom:2mm;margin-bottom:4mm}
.cover{display:flex;align-items:center;justify-content:center;text-align:center}
.cv h1{font:600 30px/1.5 'Microsoft YaHei';margin:0 0 12mm;color:#111}
.cv h2{font:500 20px/1.5 'Microsoft YaHei';margin:0 0 20mm;color:#333}
.cv .ver{font:500 16px/1.5 'Microsoft YaHei';color:#333;margin:0}
.cv .date{font:400 14px/1.5 'Microsoft YaHei';color:#555;margin:6mm 0 0}
.doc h2{font:600 17px/1.6 'Microsoft YaHei';margin:0 0 4mm;color:#111}
.doc h3{font:600 14px/1.6 'Microsoft YaHei';margin:0 0 2mm;color:#222}
.doc p{font:400 12.5px/1.9 'Microsoft YaHei';margin:0 0 2.5mm;color:#222;text-align:justify}
.toc{list-style:none;padding:0;margin:4mm 0}
.toc li{font:400 12.5px/2.1 'Microsoft YaHei';color:#222}
.toc li.sub{padding-left:8mm;color:#444}
figure{margin:2mm 0 0}
figure img{display:block;width:100%;max-height:78mm;object-fit:contain;border:.75px solid #ccc}
figcaption{text-align:center;font:400 10px/1.6 'Microsoft YaHei';color:#555;margin:1.5mm 0 0}
</style></head><body>${pages.join('')}</body></html>`;

fs.writeFileSync(path.join(OUT, 'manual.html'), manualHtml);

console.log(
  JSON.stringify({
    源文件数: rels.length,
    物理总行数: phys.length,
    源程序总页数: totalPages,
    提交页码: `第1-${PAGES_SUBMIT}页 + 第${totalPages - PAGES_SUBMIT + 1}-${totalPages}页`,
    说明书页数: pages.length,
    输出目录: OUT,
  })
);
