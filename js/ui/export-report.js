/**
 * export-report.js — 报告页三种导出（JSON / CSV / 自包含 HTML）
 *
 * 导出与会话生命周期无关，只依赖 SessionRecorder 的数据与当前报告页 DOM。
 */

import { downloadFile, timestampName } from '../core/recorder.js';
import { toastOk, toastWarn } from './toast.js';

/* 无采样数据时导出只会得到空文件，统一在这里拦截 */
function assertHasData(recorder) {
  if (!recorder || !recorder.samples || recorder.samples.length === 0) {
    toastWarn('暂无可导出的数据', '先完成一次检测，或用演示模式跑一遍');
    return false;
  }
  return true;
}

/**
 * 从已加载的 CSS 规则文本中提取 :root 选择器内定义的 CSS 变量值。
 * 报告导出固定浅色主题，因此只需要 :root（不带属性选择器）的值。
 * 不通过 DOM 读取（如临时修改 data-theme 后 getComputedStyle）：
 * ReportView 注册了 MutationObserver 监听 data-theme 属性，
 * 临时修改会异步触发 redraw()，在导出期间引入不必要的状态干扰。
 * 从 CSS 文本直接解析完全零副作用，且结果与浅色主题的实际值一致。
 */
function extractLightVars(cssText, vars) {
  // 匹配第一个不带属性选择器的 :root { ... } 块
  const rootMatch = cssText.match(/(^|[\s}]):root\s*\{([^}]*)\}/);
  const rootBody = rootMatch ? rootMatch[2] : '';
  const parts = [];
  for (const v of vars) {
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

/* 导出指标时序 CSV（UTF-8 BOM + 中文表头，Excel 双击可开） */
export function exportSessionCsv(recorder) {
  if (!assertHasData(recorder)) return;
  const csv = recorder.toCSV();
  downloadFile(timestampName('疲劳检测指标', 'csv'), csv, 'text/csv;charset=utf-8');
  toastOk('已导出 CSV', '可直接用 Excel 打开绘图');
}

/* 重入锁：防止连点导致主题时序错乱 */
let exporting = false;

/**
 * 把报告页序列化为独立 HTML 文件直接下载，无需弹出打印对话框。
 * Canvas 图表转为 base64 data URL 内联，CSS 从已加载的样式表提取后内联，
 * 结果是一个可以在任何浏览器里双击打开的自包含报告文件。
 */
export async function exportReportHtml(recorder) {
  if (!assertHasData(recorder)) return;
  // 连点/双击防护：第二次会在第一次临时切浅色期间读到错误的主题状态
  if (exporting) return;
  exporting = true;
  try {
    await exportReportHtmlUnsafe(recorder);
  } finally {
    exporting = false;
  }
}

async function exportReportHtmlUnsafe(recorder) {

  /* 导出主题对齐：截图前把页面临时切到浅色，等 canvas 重绘为浅色版本再取位图，
   * 取完立刻恢复。canvas 位图是主题敏感的，深色主题下冻结的深色元素
   * 在白底导出文件上会成为缺陷。 */
  const rootEl = document.documentElement;
  const prevTheme = rootEl.getAttribute('data-theme');
  const flipped = prevTheme !== 'light';
  if (flipped) {
    rootEl.setAttribute('data-theme', 'light');
    // 等待 observer 回调触发 redraw() 重绘 canvas 后再取位图
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
    // 位图必须在浅色窗口内截取
    canvasUrls = [...reportEl.querySelectorAll('canvas')].map((c) => c.toDataURL('image/png'));
  } finally {
    if (flipped) {
      if (prevTheme === null) rootEl.removeAttribute('data-theme');
      else rootEl.setAttribute('data-theme', prevTheme);
    }
  }
  // 把 Canvas 元素替换成等尺寸的 <img>（base64），避免跨上下文丢失图像
  const clone = reportEl.cloneNode(true);

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

  /* 专家区块统一按「专业版详细报告」导出：无论导出时专业模式开关如何，
   * HTML 报告都包含全部专业数据区块。页面上开关只影响在线浏览口径，
   * 导出物是归档/交付文件，始终给最完整的数据。
   * 空壳折叠：分析未运行时结果容器为空，整卡替换为一行紧凑说明。 */
  const PRO_RESULT_HOSTS = ['#sensTable', '#sensConclusion', '#replayResult', '#evalResult'];
  for (const card of [...clone.querySelectorAll('.card.pro-only')]) {
    const hasResult = PRO_RESULT_HOSTS.some((sel) => {
      const host = card.querySelector(sel);
      if (!host) return false;
      return (host.textContent || '').trim().length > 0 || host.children.length > 0;
    });
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

  /* 副标题统一详细口径：普通模式下省略采样点数，导出时补齐 */
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

  // 收集当前页面所有已加载的 CSS 文本
  let cssText = '';
  for (const sheet of document.styleSheets) {
    try {
      cssText += Array.from(sheet.cssRules).map((r) => r.cssText).join('\n') + '\n';
    } catch {
      // 跨域样式表无法读取，跳过
    }
  }

  // 提取浅色主题的 CSS 变量定义
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

  /* 导出 body 强制带 pro-mode：内联 CSS 依赖 body.pro-mode 后代选择器
   * 恢复 .pro-only 显示，无论导出时开关状态如何。 */
  const bodyStateClass = [
    ...new Set(
      document.body.className
        .split(/\s+/)
        .filter((c) => c && c !== 'has-motion')
        .concat(['pro-mode'])
    ),
  ].join(' ');

  const title = document.getElementById('rpTitle')?.textContent || '疲劳检测报告';
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
body{background:var(--bg,#f4f4f4)!important;}
#viewReport{display:block!important;max-width:1440px;margin:0 auto;padding:28px 24px 48px;}
.card{border:1px solid #d9d9de!important;border-radius:var(--r-lg,14px);}
.global-nav,.subnav,.controls,.alarm-veil,.toast-host,.no-print{display:none!important;}
.view{display:block!important;}
[data-reveal]{opacity:1!important;transform:none!important;filter:none!important;}
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
