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
 * 同步静音按钮的开/关状态标识。
 * btnMute 控制的是报警「声音」静音（app.alarm.muted，视觉报警不受影响），
 * 不是报警总开关（总开关是设置面板的 swAlarm → CONFIG.alarm.enabled），
 * 这里仅按现有语义补状态显示，不改变语义本身。
 */
function syncMuteButton(app) {
  const muted = app.alarm.muted;
  const btn = $('#btnMute');
  $('#muteIcon').setAttribute('href', muted ? '#i-mute' : '#i-sound');
  toggleClass(btn, 'is-off', muted);
  btn.setAttribute('aria-pressed', String(muted));
  const label = muted ? '报警声音：已关闭，点击开启' : '报警声音：开启，点击关闭';
  btn.setAttribute('title', label);
  btn.setAttribute('aria-label', label);
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
    syncMuteButton(app);
    toast(muted ? '已静音' : '已恢复声音', muted ? '视觉报警仍然有效' : '', 'info', 2000);
  });
  // 初始化状态标识：图标/aria-pressed/title 与 alarm.muted 当前值对齐
  syncMuteButton(app);
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
