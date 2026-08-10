/**
 * video-controls.js — 视频舞台悬浮控制按钮（识别点/镜像/实时数值/全屏/静音）
 *
 * 第三轮角色二从 app.js 拆出：这组开关只改渲染与音频设置，
 * 不参与会话状态流转。
 */

import { $, toggleClass } from '../util/dom.js';
import { CONFIG } from '../config.js';
import { toast, toastWarn } from './toast.js';

/** 开关型按钮：同步视觉状态与 aria-pressed（屏幕阅读器需要知道开关状态） */
function setToggle(btn, on) {
  toggleClass(btn, 'is-on', on);
  btn.setAttribute('aria-pressed', String(on));
}

/**
 * @param {object} app 应用组合根（需要 overlay / video / alarm / _redrawAfterResize）
 */
export function bindVideoControls(app) {
  $('#btnMesh').addEventListener('click', () => {
    const on = !CONFIG.render.showMesh;
    CONFIG.render.showMesh = on;
    CONFIG.render.showContours = on;
    CONFIG.render.showIris = on;
    setToggle($('#btnMesh'), on);
    $('#swMesh').checked = on;
    if (!on) app.overlay.clear();
  });

  $('#btnMirror').addEventListener('click', () => {
    const on = !CONFIG.render.mirror;
    CONFIG.render.mirror = on;
    toggleClass(app.video, 'mirrored', on);
    setToggle($('#btnMirror'), on);
    $('#swMirror').checked = on;
  });

  $('#btnHud').addEventListener('click', () => {
    const on = !CONFIG.render.showMetricsHud;
    CONFIG.render.showMetricsHud = on;
    $('#hud').style.opacity = on ? '1' : '0';
    setToggle($('#btnHud'), on);
  });

  $('#btnFullscreen').addEventListener('click', () => toggleFullscreen(app));

  $('#btnMute').addEventListener('click', () => {
    const muted = !app.alarm.muted;
    app.alarm.setMuted(muted);
    $('#muteIcon').setAttribute('href', muted ? '#i-mute' : '#i-sound');
    toggleClass($('#btnMute'), 'is-on', muted);
    toast(muted ? '已静音' : '已恢复声音', muted ? '视觉报警仍然有效' : '', 'info', 2000);
  });
}

/** 全屏：优先放大视频舞台，退出时恢复画布尺寸 */
async function toggleFullscreen(app) {
  const stage = $('#stage');
  try {
    if (!document.fullscreenElement) {
      await stage.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch (err) {
    toastWarn('全屏切换失败', String((err && err.message) || err));
    return;
  }
  // 全屏切换会改变元素尺寸，需要重新测量 Canvas
  setTimeout(() => app.presenter.redrawAfterResize(), 120);
}
