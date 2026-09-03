/**
 * workbench-charts.js — 工作台双图表（疲劳指数曲线 + EAR/MAR 曲线）
 *
 * 第三轮角色二从 app.js 拆出：图表的创建参数、主题取色、尺寸重测、
 * 参考线随标定结果更新，这些与"会话生命周期"无关的绘图细节集中在此。
 */

import { $, throttle, cssVar } from '../util/dom.js';
import { CONFIG } from '../config.js';
import { LineChart, levelBands, levelRefLines } from './chart.js';

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
      /* 等级色带走 -soft 令牌；四档等级色两主题同值（单一配色），
       * 主题切换只需重取非等级类线色；边界从 CONFIG 派生（chart.levelBands） */
      bands: levelBands(),
      series: [
        { key: 'raw', color: cssVar('--text-quaternary', '#aeaeb2'), width: 1.2, dash: [3, 3] },
        { key: 'score', color: cssVar('--chart-score', '#3e6ae1'), width: 2.2, fill: 'rgba(62,106,225,0.20)' },
      ],
      refLines: levelRefLines(),
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
    this.score.opts.series[1].color = cssVar('--chart-score', '#3e6ae1');
    this.eye.opts.series[0].color = cssVar('--chart-ear', '#0071e3');
    this.eye.opts.series[1].color = cssVar('--chart-mar', '#9a4bd6');
    /* E3：疲劳指数图的等级色带与参考线同样是构造时取色的，
     * 主题切换后会残留旧主题色值——直接用 chart 的派生函数重建，
     * 颜色与边界始终跟 CONFIG 同源（眼图的阈值参考线由 draw()
     * 每次用 cssVar 现取，无需在此处理） */
    this.score.opts.bands = levelBands();
    this.score.opts.refLines = levelRefLines();
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
          color: cssVar('--danger', '#e02b2b'),
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
