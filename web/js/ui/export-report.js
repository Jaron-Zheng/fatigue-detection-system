/**
 * export-report.js — 报告页三种导出（JSON / CSV / 自包含 HTML）
 *
 * 第三轮角色二从 app.js 拆出。导出与会话生命周期无关，
 * 只依赖 SessionRecorder 的数据与当前报告页 DOM。
 */

import { downloadFile, timestampName } from '../core/recorder.js';
import { toastOk, toastWarn } from './toast.js';

/** 无采样数据时导出只会得到空文件，统一在这里拦截 */
function assertHasData(recorder) {
  if (!recorder || !recorder.samples || recorder.samples.length === 0) {
    toastWarn('暂无可导出的数据', '先完成一次检测，或用演示模式跑一遍');
    return false;
  }
  return true;
}

/**
 * 从已加载的 CSS 规则文本中提取 :root 选择器内定义的 CSS 变量值。
 *
 * tokens.css 的结构：
 *   :root { --bg: #f4f4f4; ... }          ← 浅色默认值
 *   :root[data-theme='dark'] { ... }       ← 手动深色覆盖
 *   @media (prefers-color-scheme: dark) {
 *     :root:not([data-theme='light']) { ... }  ← 系统深色
 *   }
 *
 * 报告导出固定浅色主题，因此只需要 :root（不带属性选择器）的值。
 * 解析方式：用正则匹配第一个 :root { ... } 块的内容，
 * 再从其中逐条提取 --var: value; 对。
 *
 * 之所以不通过 DOM 读取（如临时修改 data-theme 后 getComputedStyle）：
 * ReportView 注册了 MutationObserver 监听 documentElement 的 data-theme
 * 属性，临时修改会异步触发 redraw()，在导出期间引入不必要的状态干扰。
 * 从 CSS 文本直接解析完全零副作用，且结果与浅色主题的实际值一致。
 */
function extractLightVars(cssText, vars) {
  // 匹配第一个不带属性选择器的 :root { ... } 块
  // 排除 :root[data-theme=...] 和 :root:not(...)
  const rootMatch = cssText.match(/(^|[\s}]):root\s*\{([^}]*)\}/);
  const rootBody = rootMatch ? rootMatch[2] : '';
  const parts = [];
  for (const v of vars) {
    // 在 :root 块内查找该变量的定义
    const re = new RegExp(`${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([^;]+);`);
    const m = rootBody.match(re);
    if (m) parts.push(`${v}:${m[1].trim()}`);
  }
  return parts.join(';');
}

/**
 * 导出完整 JSON（参数、汇总、采样序列、事件列表）。
 * @param {import('../core/recorder.js').SessionRecorder} recorder
 * @param {object} ctx { lastInd, lastFusion, meta: { delegate, avgMs, frames } }
 */
export function exportSessionJson(recorder, ctx) {
  if (!assertHasData(recorder)) return;
  const data = recorder.toJSON(ctx.lastInd, ctx.lastFusion, ctx.meta);
  downloadFile(timestampName('疲劳检测报告', 'json'), JSON.stringify(data, null, 2), 'application/json');
  toastOk('已导出 JSON', `${data.samples.length} 个采样点 · ${data.events.length} 条事件`);
}

/** 导出指标时序 CSV（UTF-8 BOM + 中文表头，Excel 双击可开） */
export function exportSessionCsv(recorder) {
  if (!assertHasData(recorder)) return;
  const csv = recorder.toCSV();
  downloadFile(timestampName('疲劳检测指标', 'csv'), csv, 'text/csv;charset=utf-8');
  toastOk('已导出 CSV', '可直接用 Excel 打开绘图');
}

/** exportReportHtml 重入锁（见函数内说明） */
let exporting = false;

/**
 * 把报告页序列化为独立 HTML 文件直接下载，无需弹出打印对话框。
 * Canvas 图表转为 base64 data URL 内联，CSS 从已加载的样式表提取后内联，
 * 结果是一个可以在任何浏览器里双击打开的自包含报告文件。
 */
export async function exportReportHtml(recorder) {
  /* HTML 报告此前无数据校验（JSON/CSV 有 assertHasData 而 HTML 没有）：
   * 用户不跑检测直接进报告页点「下载报告」，会得到一份全空壳的
   * "成功"下载 + 绿色 toast——正是混沌测试里"没完成测试就能下载报告"的漏洞。 */
  if (!assertHasData(recorder)) return;
  // 连点/双击：第二次会在第一次临时切浅色期间读到 prevTheme='light'，恢复主题时序错乱、截到深色 canvas
  if (exporting) return;
  exporting = true;
  try {
    await exportReportHtmlUnsafe(recorder);
  } finally {
    exporting = false;
  }
}

async function exportReportHtmlUnsafe(recorder) {

  /* 【导出主题对齐】canvas 位图是主题敏感的：会话在深色主题下渲染报告时，
   * 阈值参考线标签的底衬（--bg-elevated 取深色值）、网格与轴色全部以
   * 深色配色冻结进 canvas。导出文件强制浅色主题后，这些深色元素在白底
   * 上就成了缺陷（实测：指数曲线右侧「轻度/中度/重度」标签带黑底）。
   * 因此截图前把页面临时切到浅色，等 report 的 MutationObserver 触发
   * redraw()（同步重绘 canvas）画完浅色版本再取位图，取完立刻恢复。
   * redraw() 在 hasReport=true 时按缓存数据幂等重绘、不清数据，
   * 临时切换不影响在线页面状态。CSS 变量仍走下方文本提取路线，
   * 与这个临时切换互不依赖（见 extractLightVars 注释）。 */
  const rootEl = document.documentElement;
  const prevTheme = rootEl.getAttribute('data-theme');
  const flipped = prevTheme !== 'light';
  if (flipped) {
    rootEl.setAttribute('data-theme', 'light');
    // observer 回调走微任务、redraw() 内部同步绘制；双 rAF 只作裕量
    // 被遮挡/后台窗口里 rAF 可能长时间不触发（主题会一直停在被翻转的浅色且无下载）：300ms 兜底
    await new Promise((r) => {
      const fallback = setTimeout(r, 300);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          clearTimeout(fallback);
          r();
        }),
      );
    });
  }
  const reportEl = document.getElementById('viewReport');
  let canvasUrls;
  try {
    // 位图必须在浅色窗口内截取；尺寸与主题无关，替换时再读
    canvasUrls = [...reportEl.querySelectorAll('canvas')].map((c) => c.toDataURL('image/png'));
  } finally {
    if (flipped) {
      if (prevTheme === null) rootEl.removeAttribute('data-theme');
      else rootEl.setAttribute('data-theme', prevTheme);
    }
  }
  // 把 Canvas 元素替换成等尺寸的 <img>（base64），避免跨上下文丢失图像
  const clone = reportEl.cloneNode(true);

  // 复制 Canvas 内容为 img
  reportEl.querySelectorAll('canvas').forEach((canvas, i) => {
    const img = clone.querySelectorAll('canvas')[i];
    if (!img) return;
    const replacement = document.createElement('img');
    replacement.src = canvasUrls[i];
    replacement.style.cssText = `width:100%;height:${canvas.offsetHeight}px;display:block;`;
    img.replaceWith(replacement);
  });

  // 移除不需要打印的按钮区域
  clone.querySelectorAll('.no-print').forEach((el) => el.remove());

  /* 专家区块统一按「专业版详细报告」导出（用户 2026-08 需求变更：
   * 无论导出时专业模式开关如何，HTML 报告都包含全部专业数据区块。
   * 页面上的开关只影响在线浏览口径，导出物是归档/交付文件，
   * 始终给最完整的数据）。
   *
   * 空壳折叠仍然保留：敏感性分析/离线复现/视频评测三张卡在
   * 「分析未运行」时结果是空的，原样导出会得到带标题的大白板卡。
   * 规则：卡内不存在任何"有内容的结果容器"就把整卡替换为一行
   * 紧凑说明。结果容器由各卡自身的渲染逻辑填充
   * （表格行/结论文本/结果块），空 = 未运行。 */
  const PRO_RESULT_HOSTS = ['#sensTable', '#sensConclusion', '#replayResult', '#evalResult'];
  for (const card of [...clone.querySelectorAll('.card.pro-only')]) {
    const hasResult = PRO_RESULT_HOSTS.some((sel) => {
      const host = card.querySelector(sel);
      if (!host) return false;
      return (host.textContent || '').trim().length > 0 || host.children.length > 0;
    });
    // 「检测参数与环境」的结果就是 #rpParams 表本身，有数据行即保留；
    // 不认 .field-row——那是评测卡的输入控件行，不代表跑出了结果
    const hasRows = card.querySelectorAll('.tbl tr, #rpParams tr').length > 0;
    if (!hasResult && !hasRows) {
      const title = (card.querySelector('h3, .card-title')?.textContent || '专业分析').trim();
      const note = document.createElement('p');
      note.className = 't-tertiary';
      note.style.cssText = 'margin:0;padding:14px 20px;font-size:13px;';
      note.textContent = `「${title}」本次会话未运行，无导出数据（在线页面上运行后重新导出即可包含结果）`;
      card.replaceWith(note);
    }
  }

  /* 副标题统一详细口径：普通模式下在线页面的副标题省略采样点数
   * （report.js 按 pro-mode 分流），导出统一为专业版时补齐，
   * 保证导出文件之间口径一致。 */
  const subtitleEl = clone.querySelector('#rpSubtitle');
  if (
    subtitleEl &&
    recorder &&
    recorder.samples &&
    recorder.samples.length > 0 &&
    !subtitleEl.textContent.includes('个采样点')
  ) {
    subtitleEl.textContent = subtitleEl.textContent.replace(
      /(持续\s[^·]+?)\s·/,
      `$1 · ${recorder.samples.length} 个采样点 ·`
    );
  }

  // 收集当前页面所有已加载的 CSS 文本（内联样式表 + <link> 表）
  let cssText = '';
  for (const sheet of document.styleSheets) {
    try {
      cssText += Array.from(sheet.cssRules).map((r) => r.cssText).join('\n') + '\n';
    } catch {
      // 跨域样式表无法读取，跳过
    }
  }

  // 复制 CSS 变量当前计算值解析进来（确保颜色正确）。
  // 报告导出固定浅色主题：打印场景需要白底黑字，且导出文件里
  // body 背景被强制为白色，若沿用深色主题的变量会出现深色卡片
  // 叠在白底上的"花屏"。
  //
  // 提取方式：从已加载的 CSS 规则文本中解析 :root 的浅色变量定义。
  // 不通过 getComputedStyle 现读的原因：导出全程可能带着上面那次
  // 临时主题切换，文本提取的结果只取决于 tokens.css 本身、与切换
  // 时序无关；ReportView 的 MutationObserver 也不会被触发。
  const vars = [
    '--bg','--bg-elevated','--bg-inset','--bg-sunken','--text','--text-secondary',
    '--text-tertiary','--text-quaternary','--accent','--accent-soft','--separator',
    '--separator-soft','--fill-quaternary','--fill-tertiary','--ok','--ok-soft',
    '--warn','--warn-soft','--caution','--caution-soft','--danger','--danger-soft',
    '--lv-awake','--lv-mild','--lv-moderate','--lv-severe','--on-lv',
    '--chart-score','--chart-ear','--chart-mar',
    '--sp-2','--sp-3','--sp-4','--sp-5','--sp-6','--sp-8',
    '--r-sm','--r-md','--r-lg','--r-xl',
    '--fs-hero','--fs-title','--fs-headline','--fs-subhead','--fs-body',
    '--fs-callout','--fs-caption','--fs-micro',
  ];
  const resolvedVars = extractLightVars(cssText, vars);

  /* 导出 body 强制带 pro-mode（需求变更后的统一口径）：
   * 内联 CSS 依赖 body.pro-mode 后代选择器恢复 .pro-only 显示，
   * 无论导出时页面开关状态如何，导出文件里专业区块都必须可见。
   * 其余运行时状态类照常同步，仅剔除动画类。 */
  const bodyStateClass = [
    ...new Set(
      document.body.className
        .split(/\s+/)
        .filter((c) => c && c !== 'has-motion') // 运行时动画类不属于文档状态
        .concat(['pro-mode'])
    ),
  ].join(' ');

  const title = document.getElementById('rpTitle')?.textContent || '疲劳检测报告';
  // 标题来自页面 textContent（当前为系统生成），出口处仍做 HTML 转义：与 csvCell 同属"数据出口统一防护"
  const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

  const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
<style>
:root{${resolvedVars}}
${cssText}
/* ===== 屏幕查看：模拟站内报告页的浅灰画布 + 白卡层次 =====
   之前 body 与卡片同为纯白且边框阴影全无，打开导出文件
   白底贴白底，卡片边界消失；内容也无最大宽度约束，
   宽屏上三列卡片会被拉到 700px+/列。 */
body{background:var(--bg,#f4f4f4)!important;}
#viewReport{display:block!important;max-width:1440px;margin:0 auto;padding:28px 24px 48px;}
/* 边框一档加深：#e3e3e5 对灰底反差不足 6%，投影仪上看不清卡片边界 */
.card{border:1px solid #d9d9de!important;border-radius:var(--r-lg,14px);}
.global-nav,.subnav,.controls,.alarm-veil,.toast-host,.no-print{display:none!important;}
.view{display:block!important;}
/* 导出的 HTML 里没有 .has-motion（那是 motion.js 在运行时加的），
   起始态本就不会命中；这条只是双保险，防止将来样式调整后
   导出文件里出现"内容透明"这种最难排查的问题。 */
[data-reveal]{opacity:1!important;transform:none!important;filter:none!important;}
/* ===== 打印（含另存 PDF）：白底、防跨页断裂 =====
   保留发丝线边框：完全去边框时卡片边界消失、文字像漂在白纸上，
   答辩递纸质件/插 PDF 进 PPT 会露馅；hairline 打印出来不脏。 */
@media print{
@page{size:A4;margin:12mm 10mm;}
body{background:#fff!important;}
#viewReport{max-width:none;padding:0;}
.card{box-shadow:none!important;border:1px solid #e5e5e7!important;break-inside:avoid;}
}
</style>
</head>
<body data-theme="light"${bodyStateClass ? ` class="${bodyStateClass}"` : ''}>
${clone.outerHTML}
</body>
</html>`;

  const name = timestampName('疲劳检测报告', 'html');
  downloadFile(name, html, 'text/html;charset=utf-8');
  toastOk('报告已下载', '双击文件即可在浏览器中查看，也可打印为 PDF');
}
