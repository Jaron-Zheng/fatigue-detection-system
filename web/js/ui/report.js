/**
 * report.js — 会话报告渲染
 *
 * 报告既是给使用者看的结论，也是毕设论文的实验数据来源。
 * 因此除了结论与建议，还完整列出本次检测使用的全部参数与环境信息，
 * 保证实验可复现。
 */

import { el, clear, setText } from '../util/dom.js';
import { fmtDuration } from '../util/math.js';
import { LineChart, renderDistribution, levelBands, levelRefLines } from './chart.js';
import { cssVar } from '../util/dom.js';
import { CONFIG } from '../config.js';
import { INDICATOR_META } from '../core/fusion.js';
import { loadHistory, clearHistory, MAX_HISTORY } from '../core/history.js';
import { toastConfirm, toast } from './toast.js';

const LEVEL_LABELS = { awake: '清醒', mild: '轻度疲劳', moderate: '中度疲劳', severe: '重度疲劳' };

/**
 * 事件统计行（只列"检测到的行为"）。
 * "危险闭眼"是"长时闭眼"的子集（一次 2.5s 闭眼会同时计入两项），
 * 因此用缩进标注从属关系，避免读者把两个数字相加当成异常总次数。
 * "发出疲劳提醒"是系统动作而非行为，不在此表，见 render() 里的表下小字。
 */
const EVENT_ROWS = [
  ['blink', '眨眼', false],
  ['microsleep', '长时间闭眼（超过 0.5 秒）', false],
  ['criticalClosure', '其中危险闭眼（超过 1.8 秒）', true],
  ['yawn', '打哈欠', false],
  ['nod', '点头', false],
  ['distraction', '注意力分散', false],
  ['faceLost', '没看到人脸', false],
  ['qualityLow', '画面看不清（已暂停判断）', false],
];

/* 两位补零（时间戳格式化用） */
const pad2 = (n) => String(n).padStart(2, '0');

/* 开始时间格式化为 YYYY-MM-DD HH:mm（手动补零，不用 toLocaleString） */
function fmtStartTs(d) {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

/**
 * navigator.userAgent → 友好摘要，如 "Chrome 142 · Windows"。
 * 解析失败时截断 UA，避免整串字符把参数表格撑坏。
 */
function parseEnvSummary(ua) {
  let browser = '';
  let os = '';
  // Edge 的 UA 同时含 "Chrome/"，必须先判 Edge
  const mEdge = ua.match(/Edg(?:e|A|iOS)?\/(\d+)/);
  const mFirefox = ua.match(/Firefox\/(\d+)/);
  const mChrome = ua.match(/Chrome\/(\d+)/);
  const mSafari = ua.match(/Version\/(\d+).*Safari/);
  if (mEdge) browser = `Edge ${mEdge[1]}`;
  else if (mFirefox) browser = `Firefox ${mFirefox[1]}`;
  else if (mChrome) browser = `Chrome ${mChrome[1]}`;
  else if (mSafari) browser = `Safari ${mSafari[1]}`;
  // Android 判在 Linux 前：Android UA 同时含 "Linux"
  if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  if (browser && os) return `${browser} · ${os}`;
  if (browser || os) return browser || os;
  return ua.length > 80 ? ua.slice(0, 80) + '…' : ua;
}

export class ReportView {
  /**
   * @param {object} [hooks] 可选外部回调
   * @param {() => void} [hooks.onStart] 空态"开始一次检测"的启动动作
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.chart = null;
    // 是否已渲染过至少一份报告：直接进入报告页且从未渲染时显示空态引导卡
    this.hasReport = false;

    /* 空态引导卡按钮：优先走 hooks.onStart，未注入时回退转触发 #btnStart */
    const startBtn = document.getElementById('rpEmptyStart');
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        if (typeof this.hooks.onStart === 'function') this.hooks.onStart();
        else document.getElementById('btnStart')?.click();
      });
    }
    const demoBtn = document.getElementById('rpEmptyDemo');
    if (demoBtn) demoBtn.addEventListener('click', () => (location.href = '?demo=1'));
    const proBtn = document.getElementById('rpEmptyProMode');
    if (proBtn) {
      proBtn.addEventListener('click', () => {
        if (typeof this.hooks.onToggleProMode === 'function') this.hooks.onToggleProMode();
        else document.getElementById('btnProMode')?.click();
      });
    }

    /* 历史会话：清空按钮只绑一次，列表渲染幂等 */
    setText(document.getElementById('historyCap'), String(MAX_HISTORY));
    const clearBtn = document.getElementById('btnClearHistory');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        if (loadHistory().length === 0) {
          this.renderHistory();
          toast('暂无历史会话', '完成一次检测并生成报告后才会保存摘要', 'info', 2600);
          return;
        }
        const ok = await toastConfirm('清空历史会话？', `本机保存的最多 ${MAX_HISTORY} 条会话摘要将被删除，不可恢复。`, {
          confirmText: '清空',
          danger: true,
        });
        if (!ok) return;
        clearHistory();
        this.renderHistory();
        toast('已清空', '历史会话摘要已全部删除', 'info', 2600);
      });
    }
    this.renderHistory();

    /* 专业模式锚点导航：拦截为 scrollIntoView 平滑滚动，不写 location.hash */
    const anchors = document.getElementById('rpAnchors');
    if (anchors) {
      anchors.addEventListener('click', (e) => {
        const link = e.target.closest('a[data-anchor]');
        if (!link) return;
        const target = document.getElementById(link.dataset.anchor);
        if (!target) return;
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    /* 导出数据菜单：点菜单项执行后收起，点菜单外任意处收起 */
    const exportMenu = document.getElementById('exportMenu');
    if (exportMenu) {
      exportMenu.addEventListener('click', (e) => {
        if (e.target.closest('.menu-list button')) exportMenu.open = false;
      });
      document.addEventListener('click', (e) => {
        if (exportMenu.open && !exportMenu.contains(e.target)) exportMenu.open = false;
      });
    }

    /* 主题跟随：用 MutationObserver 兜住所有 data-theme 变化来源 */
    this._themeObserver = new MutationObserver(() => this.redraw());
    this._themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }

  /**
   * @param {object} summary SessionRecorder.summary() 结果
   * @param {Array}  samples 采样序列
   */
  render(summary, samples) {
    const g = (id) => document.getElementById(id);
    /* 留一份供 redraw 重取色用 */
    this._lastSummary = summary;

    this.hasReport = true;
    const emptyCard = g('rpEmpty');
    if (emptyCard) emptyCard.hidden = true;
    this._setDataCardsHidden(false);
    this.renderHistory();
    const exportMenu = g('exportMenu');
    if (exportMenu) exportMenu.hidden = false;
    const printBtn = g('btnPrint');
    if (printBtn) printBtn.disabled = false;
    for (const id of ['btnExportJson', 'btnExportCsv']) {
      const btn = g(id);
      if (btn) btn.disabled = false;
    }

    /* 标题：结论取本次达到过的最高等级；结束时的即时状态在副标题里单独说明，
     * 避免"末尾恰好清醒"掩盖中途出现的重度疲劳 */
    const started = summary.startedAt ? new Date(summary.startedAt) : new Date();
    const worst = summary.worstLevel || summary.finalLevel;
    const worstLabel = summary.worstLevelLabel || summary.finalLevelLabel;
    setText(
      g('rpTitle'),
      summary.insufficient ? '本次检测未能得出结论' : `本次检测结论：${worstLabel}`
    );
    const samplePart = document.body.classList.contains('pro-mode')
      ? `${summary.sampleCount} 个采样点 · `
      : '';
    // 结论口径说明：结论取"驻留超过 1.5 秒的最高等级"，与结束时的状态可能不同
    const dwellNote =
      !summary.insufficient && summary.worstLevel !== summary.finalLevel
        ? '；结论按各等级持续超过 1.5 秒判定，瞬时波动不计入'
        : '';
    setText(
      g('rpSubtitle'),
      `${fmtStartTs(started)} 开始 · 持续 ${summary.durationText} · ` +
        samplePart +
        (summary.insufficient
          ? `其中只有 ${summary.measuredText} 测到了人脸`
          : `结束时状态：${summary.finalLevelLabel}${dwellNote}`)
    );

    const badge = g('rpLevelBadge');
    if (badge) {
      setText(badge, summary.insufficient ? '有效数据不足' : `最高等级 ${worstLabel}`);
      badge.className =
        'badge ' +
        (summary.insufficient
          ? 'badge-warn'
          : worst === 'severe'
          ? 'badge-danger'
          : worst === 'moderate'
          ? 'badge-caution'
          : worst === 'mild'
          ? 'badge-warn'
          : 'badge-ok');
    }

    /* 标题区关键指标 pill 条 */
    const pillsEl = g('rpMetaPills');
    if (pillsEl) {
      const pills = [
        ['检测时长', summary.durationText],
        ['均值', summary.insufficient ? '--' : summary.avgScore.toFixed(1)],
        ['峰值', summary.insufficient ? '--' : summary.peakScore.toFixed(1)],
        ['画面可用率', `${((summary.coverage || 0) * 100).toFixed(0)}%`],
      ];
      clear(pillsEl);
      for (const [label, value] of pills) {
        pillsEl.appendChild(
          el('span.report-meta-pill', {}, [
            document.createTextNode(label + ' '),
            el('strong', { text: value }),
          ])
        );
      }
    }

    /* 关键指标：有效数据不足时不填具体数字 */
    setText(g('rpDuration'), summary.durationText);
    if (summary.insufficient) {
      setText(g('rpAvgScore'), '--');
      setText(g('rpPeakScore'), '--');
      setText(g('rpAvgPerclos'), '--');
    } else {
      setText(g('rpAvgScore'), summary.avgScore.toFixed(1));
      setText(g('rpPeakScore'), summary.peakScore.toFixed(1));
      setText(g('rpAvgPerclos'), (summary.avgPerclos * 100).toFixed(1) + '%');
    }
    this._renderCoverage(summary);

    /* 状态时间分布 */
    this._renderDist(g('rpDist'), summary);
    for (const [k, id] of [
      ['awake', 'rpdAwake'],
      ['mild', 'rpdMild'],
      ['moderate', 'rpdModerate'],
      ['severe', 'rpdSevere'],
    ]) {
      const r = (summary.levelRatios[k] || 0) * 100;
      setText(g(id), `${r.toFixed(1)}% · ${fmtDuration(summary.levelDurations[k] || 0)}`);
    }

    /* 会话趋势（前后半程对比） */
    this._renderTrend(summary);

    /* 事件统计表 */
    const tbody = g('rpEventTable');
    clear(tbody);
    const minutes = Math.max(summary.durationMs / 60000, 1 / 60);
    for (const [key, label, sub] of EVENT_ROWS) {
      const n = summary.counts[key] || 0;
      const rate = n > 0 ? `${(n / minutes).toFixed(1)} 次/分` : '--';
      tbody.appendChild(
        el('tr', {}, [
          el('td', {
            text: label,
            style: sub ? { paddingLeft: '22px', color: 'var(--text-secondary)' } : null,
          }),
          el('td', { style: { textAlign: 'right' }, text: String(n) }),
          el('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' }, text: rate }),
        ])
      );
    }
    const alarmNote = g('rpAlarmNote');
    if (alarmNote) {
      alarmNote.hidden = false;
      setText(alarmNote, `另有：发出疲劳提醒 ${summary.counts.alarm || 0} 次（按等级分档）`);
    }

    /* 全程曲线 */
    this._renderChart(g('rpChart'), samples, summary.durationMs);

    /* 建议 */
    const adv = g('rpAdvice');
    clear(adv);
    // 危险闭眼与结论等级的口径差衔接说明
    if (!summary.insufficient && worst !== 'severe' && (summary.counts.criticalClosure || 0) > 0) {
      adv.appendChild(
        el('div.advice-item', { text: '检测到危险闭眼（超过 1.8 秒），已按高风险处理。' })
      );
    }
    for (const line of summary.advice) {
      adv.appendChild(el('div.advice-item', { text: line }));
    }

    /* 参数与环境 */
    this._renderParams(g('rpParams'), summary);
  }

  /**
   * 有效覆盖率说明。
   * 人脸丢失期间系统无法判断，这段时间既不算清醒也不算疲劳。
   * 报告里必须写明"测了多久、有多久没测到"。
   */
  _renderCoverage(summary) {
    const node = document.getElementById('rpCoverage');
    if (!node) return;
    const unreliable = summary.unreliableMs || 0;
    if (unreliable < 1000) {
      node.hidden = true;
      setText(node, '');
      return;
    }
    node.hidden = false;
    const pct = ((summary.coverage || 0) * 100).toFixed(0);
    setText(
      node,
      summary.insufficient
        ? `画面可用率 = 真正测到人脸的时间占比。全程 ${summary.durationText} 中只有 ` +
            `${summary.measuredText}（${pct}%）看到了人脸，其余 ${summary.unreliableText} ` +
            `无法判断，因此本次不给出疲劳结论。`
        : `有效检测 ${summary.measuredText}（画面可用率 ${pct}%，即真正测到人脸的时间占比），` +
            `另有 ${summary.unreliableText} 未测到人脸，未计入下方各项统计。`
    );
    node.style.color = summary.insufficient ? 'var(--danger)' : 'var(--text-tertiary)';
  }

  /* 会话趋势摘要（前后半程均值对比） */
  _renderTrend(summary) {
    const node = document.getElementById('rpTrend');
    if (!node) return;
    const tr = summary.trend;
    if (!tr) {
      node.hidden = true;
      setText(node, '');
      return;
    }
    const pct = (v) => (v != null ? (v * 100).toFixed(1) + '%' : '--');
    const DIRECTION = {
      worsening: ['疲劳呈加重趋势', 'var(--danger)'],
      recovering: ['状态在好转', 'var(--ok)'],
      stable: ['全程状态稳定', 'var(--text-tertiary)'],
    };
    const [label, color] = DIRECTION[tr.direction] || DIRECTION.stable;
    node.hidden = false;
    setText(
      node,
      `${label}：前半程平均疲劳指数 ${tr.firstHalfScore} / PERCLOS ${pct(tr.firstHalfPerclos)}，` +
        `后半程 ${tr.secondHalfScore} / ${pct(tr.secondHalfPerclos)}（按有效样本时间中点分割）。`
    );
    node.style.color = color;
  }

  _renderChart(canvas, samples, durationMs) {
    if (!canvas) return;
    const data = { score: samples.map((s) => ({ t: s.t, v: s.score })) };
    /* 等级色带与参考线从 CONFIG.fusion.levels 派生 */
    const bands = levelBands();
    const lastT = samples.length ? samples[samples.length - 1].t : durationMs;
    const nowTs = Math.max(10000, lastT);
    const winMs = Math.max(10000, durationMs);

    /* 缓存 LineChart 实例：避免每次 render() 都 new 导致监听器累积 */
    if (!this._lineChart) {
      this._lineChart = new LineChart(canvas, {
        yMin: 0,
        yMax: 100,
        windowMs: winMs,
        yTicks: 5,
        bands,
        // 报告图是静态历史数据，开启悬停十字准线 + 数值气泡
        interactive: true,
        series: [
          {
            key: 'score',
            color: cssVar('--chart-score', '#3e6ae1'),
            width: 2,
            fill: 'rgba(62,106,225,0.22)',
          },
        ],
        refLines: levelRefLines({ withValue: true }),
      });
    } else {
      this._lineChart.opts.windowMs = winMs;
      this._refreshChartColors();
    }
    this._lineChart.resize();
    this._lineChart.render(data, nowTs);
    this.chart = { chart: this._lineChart, data, durationMs: nowTs };
  }

  /* 重新读取报告图的 CSS 变量取色（主题切换后调用） */
  _refreshChartColors() {
    if (!this._lineChart) return;
    const o = this._lineChart.opts;
    o.series[0].color = cssVar('--chart-score', '#3e6ae1');
    o.refLines = levelRefLines({ withValue: true });
    o.bands = levelBands();
  }

  /**
   * 重置报告视图到空态。
   * 在开始新检测时调用，确保用户取消后切回报告页不会看到上一会话的旧数据。
   */
  resetReport() {
    this.hasReport = false;
    this._lastSummary = null;
    this._showEmpty();
  }

  /* 状态时间分布色带（颜色写入内联样式，主题切换后需 redraw 重新取色） */
  _renderDist(host, summary) {
    if (!host) return;
    const colors = {
      awake: cssVar('--lv-awake', '#1fa355'),
      mild: cssVar('--lv-mild', '#a87705'),
      moderate: cssVar('--lv-moderate', '#f2680c'),
      severe: cssVar('--lv-severe', '#e02b2b'),
    };
    renderDistribution(host, summary.levelRatios, LEVEL_LABELS, colors);
  }

  /* 主题切换或窗口缩放后重绘；从未渲染过报告时维持空态 */
  redraw() {
    if (!this.hasReport) {
      this._showEmpty();
      return;
    }
    if (this._lastSummary) this._renderDist(document.getElementById('rpDist'), this._lastSummary);
    if (!this.chart) return;
    this._refreshChartColors();
    this.chart.chart.resize();
    this.chart.chart.render(this.chart.data, this.chart.durationMs);
  }

  /* 空态：显示引导卡、隐藏数据卡、禁用导出按钮 */
  _showEmpty() {
    const emptyCard = document.getElementById('rpEmpty');
    if (emptyCard) emptyCard.hidden = false;
    const grid = document.querySelector('#viewReport .report-grid');
    if (grid) grid.hidden = false;
    this._setDataCardsHidden(true);
    const exportMenu = document.getElementById('exportMenu');
    if (exportMenu) exportMenu.hidden = true;
    for (const id of ['btnPrint', 'btnExportJson', 'btnExportCsv']) {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = true;
    }
  }

  /* 会话数据卡显隐；实验工具卡不受影响 */
  _setDataCardsHidden(hidden) {
    for (const card of document.querySelectorAll('#viewReport .report-grid > .rp-data')) {
      card.hidden = hidden;
    }
  }

  /* 历史会话列表（本机 localStorage 摘要，最多 MAX_HISTORY 条） */
  renderHistory() {
    const card = document.getElementById('cardHistory');
    if (!card) return;
    const list = loadHistory();
    card.hidden = false;
    const empty = list.length === 0;
    const emptyEl = document.getElementById('historyEmpty');
    if (emptyEl) emptyEl.hidden = !empty;
    const wrapEl = document.getElementById('historyTableWrap');
    if (wrapEl) wrapEl.hidden = empty;
    const clearBtn = document.getElementById('btnClearHistory');
    if (clearBtn) clearBtn.disabled = empty;
    const tbody = document.getElementById('historyTable');
    if (!tbody) return;
    clear(tbody);
    for (const e of list) {
      const d = new Date(e.endedAt);
      const dateTxt = Number.isNaN(d.getTime()) ? '--' : fmtStartTs(d);
      const label = e.insufficient ? '数据不足' : e.worstLevelLabel || LEVEL_LABELS[e.worstLevel] || '清醒';
      tbody.appendChild(
        el('tr', {}, [
          el('td', { text: dateTxt + (e.simulated ? '（演示）' : '') }),
          el('td', { text: fmtDuration(e.durationMs || 0) }),
          el('td', { text: label }),
          el('td', { text: String(e.peakScore ?? 0), style: { textAlign: 'right' } }),
          el('td', { text: `${Math.round((e.coverage || 0) * 100)}%`, style: { textAlign: 'right' } }),
        ])
      );
    }
  }

  /* 渲染参数与环境信息表 */
  _renderParams(table, summary) {
    if (!table) return;
    clear(table);
    const rows = [];

    const w = CONFIG.fusion.weights;
    rows.push([
      '融合权重',
      Object.keys(w)
        .map((k) => `${INDICATOR_META[k].label} ${w[k].toFixed(2)}`)
        .join(' · '),
    ]);
    rows.push(['EMA 平滑系数', String(CONFIG.fusion.emaAlpha)]);
    rows.push(['等级滞回带宽 / 驻留', `${CONFIG.fusion.hysteresis} 分 / ${CONFIG.fusion.levelDwellMs} 毫秒`]);
    rows.push(['PERCLOS 窗口', `${CONFIG.window.perclosSec} 秒`]);
    rows.push(['频率统计窗口', `${CONFIG.window.rateSec} 秒`]);
    rows.push([
      '事件阈值',
      `微睡眠 ≥${CONFIG.event.microsleepMs} 毫秒 · 危险闭眼 ≥${CONFIG.event.criticalClosureMs} 毫秒 · 哈欠 ≥${CONFIG.event.yawnMinMs} 毫秒 · 点头 ≥${CONFIG.event.nodPitchVelDegPerSec}°/秒 · 偏离 >${CONFIG.event.headDeviationDeg}°`,
    ]);

    if (summary.calibration) {
      const c = summary.calibration;
      rows.push([
        '个性化标定',
        c.skipped
          ? '已跳过，使用通用固定阈值'
          : `睁眼 EAR 基线 ${num(c.earBaseline, 3)} · 闭眼阈值 ${num(c.earCloseThresh, 3)} · 张口阈值 ${num(c.marOpenThresh, 3)} · 质量 ${c.qualityLabel}（${c.sampleCount || 0} 样本）`,
      ]);
      rows.push(['姿态零点', `pitch ${num(c.pitch0, 1)}° / yaw ${num(c.yaw0, 1)}° / roll ${num(c.roll0, 1)}°`]);
    }

    if (summary.engine) {
      rows.push([
        '推理性能',
        summary.engine.delegate === '模拟'
          ? '演示模式（无真实推理）'
          : `委托 ${summary.engine.delegate} · 平均单帧 ${Number(summary.engine.avgMs || 0).toFixed(1)} 毫秒 · 累计 ${summary.engine.frames || 0} 帧`,
      ]);
    }
    if (summary.device) {
      rows.push([
        '采集设备',
        summary.device.width > 0
          ? `${summary.device.label || '默认摄像头'} · ${summary.device.width}×${summary.device.height}`
          : '演示模式（合成数据，无真实采集）',
      ]);
    }
    rows.push(['运行环境', parseEnvSummary(navigator.userAgent)]);
    rows.push(['数据说明', '所有视频帧均在浏览器本地处理，报告与导出文件不含任何图像数据。']);

    const tbody = el('tbody');
    for (const [k, v] of rows) {
      tbody.appendChild(el('tr', {}, [el('th', { text: k, style: { width: '150px' } }), el('td', { text: v })]));
    }
    table.appendChild(tbody);
  }
}

const num = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '--');
