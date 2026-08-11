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
 * 事件统计行。
 * "危险闭眼"是"长时闭眼"的子集（一次 2.5s 闭眼会同时计入两项），
 * 因此用缩进标注从属关系，避免读者把两个数字相加当成异常总次数。
 */
const EVENT_ROWS = [
  ['blink', '眨眼', false],
  ['microsleep', '长时间闭眼（超过 0.5 秒）', false],
  ['criticalClosure', '└ 其中很危险的（超过 1.8 秒）', true],
  ['yawn', '打哈欠', false],
  ['nod', '点头', false],
  ['distraction', '注意力分散', false],
  ['faceLost', '没看到人脸', false],
  ['qualityLow', '画面看不清（已暂停判断）', false],
  ['alarm', '发出疲劳提醒', false],
];

export class ReportView {
  constructor() {
    this.chart = null;
  }

  /**
   * @param {object} summary SessionRecorder.summary() 结果
   * @param {Array}  samples 采样序列
   */
  render(summary, samples) {
    const g = (id) => document.getElementById(id);
    /* 留一份供 redraw 重取色用（主题切换后色带要重新取内联色） */
    this._lastSummary = summary;

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
    setText(
      g('rpSubtitle'),
      `${started.toLocaleString('zh-CN')} 开始 · 持续 ${summary.durationText} · ` +
        samplePart +
        (summary.insufficient
          ? `其中只有 ${summary.measuredText} 测到了人脸`
          : `结束时状态：${summary.finalLevelLabel}`)
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
     * 减少标题区的空旷感，也让用户不用滚到下方卡片就能扫到核心结论。 */
    const pillsEl = g('rpMetaPills');
    if (pillsEl) {
      const pills = [
        ['检测时长', summary.durationText],
        ['均值', summary.insufficient ? '--' : summary.avgScore.toFixed(1)],
        ['峰值', summary.insufficient ? '--' : summary.peakScore.toFixed(0)],
        ['覆盖率', `${((summary.coverage || 0) * 100).toFixed(0)}%`],
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
      setText(g('rpPeakScore'), summary.peakScore.toFixed(0));
      setText(g('rpAvgPerclos'), (summary.avgPerclos * 100).toFixed(1) + '%');
    }
    this._renderCoverage(summary);

    /* ---------- 状态时间分布 ---------- */
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
    // 各状态时长数字块（dist-stat-row）
    for (const [k, id] of [
      ['awake', 'rpdAwakeVal'],
      ['mild', 'rpdMildVal'],
      ['moderate', 'rpdModerateVal'],
      ['severe', 'rpdSevereVal'],
    ]) {
      const node = g(id);
      if (node) setText(node, fmtDuration(summary.levelDurations[k] || 0));
    }

    /* ---------- 事件统计表 ---------- */
    const tbody = g('rpEventTable');
    clear(tbody);
    const minutes = Math.max(summary.durationMs / 60000, 1 / 60);
    for (const [key, label, sub] of EVENT_ROWS) {
      const n = summary.counts[key] || 0;
      tbody.appendChild(
        el('tr', {}, [
          el('td', {
            text: label,
            style: sub ? { paddingLeft: '22px', color: 'var(--text-secondary)' } : null,
          }),
          el('td', { style: { textAlign: 'right' }, text: String(n) }),
          el('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' }, text: `${(n / minutes).toFixed(2)}/分` }),
        ])
      );
    }

    /* ---------- 全程曲线 ---------- */
    this._renderChart(g('rpChart'), samples, summary.durationMs);

    /* ---------- 建议 ---------- */
    const adv = g('rpAdvice');
    clear(adv);
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
        ? `全程 ${summary.durationText} 中只有 ${summary.measuredText}（${pct}%）看到了人脸，` +
            `其余 ${summary.unreliableText} 无法判断，因此本次不给出疲劳结论。`
        : `有效检测 ${summary.measuredText}（${pct}%），另有 ${summary.unreliableText} 未测到人脸，` +
            `未计入下方各项统计。`
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

  /** 主题切换或窗口缩放后重绘 */
  redraw() {
    if (this._lastSummary) this._renderDist(document.getElementById('rpDist'), this._lastSummary);
    if (!this.chart) return;
    this.chart.chart.resize();
    this.chart.chart.render(this.chart.data, this.chart.durationMs);
  }

  _renderParams(table, summary) {
    if (!table) return;
    clear(table);
    const rows = [];

    const w = CONFIG.fusion.weights;
    rows.push(['融合权重', Object.keys(w).map((k) => `${INDICATOR_META[k].label} ${w[k]}`).join(' · ')]);
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
        c.skipped
          ? '已跳过，使用通用固定阈值'
          : `睁眼 EAR 基线 ${num(c.earBaseline, 4)} · 闭眼阈值 ${num(c.earCloseThresh, 4)} · 张口阈值 ${num(c.marOpenThresh, 3)} · 质量 ${c.qualityLabel}（${c.sampleCount || 0} 样本）`,
      ]);
      rows.push(['姿态零点', `pitch ${num(c.pitch0, 1)}° / yaw ${num(c.yaw0, 1)}° / roll ${num(c.roll0, 1)}°`]);
    }

    if (summary.engine) {
      rows.push([
        '推理性能',
        `委托 ${summary.engine.delegate} · 平均单帧 ${Number(summary.engine.avgMs || 0).toFixed(1)} ms · 累计 ${summary.engine.frames || 0} 帧`,
      ]);
    }
    if (summary.device) {
      rows.push(['采集设备', `${summary.device.label || '默认摄像头'} · ${summary.device.width}×${summary.device.height}`]);
    }
    rows.push(['运行环境', navigator.userAgent]);
    rows.push(['数据说明', '所有视频帧均在浏览器本地处理，报告与导出文件不含任何图像数据。']);

    const tbody = el('tbody');
    for (const [k, v] of rows) {
      tbody.appendChild(el('tr', {}, [el('th', { text: k, style: { width: '150px' } }), el('td', { text: v })]));
    }
    table.appendChild(tbody);
  }
}

const num = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '--');
