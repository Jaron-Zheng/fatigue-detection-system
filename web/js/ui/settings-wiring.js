/**
 * settings-wiring.js — 设置面板回调到应用组合根的接线
 *
 * 第三轮角色二从 app.js 拆出：设置面板的每个回调最终要动哪些模块，
 * 集中在这里声明，app.js 的构造函数不再被大段闭包淹没。
 */

import { $, setText, toggleClass } from '../util/dom.js';
import { CONFIG } from '../config.js';
import { TimeWindow } from '../util/ring-buffer.js';
import { toastWarn } from './toast.js';

/**
 * @param {object} app 应用组合根
 * @returns {object} SettingsPanel 构造参数
 */
export function createSettingsHandlers(app) {
  return {
    onWindowChange: () => {
      app.indicators.syncWindows();
      app.rawWin = new TimeWindow(CONFIG.window.waveSec * 1000, 40);
      app.charts.setWindowMs(CONFIG.window.waveSec * 1000);
      setText($('#sPerclos'), `最近 ${CONFIG.window.perclosSec} 秒`);
    },
    onRenderChange: () => {
      toggleClass(app.video, 'mirrored', CONFIG.render.mirror);
      toggleClass($('#btnMirror'), 'is-on', CONFIG.render.mirror);
      toggleClass($('#btnMesh'), 'is-on', CONFIG.render.showMesh);
    },
    onTestAlarm: async () => {
      await app.alarm.unlock();
      app.alarm.test('moderate');
      app.alarmUi.flash('moderate');
    },
    onCameraChange: (id) => app._switchCamera(id),
    onDelegateChange: () => {
      toastWarn('推理委托已切换', '需要重新开始检测才会生效');
    },
    onSimulateChange: (on) => app._setSimulate(on),
  };
}
