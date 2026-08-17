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

  /* 专家区块按当前模式分流处理（第六轮开关混沌实测修复：
   * 此前折叠逻辑不区分模式——普通模式导出会把空专业卡折成
   * 「未运行」可见文案，专业术语泄漏给普通用户；而专业模式导出
   * 时分析卡没跑也折成同样文案，导致两份文件肉眼一模一样）。
   *
   * 普通模式：.pro-only 在页面上本就 display:none，用户看到什么
   *   报告里就该只有什么——从导出克隆里整体剥离，不留痕迹。
   * 专业模式：空壳折叠——敏感性分析/离线复现/视频评测三张卡在
   *   「分析未运行」时结果是空的，原样导出会得到带标题的大白板卡，
   *   答辩交付物观感很差。规则：卡内不存在任何"有内容的结果容器"
   *   就把整卡替换为一行紧凑说明。结果容器由各卡自身的渲染逻辑
   *   填充（表格行/结论文本/结果块），空 = 未运行。 */
  const PRO_RESULT_HOSTS = ['#sensTable', '#sensConclusion', '#replayResult', '#evalResult'];
  const proModeOn = document.body.classList.contains('pro-mode');
  if (!proModeOn) {
    clone.querySelectorAll('.pro-only').forEach((el) => el.remove());
  } else {
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
  // 叠在白底上的"花屏"。临时切换同一帧内完成，不会闪。
  const htmlEl = document.documentElement;
  const prevTheme = htmlEl.getAttribute('data-theme');
  if (prevTheme && prevTheme !== 'light') htmlEl.setAttribute('data-theme', 'light');
  const computed = getComputedStyle(htmlEl);
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

  // 变量读取完毕，还原用户当前主题
  if (prevTheme && prevTheme !== 'light') htmlEl.setAttribute('data-theme', prevTheme);

  // 同步 body 状态类：pro-mode 决定 .pro-only 区块在导出文件里是否可见。
  // 之前 body 硬编码且不带任何类，导致专家模式无论开关，
  // 导出的报告里专业内容全被 .pro-only{display:none} 吞掉，两份文件一模一样。
  const bodyStateClass = document.body.className
    .split(/\s+/)
    .filter((c) => c && c !== 'has-motion') // 运行时动画类不属于文档状态
    .join(' ');

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
/* ===== 屏幕查看：模拟站内报告页的浅灰画布 + 白卡层次 =====
   之前 body 与卡片同为纯白且边框阴影全无，打开导出文件
   白底贴白底，卡片边界消失；内容也无最大宽度约束，
   宽屏上三列卡片会被拉到 700px+/列。 */
body{background:var(--bg,#f4f4f4)!important;}
#viewReport{display:block!important;max-width:1440px;margin:0 auto;padding:28px 24px 48px;}
/* 边框一档加深：#e3e3e5 对灰底反差不足 6%，投影仪上看不清卡片边界 */
.card{border:1px solid #d9d9de!important;border-radius:var(--r-lg,14px);}
.global-nav,.subnav,.controls,.alarm-veil,.alarm-banner,.toast-host,.no-print{display:none!important;}
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
