/**
 * export-report.js — 报告页三种导出（JSON / CSV / 自包含 HTML）
 *
 * 第三轮角色二从 app.js 拆出。导出与会话生命周期无关，
 * 只依赖 SessionRecorder 的数据与当前报告页 DOM。
 */

import { downloadFile, timestampName } from '../core/recorder.js';
import { toastOk } from './toast.js';

/**
 * 导出完整 JSON（参数、汇总、采样序列、事件列表）。
 * @param {import('../core/recorder.js').SessionRecorder} recorder
 * @param {object} ctx { lastInd, lastFusion, meta: { delegate, avgMs, frames } }
 */
export function exportSessionJson(recorder, ctx) {
  const data = recorder.toJSON(ctx.lastInd, ctx.lastFusion, ctx.meta);
  downloadFile(timestampName('疲劳检测报告', 'json'), JSON.stringify(data, null, 2), 'application/json');
  toastOk('已导出 JSON', `${data.samples.length} 个采样点 · ${data.events.length} 条事件`);
}

/** 导出指标时序 CSV（UTF-8 BOM + 中文表头，Excel 双击可开） */
export function exportSessionCsv(recorder) {
  const csv = recorder.toCSV();
  downloadFile(timestampName('疲劳检测指标', 'csv'), csv, 'text/csv;charset=utf-8');
  toastOk('已导出 CSV', '可直接用 Excel 打开绘图');
}

/**
 * 把报告页序列化为独立 HTML 文件直接下载，无需弹出打印对话框。
 * Canvas 图表转为 base64 data URL 内联，CSS 从已加载的样式表提取后内联，
 * 结果是一个可以在任何浏览器里双击打开的自包含报告文件。
 */
export async function exportReportHtml() {
  // 把 Canvas 元素替换成等尺寸的 <img>（base64），避免跨上下文丢失图像
  const reportEl = document.getElementById('viewReport');
  const clone = reportEl.cloneNode(true);

  // 复制 Canvas 内容为 img
  reportEl.querySelectorAll('canvas').forEach((canvas, i) => {
    const img = clone.querySelectorAll('canvas')[i];
    if (!img) return;
    const dataUrl = canvas.toDataURL('image/png');
    const replacement = document.createElement('img');
    replacement.src = dataUrl;
    replacement.style.cssText = `width:100%;height:${canvas.offsetHeight}px;display:block;`;
    img.replaceWith(replacement);
  });

  // 移除不需要打印的按钮区域
  clone.querySelectorAll('.no-print').forEach((el) => el.remove());

  // 收集当前页面所有已加载的 CSS 文本（内联样式表 + <link> 表）
  let cssText = '';
  for (const sheet of document.styleSheets) {
    try {
      cssText += Array.from(sheet.cssRules).map((r) => r.cssText).join('\n') + '\n';
    } catch {
      // 跨域样式表无法读取，跳过
    }
  }

  // 把 CSS 变量当前计算值解析进来（确保颜色正确）
  const computed = getComputedStyle(document.documentElement);
  const vars = [
    '--bg','--bg-elevated','--bg-inset','--bg-sunken','--text','--text-secondary',
    '--text-tertiary','--text-quaternary','--accent','--accent-soft','--separator',
    '--separator-soft','--fill-quaternary','--fill-tertiary','--ok','--ok-soft',
    '--warn','--warn-soft','--caution','--caution-soft','--danger','--danger-soft',
    '--lv-awake','--lv-mild','--lv-moderate','--lv-severe',
    '--chart-score','--chart-ear','--chart-mar',
    '--sp-2','--sp-3','--sp-4','--sp-5','--sp-6','--sp-8',
    '--r-sm','--r-md','--r-lg','--r-xl',
    '--fs-hero','--fs-title','--fs-headline','--fs-subhead','--fs-body',
    '--fs-callout','--fs-caption','--fs-micro',
  ];
  const resolvedVars = vars.map((v) => `${v}:${computed.getPropertyValue(v).trim()}`).join(';');

  const title = document.getElementById('rpTitle')?.textContent || '疲劳检测报告';

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{${resolvedVars}}
${cssText}
/* 打印专用：去掉浏览器自动加的页眉/页脚/边框 */
@page{size:A4;margin:12mm 10mm;}
body{background:#fff!important;color:#1d1d1f!important;}
.card{box-shadow:none!important;border:none!important;break-inside:avoid;}
.global-nav,.subnav,.controls,.alarm-veil,.alarm-banner,.toast-host,.no-print{display:none!important;}
#viewReport{display:block!important;}
.view{display:block!important;}
/* 导出的 HTML 里没有 .has-motion（那是 motion.js 在运行时加的），
   起始态本就不会命中；这条只是双保险，防止将来样式调整后
   导出文件里出现"内容透明"这种最难排查的问题。 */
[data-reveal]{opacity:1!important;transform:none!important;filter:none!important;}
</style>
</head>
<body data-theme="light">
${clone.outerHTML}
</body>
</html>`;

  const name = timestampName('疲劳检测报告', 'html');
  downloadFile(name, html, 'text/html;charset=utf-8');
  toastOk('报告已下载', '双击文件即可在浏览器中查看，也可打印为 PDF');
}
