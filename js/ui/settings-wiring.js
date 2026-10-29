/**
 * settings-wiring.js — 设置面板回调到应用组合根的接线
 *
 * 设置面板的每个回调最终要动哪些模块，集中在这里声明，
 * app.js 的构造函数不再被大段闭包淹没。
 */

import { $, setText, toggleClass } from '../util/dom.js';
import { CONFIG } from '../config.js';
import { TimeWindow } from '../util/ring-buffer.js';
import { toastWarn } from './toast.js';

/**
 * @param {object} app 应用组合根
 * @returns {object} SettingsPanel 构造参数（hooks 回调集合）
 */
export function createSettingsHandlers(app) {
  return {
    // 窗口参数变化：同步指标引擎、波形缓冲、图表窗宽、文案
    onWindowChange: () => {
      app.indicators.syncWindows();
      app.rawWin = new TimeWindow(CONFIG.window.waveSec * 1000, 40);
      app.charts.setWindowMs(CONFIG.window.waveSec * 1000);
      setText($('#sPerclos'), `最近 ${CONFIG.window.perclosSec} 秒`);
    },
    // 渲染参数变化：镜像、网格显隐
    onRenderChange: () => {
      toggleClass(app.video, 'mirrored', CONFIG.render.mirror);
      toggleClass($('#btnMirror'), 'is-on', CONFIG.render.mirror);
      toggleClass($('#btnMesh'), 'is-on', CONFIG.render.showMesh);
    },
    // 试听报警
    onTestAlarm: async (level = 'moderate') => {
      await app.alarm.unlock();
      app.alarm.test(level);
      app.alarmUi.flash(level);
    },
    // 摄像头切换
    onCameraChange: (id) => app._switchCamera(id),
    // 推理委托切换（需重启生效）
    onDelegateChange: () => {
      toastWarn('推理委托已切换', '需要重新开始检测才会生效');
    },
    // 演示模式开关
    onSimulateChange: (on) => {
      const stage = on ? ($('#selDemoStart')?.value || 'awake') : null;
      app._setSimulate(on, stage);
    },
  };
}
