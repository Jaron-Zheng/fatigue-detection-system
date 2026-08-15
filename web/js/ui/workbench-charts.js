/**
 * workbench-charts.js — 工作台双图表（疲劳指数曲线 + EAR/MAR 曲线）
 *
 * 第三轮角色二从 app.js 拆出：图表的创建参数、主题取色、尺寸重测、
 * 参考线随标定结果更新，这些与"会话生命周期"无关的绘图细节集中在此。
 */

import { $, throttle, cssVar } from '../util/dom.js';
import { CONFIG } from '../config.js';
import { LineChart } from './chart.js';

export class WorkbenchCharts {
  /**
   * @param {object} options
   * @param {()=>void} options.onResize 窗口尺寸变化时的整体重布局回调
   */
  constructor({ onResize }) {
    const wMs = CONFIG.window.waveSec * 1000;
    this.score = new LineChart($('#chartScore'), {
      yMin: 0,
      yMax: 100,
      windowMs: wMs,
      yTicks: 4,
      bands: [
        { from: 0, to: 30, color: 'rgba(29,158,75,0.07)' },
        { from: 30, to: 52, color: 'rgba(209,154,0,0.09)' },
        { from: 52, to: 74, color: 'rgba(232,115,12,0.09)' },
        { from: 74, to: 100, color: 'rgba(229,50,45,0.09)' },
      ],
      series: [
        { key: 'raw', color: cssVar('--text-quaternary', '#aeaeb2'), width: 1.2, dash: [3, 3] },
        { key: 'score', color: cssVar('--chart-score', '#e8730c'), width: 2.2, fill: 'rgba(232,115,12,0.20)' },
      ],
      refLines: [
        { y: 30, color: cssVar('--lv-mild', '#d19a00'), label: '轻度' },
        { y: 52, color: cssVar('--lv-moderate', '#e8730c'), label: '中度' },
        { y: 74, color: cssVar('--lv-severe', '#e5322d'), label: '重度' },
      ],
    });

    this.eye = new LineChart($('#chartEye'), {
      yMin: 0,
      yMax: 0.95,
      windowMs: wMs,
      yTicks: 4,
      series: [
        { key: 'ear', color: cssVar('--chart-ear', '#0071e3'), width: 2, fill: 'rgba(0,113,227,0.16)' },
        { key: 'mar', color: cssVar('--chart-mar', '#9a4bd6'), width: 1.8 },
      ],
      refLines: [],
    });

    window.addEventListener('resize', throttle(onResize, 140));
  }

  /** 设置窗口长度变化后同步两张图的显示窗宽 */
  setWindowMs(ms) {
    this.score.opts.windowMs = ms;
    this.eye.opts.windowMs = ms;
  }

  resizeAll() {
    this.score.resize();
    this.eye.resize();
  }

  /** 图表颜色取自 CSS 变量，主题切换后需要重新取色 */
  refreshColors() {
    this.score.opts.series[0].color = cssVar('--text-quaternary', '#aeaeb2');
    this.score.opts.series[1].color = cssVar('--chart-score', '#e8730c');
    this.eye.opts.series[0].color = cssVar('--chart-ear', '#0071e3');
    this.eye.opts.series[1].color = cssVar('--chart-mar', '#9a4bd6');
    /* E3：疲劳指数图的三条等级参考线同样是构造时取色的，主题切换后
     * 会残留旧主题色值，一并重取（眼图的阈值参考线由 draw() 每次用
     * cssVar 现取，无需在此处理） */
    const rl = this.score.opts.refLines;
    if (rl.length >= 3) {
      rl[0].color = cssVar('--lv-mild', '#d19a00');
      rl[1].color = cssVar('--lv-moderate', '#e8730c');
      rl[2].color = cssVar('--lv-severe', '#e5322d');
    }
  }

  /**
   * 绘制两张图。闭眼/张口阈值参考线随标定结果动态更新。
   * @param {{score:Array, raw:Array, ear:Array, mar:Array}} waves 波形数据
   * @param {object|null} calib 校准结果（未完成校准时为 null）
   * @param {number} now performance.now()
   */
  draw(waves, calib, now) {
    this.score.render({ score: waves.score, raw: waves.raw }, now);
    if (calib) {
      this.eye.opts.refLines = [
        {
          y: calib.earCloseThresh,
          color: cssVar('--danger', '#e5322d'),
          label: `闭眼阈值 ${calib.earCloseThresh.toFixed(3)}`,
        },
        {
          y: calib.marOpenThresh,
          color: cssVar('--chart-mar', '#9a4bd6'),
          label: `张口阈值 ${calib.marOpenThresh.toFixed(2)}`,
          dash: [2, 3],
        },
      ];
    }
    this.eye.render({ ear: waves.ear, mar: waves.mar }, now);
  }
}
