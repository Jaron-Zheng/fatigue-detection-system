/**
 * session-actions.js — 会话启动引导与运行中切换动作
 *
 * 第三轮角色二从 app.js 拆出：引擎启动进度、摄像头开启、
 * 摄像头切换、演示模式中途切入/退出——这些动作都依赖多个模块协作，
 * 但本身不是"组合根装配"，集中在此保持 app.js 精简。
 */

import { $, setText, toggleClass } from '../util/dom.js';
import { CONFIG } from '../config.js';
import { SessionEvent, SessionState } from '../core/session-state-machine.js';
import { CameraSource } from '../core/face-engine.js';
import { SimulatedDriver } from '../core/sim-driver.js';
import { toast, toastOk, toastError } from './toast.js';

/** 初始化推理引擎（带进度条；已就绪时直接返回） */
export async function bootEngine(app) {
  if (app.engine.ready) return;
  // 不可重入保护：init() 期间用户再次点"开始检测"或 ?demo= 自动触发
  // 会看到 ready 仍为 false 并再次进入 init()，导致并行加载两份 WASM 模型——
  // 轻则内存翻倍、重则 MediaPipe 内部状态冲突直接报错。
  // 用 Promise 缓存保证同一加载过程只执行一次，并发调用全部等待同一 Promise。
  if (app._engineBooting) return app._engineBooting;
  const box = $('#bootBox');
  box.hidden = false;
  const setProgress = (msg, pct) => {
    setText($('#bootMsg'), msg);
    $('#bootBar').style.width = pct + '%';
    app.dash.setStatus(msg, 'var(--warn)', true);
  };
  app._engineBooting = (async () => {
    try {
      // 首屏可能已切走，仍然更新进度文本供状态栏使用
      await app.engine.init(setProgress);
      toastOk('推理引擎就绪', `委托 ${app.engine.delegate} · 模型已本地加载`);
    } finally {
      box.hidden = true;
      app._engineBooting = null;
    }
  })();
  return app._engineBooting;
}

/** 开启摄像头并登记设备列表 */
export async function startCamera(app) {
  if (!app.camera) app.camera = new CameraSource(app.video);
  app.dash.setStatus('正在开启摄像头', 'var(--warn)', true);
  const info = await app.camera.start(app._cameraId || null);
  // 等待授权期间用户可能已点「结束」/切演示：迟到的流必须回收，否则摄像头指示灯常亮、
  // 下次启动报"设备被占用"（幽灵流）
  if (app.startAbort || app.simulate) {
    app.camera.stop();
    return;
  }
  app.deviceInfo = info;
  // 自动避开红外/虚拟摄像头后 deviceId 会变化，同步回 app 让设置面板选中真实设备
  if (app.camera.deviceId) app._cameraId = app.camera.deviceId;
  const cams = await app.camera.listCameras();
  app.settings.setCameras(cams, app._cameraId);
  toggleClass(app.video, 'mirrored', CONFIG.render.mirror);
  app.dash.setStatus('摄像头已就绪', 'var(--warn)', true);
}

/** 运行中切换摄像头：重启采集并重新校准 */
export async function switchCamera(app, id) {
  app._cameraId = id || null;
  const active = ['running', 'paused', 'calibrating'];
  if (!active.includes(app.state)) return;
  try {
    app.camera.stop();
    await app.camera.start(app._cameraId);
    app.engine.resetStats();
    app.recalibrate();
    toastOk('已切换摄像头', '正在重新校准');
  } catch (err) {
    toastError('切换失败', err.message);
  }
}

/** 演示模式中途切入/退出（会话状态迁移经状态机裁决） */
export function setSimulate(app, on, startStage = null) {
  app.simulate = on;
  app.sim.reset();
  if (on) {
    if (app.camera) app.camera.stop();
    // 演示起点（awake/mild/moderate）：在 reset 之后、首帧之前设定
    if (startStage) app.sim.setStartStage(startStage);
    // 开启即进入检测，抽屉必须让位——否则用户错过剧本开头
    if (app.settings && app.settings.open) app.settings.hide();
    const stageNote =
      startStage === 'moderate'
        ? '，从中度疲劳阶段开始（约 30 秒后出现中度提醒，再约 40 秒升级为重度）'
        : startStage === 'mild'
        ? '，从轻度疲劳阶段开始'
        : '';
    toast(
      '演示模式已开启',
      '按预设剧本模拟一段由清醒到重度疲劳的过程，不使用摄像头' + stageNote,
      'info',
      4200
    );
    if (app.sm.send(SessionEvent.SIM_ENTER, { simulated: true })) {
      app.startAbort = true;
      app.loop.stop();
      app.calib = SimulatedDriver.calibration();
      app._beginRunning();
      // 演示直接在工作台看，避免"开启了却看不到画面"（gotoView 同步导航高亮）
      app.router.gotoView('viewWork');
    }
  } else {
    toast('演示模式已关闭', '请重新开始检测以启用真实摄像头', 'info', 3000);
    if (app.sm.send(SessionEvent.SIM_EXIT)) {
      app.startAbort = true;
      if (app.camera) app.camera.stop();
      app.loop.stop();
      app.alarm.reset();
      app.alarmUi.hideVeil();
      app.overlay.clear();
      app.showIdleStage();
      app.dash.setStatus('未启动', 'var(--text-tertiary)', false);
    }
  }
}

/** 启动/校准期间取消：回到待机舞台 */
export function cancelStart(app, status = '未启动') {
  app.loop.stop();
  const box = document.getElementById('bootBox');
  if (box) box.hidden = true;
  app.sm.send(SessionEvent.CANCEL);
  app.alarm.reset();
  app.alarmUi.hideVeil();
  app.overlay.clear();
  app.timeline.clear();
  app.showIdleStage();
  app.dash.setStatus(status, 'var(--text-tertiary)', false);
}

/** 报告页返回时的"再次检测"：清空上一会话的运行时状态 */
export function resetSession(app) {
  app.indicators.reset();
  app.fusion.reset();
  app.alarm.reset();
  app.rawWin.clear();
  app.timeline.clear();
  app.lastInd = null;
  app.lastFusion = null;
  app.lastFeat = null;
  app.overlay.clear();
}

/** 正常结束会话：停止采集、汇总报告、切到报告页 */
export function stopSession(app) {
  if (app.sm.is(SessionState.BOOTING, SessionState.CALIBRATING)) {
    app.startAbort = true;
    if (app.camera) app.camera.stop();
    app.alarm.reset();
    app.alarmUi.hideVeil();
    cancelStart(app, '已取消启动');
    toast('已取消启动', '当前初始化/校准流程已停止', 'info', 2200);
    return;
  }
  if (!app.sm.send(SessionEvent.FINISH)) {
    /* 会话未开始或已结束时点「结束并生成报告」：静默返回会让用户以为
     * 按钮坏了（报告页连点「再次检测」前误触的常见路径）。给出反馈。 */
    toast('当前没有可结束的检测', '会话未开始或已结束', 'info', 3000);
    return;
  }
  app.loop.stop();
  app.recorder.end();
  if (app.camera) app.camera.stop();
  app.alarm.reset();
  app.alarmUi.hideVeil();
  app.dash.setStatus('已结束', 'var(--text-tertiary)', false);

  const summary = app.recorder.summary(app.lastInd, app.lastFusion, app._engineMeta());
  // 必须先切换视图再渲染：报告页在 .view 未 active 时是 display:none，
  // 此时 canvas 的 getBoundingClientRect() 为 0，图表会画成空白。
  app.router.switchView('viewReport');
  app.report.render(summary, app.recorder.samples);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toastOk('检测结束', `已生成报告 · 时长 ${summary.durationText}`);
}

/** 启动失败（摄像头/模型异常）：进入错误舞台并提供重试/演示模式出口 */
export function failStart(app, err) {
  if (app.camera) app.camera.stop();
  const box = document.getElementById('bootBox');
  if (box) box.hidden = true;
  app.sm.send(SessionEvent.FAIL);
  app.loop.stop();
  app.alarm.reset();
  app.alarmUi.hideVeil();
  app.overlay.clear();
  app.timeline.clear();
  const msg = (err && err.message) || String(err);
  app.stage.showError(msg, {
    onRetry: () => app.start(false),
    onSimulate: () => {
      setSimulate(app, true);
      app.settings.swSimulate.checked = true;
      app.start(true);
    },
  });
  app.dash.setStatus('启动失败', 'var(--danger)', false);
  toastError('启动失败', msg);
  console.error(err);
}
