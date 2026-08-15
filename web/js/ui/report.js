/**
 * report.js — 会话报告渲染
 *
 * 报告的定位：既是给使用者看的结论，也是毕设论文的实验数据来源。
 * 因此除了结论与建议，还完整列出本次检测使用的全部参数与环境信息，
 * 保证实验可复现。
 */

import { el, clear, setText } from '../util/dom.js';
import { fmtDuration } from '../util/math.js';
import { LineChart, renderDistribution } from './chart.js';
import { cssVar } from '../util/dom.js';
import { CONFIG } from '../config.js';
import { INDICATOR_META } from '../core/fusion.js';

const LEVEL_LABELS = { awake: '清醒', mild: '轻度疲劳', moderate: '中度疲劳', severe: '重度疲劳' };

/**
 * 事件统计行（只列"检测到的行为"）。
 * "危险闭眼"是"长时闭眼"的子集（一次 2.5s 闭眼会同时计入两项），
 * 因此用缩进标注从属关系，避免读者把两个数字相加当成异常总次数；
 * 不用 └ 之类的符号是照顾屏幕阅读器（会把它当乱码读出）。
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

/** 两位补零（时间戳格式化用） */
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 开始时间格式化为 YYYY-MM-DD HH:mm。
 * 不用 toLocaleString('zh-CN')：它产出 "2026/8/15" 这类不补零的日期，观感差。
 */
function fmtStartTs(d) {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

/**
 * navigator.userAgent → 友好摘要，如 "Chrome 142 · Windows"。
 * 原始 UA 是一长串引擎版本号，普通读者无法阅读；
 * 解析失败时截断 UA，避免整串字符把参数表格撑坏。
 */
function parseEnvSummary(ua) {
  let browser = '';
  let os = '';
  // Edge 的 UA 同时含 "Chrome/"，必须先判 Edge 才不会把 Edge 认成 Chrome
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
  constructor() {
    this.chart = null;
    // 是否已渲染过至少一份报告：直接进入报告页且从未渲染时显示空态引导卡
    this.hasReport = false;

    /* ---------- 空态引导卡按钮 ----------
     * 触发方式说明：ReportView 是纯 UI 类、不持有 app 引用；
     * #btnStart 的监听器由 app.js 绑定，自带完整启动链路
     * （状态机裁决、音频解锁、视图切换），转触发该按钮的 click
     * 可以零重复地复用整条链路——比自定义事件协议再让 app.js
     * 适配的做法侵入更小，也贴合本工程"按钮行为集中在 app.js"的分工。 */
    const startBtn = document.getElementById('rpEmptyStart');
    if (startBtn) {
      startBtn.addEventListener('click', () => {
        document.getElementById('btnStart')?.click();
      });
    }
    // 演示模式：app.js 已内置 ?demo= 处理（不认识的值回退完整剧本），
    // 整页跳转最可靠；本应用几乎没有需要随跳转保留的其他查询参数，直接覆盖。
    const demoBtn = document.getElementById('rpEmptyDemo');
    if (demoBtn) demoBtn.addEventListener('click', () => (location.href = '?demo=1'));

    /* ---------- 主题跟随 ----------
     * 应用内按钮切主题已有重绘路径，但直接改 data-theme 属性
     * （如外部脚本、未来新入口）不会经过它，会残留旧主题颜色。
     * 用 MutationObserver 兜住所有变化来源；单页应用常驻不需 disconnect，
     * observer 存到 this 防止重复创建。 */
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
    /* 留一份供 redraw 重取色用（主题切换后色带要重新取内联色） */
    this._lastSummary = summary;

    // 已有报告：撤掉空态，恢复数据区与"下载报告"按钮（disabled 样式由 .btn:disabled 提供）
    this.hasReport = true;
    const emptyCard = g('rpEmpty');
    if (emptyCard) emptyCard.hidden = true;
    const grid = document.querySelector('#viewReport .report-grid');
    if (grid) grid.hidden = false;
    const printBtn = g('btnPrint');
    if (printBtn) printBtn.disabled = false;

    /* ---------- 标题 ----------
     * 结论取本次达到过的最高等级；结束时的即时状态在副标题里单独说明，
     * 避免"末尾恰好清醒"掩盖中途出现的重度疲劳。 */
    const started = summary.startedAt ? new Date(summary.startedAt) : new Date();
    const worst = summary.worstLevel || summary.finalLevel;
    const worstLabel = summary.worstLevelLabel || summary.finalLevelLabel;
    setText(
      g('rpTitle'),
      summary.insufficient ? '本次检测未能得出结论' : `本次检测结论：${worstLabel}`
    );
    // 采样点数量是复现实验才需要的信息，简洁模式下省略
    const samplePart = document.body.classList.contains('pro-mode')
      ? `${summary.sampleCount} 个采样点 · `
      : '';
    // 结论口径说明：结论取"驻留超过 1.5 秒的最高等级"（滤掉瞬时穿越），
    // 与结束时的状态可能不同；两者不一致时必须说明判定口径，
    // 否则读者会把差异当成前后矛盾
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

    /* ---------- 标题区关键指标 pill 条 ----------
     * 把最常关注的四个数字以 pill 形式紧贴副标题展示，
     * 减少标题区的空旷感，也让用户不用滚到下方卡片就能扫到核心结论。
     * 术语与概要卡统一："峰值"对应"峰值疲劳指数"；
     * "覆盖率"改叫"画面可用率"，含义在概要卡的说明文字里展开。 */
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

    /* ---------- 关键指标 ----------
     * 有效数据不足时不填具体数字：一个基于 10% 覆盖率算出的
     * "平均疲劳指数 8.4" 会被当成真实测量结果读走。 */
    setText(g('rpDuration'), summary.durationText);
    if (summary.insufficient) {
      setText(g('rpAvgScore'), '--');
      setText(g('rpPeakScore'), '--');
      setText(g('rpAvgPerclos'), '--');
    } else {
      setText(g('rpAvgScore'), summary.avgScore.toFixed(1));
      // 峰值与均值统一保留 1 位小数：整数"82"与均值"31.4"混排观感割裂
      setText(g('rpPeakScore'), summary.peakScore.toFixed(1));
      setText(g('rpAvgPerclos'), (summary.avgPerclos * 100).toFixed(1) + '%');
    }
    this._renderCoverage(summary);

    /* ---------- 状态时间分布 ---------- */
    this._renderDist(g('rpDist'), summary);
    // 图例同时展示占比与时长；原先第三份纯时长数字块（dist-stat-row）
    // 与此重复，已从 index.html 删除
    for (const [k, id] of [
      ['awake', 'rpdAwake'],
      ['mild', 'rpdMild'],
      ['moderate', 'rpdModerate'],
      ['severe', 'rpdSevere'],
    ]) {
      const r = (summary.levelRatios[k] || 0) * 100;
      setText(g(id), `${r.toFixed(1)}% · ${fmtDuration(summary.levelDurations[k] || 0)}`);
    }

    /* ---------- 事件统计表 ---------- */
    const tbody = g('rpEventTable');
    clear(tbody);
    const minutes = Math.max(summary.durationMs / 60000, 1 / 60);
    for (const [key, label, sub] of EVENT_ROWS) {
      const n = summary.counts[key] || 0;
      // 频次统一 1 位小数 + "次/分"；次数为 0 时频次没有信息量，显示 --
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
    // "发出疲劳提醒"是系统动作（按等级分档触发），不属于"检测到的行为"，
    // 从表中移出后以表下小字说明，次数数据照用 counts.alarm
    const alarmNote = g('rpAlarmNote');
    if (alarmNote) {
      alarmNote.hidden = false;
      setText(alarmNote, `另有：发出疲劳提醒 ${summary.counts.alarm || 0} 次（按等级分档）`);
    }

    /* ---------- 全程曲线 ---------- */
    this._renderChart(g('rpChart'), samples, summary.durationMs);

    /* ---------- 建议 ---------- */
    const adv = g('rpAdvice');
    clear(adv);
    // 危险闭眼与结论等级的口径差：recorder 的建议只要出现危险闭眼就按
    // "高风险"措辞，但结论等级（驻留>1.5s 过滤）可能仍是轻/中度，
    // 读者会看到"轻度疲劳"结论配"高风险"建议——首行补一句衔接说明
    if (!summary.insufficient && worst !== 'severe' && (summary.counts.criticalClosure || 0) > 0) {
      adv.appendChild(
        el('div.advice-item', { text: '检测到危险闭眼（超过 1.8 秒），已按高风险处理。' })
      );
    }
    for (const line of summary.advice) {
      adv.appendChild(el('div.advice-item', { text: line }));
    }

    /* ---------- 参数与环境 ---------- */
    this._renderParams(g('rpParams'), summary);
  }

  /**
   * 有效覆盖率说明。
   * 人脸丢失期间系统无法判断，这段时间既不算清醒也不算疲劳。
   * 报告里必须写明"测了多久、有多久没测到"，否则占比数字会被误读成全程结论。
   * 术语与顶栏 pill 统一为"画面可用率"，并在此处顺带解释其含义。
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

  _renderChart(canvas, samples, durationMs) {
    if (!canvas) return;
    const data = { score: samples.map((s) => ({ t: s.t, v: s.score })) };
    const bands = [
      { from: 0, to: 30, color: 'rgba(29,158,75,0.08)' },
      { from: 30, to: 52, color: 'rgba(209,154,0,0.10)' },
      { from: 52, to: 74, color: 'rgba(232,115,12,0.10)' },
      { from: 74, to: 100, color: 'rgba(229,50,45,0.10)' },
    ];
    const chart = new LineChart(canvas, {
      yMin: 0,
      yMax: 100,
      windowMs: Math.max(10000, durationMs),
      yTicks: 5,
      bands,
      // 报告图是静态历史数据，开启悬停十字准线 + 数值气泡便于逐点读数；
      // 实时工作台图不传该选项，保持轻量
      interactive: true,
      series: [
        {
          key: 'score',
          color: cssVar('--chart-score', '#e8730c'),
          width: 2,
          fill: 'rgba(232,115,12,0.22)',
        },
      ],
      refLines: [
        { y: 30, color: cssVar('--lv-mild', '#d19a00'), label: '轻度 30' },
        { y: 52, color: cssVar('--lv-moderate', '#e8730c'), label: '中度 52' },
        { y: 74, color: cssVar('--lv-severe', '#e5322d'), label: '重度 74' },
      ],
    });
    chart.resize();
    // 用最后一个样本的时间作为右边界，保证图形从 x=0 画到 x=duration
    const lastT = samples.length ? samples[samples.length - 1].t : durationMs;
    chart.render(data, Math.max(10000, lastT));
    this.chart = { chart, data, durationMs: Math.max(10000, lastT) };
  }

  /**
   * 状态时间分布色带。颜色是渲染时写入内联样式的，
   * 主题切换后必须由 redraw 重新取色重渲染，否则会残留上一主题的色值。
   */
  _renderDist(host, summary) {
    if (!host) return;
    const colors = {
      awake: cssVar('--lv-awake', '#146a38'),
      mild: cssVar('--lv-mild', '#7a5a00'),
      moderate: cssVar('--lv-moderate', '#b34e00'),
      severe: cssVar('--lv-severe', '#c11f1a'),
    };
    renderDistribution(host, summary.levelRatios, LEVEL_LABELS, colors);
  }

  /** 主题切换或窗口缩放后重绘；从未渲染过报告时维持空态（首次进入报告页走这里） */
  redraw() {
    if (!this.hasReport) {
      this._showEmpty();
      return;
    }
    if (this._lastSummary) this._renderDist(document.getElementById('rpDist'), this._lastSummary);
    if (!this.chart) return;
    this.chart.chart.resize();
    this.chart.chart.render(this.chart.data, this.chart.durationMs);
  }

  /**
   * 空态：显示引导卡、隐藏数据区、禁用"下载报告"。
   * 由 redraw() 在切到报告视图且 hasReport 为假时调用（view-router 切视图
   * 会调 app.report.redraw()，因此无需改动路由层）；操作幂等，可重复调用。
   */
  _showEmpty() {
    const emptyCard = document.getElementById('rpEmpty');
    if (emptyCard) emptyCard.hidden = false;
    const grid = document.querySelector('#viewReport .report-grid');
    if (grid) grid.hidden = true;
    const printBtn = document.getElementById('btnPrint');
    if (printBtn) printBtn.disabled = true;
  }

  _renderParams(table, summary) {
    if (!table) return;
    clear(table);
    const rows = [];

    // 权重保留 2 位小数，与设置面板滑杆刻度的读数精度一致
    const w = CONFIG.fusion.weights;
    rows.push([
      '融合权重',
      Object.keys(w)
        .map((k) => `${INDICATOR_META[k].label} ${w[k].toFixed(2)}`)
        .join(' · '),
    ]);
    rows.push(['EMA 平滑系数', String(CONFIG.fusion.emaAlpha)]);
    rows.push(['等级滞回带宽 / 驻留', `${CONFIG.fusion.hysteresis} 分 / ${CONFIG.fusion.levelDwellMs} ms`]);
    rows.push(['PERCLOS 窗口', `${CONFIG.window.perclosSec} s`]);
    rows.push(['频率统计窗口', `${CONFIG.window.rateSec} s`]);
    rows.push([
      '事件阈值',
      `微睡眠 ≥${CONFIG.event.microsleepMs}ms · 危险闭眼 ≥${CONFIG.event.criticalClosureMs}ms · 哈欠 ≥${CONFIG.event.yawnMinMs}ms · 点头 ≥${CONFIG.event.nodPitchVelDegPerSec}°/s · 偏离 >${CONFIG.event.headDeviationDeg}°`,
    ]);

    if (summary.calibration) {
      const c = summary.calibration;
      rows.push([
        '个性化标定',
        // EAR/MAR 阈值统一 3 位小数：4 位精度对 0.2x 量级的值是噪声，
        // 且标定卡片（工作台）历来按 3 位展示，保持一致
        c.skipped
          ? '已跳过，使用通用固定阈值'
          : `睁眼 EAR 基线 ${num(c.earBaseline, 3)} · 闭眼阈值 ${num(c.earCloseThresh, 3)} · 张口阈值 ${num(c.marOpenThresh, 3)} · 质量 ${c.qualityLabel}（${c.sampleCount || 0} 样本）`,
      ]);
      rows.push(['姿态零点', `pitch ${num(c.pitch0, 1)}° / yaw ${num(c.yaw0, 1)}° / roll ${num(c.roll0, 1)}°`]);
    }

    if (summary.engine) {
      rows.push([
        '推理性能',
        // 演示模式没有真实推理，耗时/帧数是模拟值，标注清楚防止被当成性能数据引用
        summary.engine.delegate === '模拟'
          ? '演示模式（无真实推理）'
          : `委托 ${summary.engine.delegate} · 平均单帧 ${Number(summary.engine.avgMs || 0).toFixed(1)} ms · 累计 ${summary.engine.frames || 0} 帧`,
      ]);
    }
    if (summary.device) {
      // 演示模式的设备信息是合成的（width=0），不代表真实采集能力
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
