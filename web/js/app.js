/**
 * app.js — 应用组合根
 *
 * 第三轮角色二重构：本文件不再包含业务判断分支，只负责
 * 组装「状态机 + 推理/算法引擎 + UI 模块」并转发事件：
 * 会话状态流转在 core/session-state-machine.js（合法迁移表 + guard，有单元测试），
 * 主循环节拍在 core/render-loop.js，阶段遮罩/报警视觉/主题/图表/视图路由/导出等
 * 各自在 ui/ 下的独立模块，测试钩子在 test-hooks.js。
 * 数据流（单向，便于调试与论文画图，完整版见 README）：
 * 摄像头帧 → FaceEngine(WASM) → 特征层 → 指标层 → 融合层(0–100 指数+四级等级)
 *          → AlarmSystem / Dashboard / SessionRecorder
 */

import { CONFIG, loadUserConfig } from './config.js';
import { $, setText, setAttr } from './util/dom.js';
import { TimeWindow } from './util/ring-buffer.js';

import { SessionStateMachine, SessionState, SessionEvent } from './core/session-state-machine.js';
import { RenderLoop } from './core/render-loop.js';
import { FaceEngine } from './core/face-engine.js';
import { FeatureExtractor } from './core/features.js';
import { Calibrator, CalibState } from './core/calibration.js';
import { IndicatorEngine } from './core/indicators.js';
import { FusionEngine } from './core/fusion.js';
import { AlarmSystem } from './core/alarm.js';
import { SessionRecorder } from './core/recorder.js';
import { SimulatedDriver } from './core/sim-driver.js';
import { evaluateFaceQuality, LightingMonitor } from './core/quality.js';

import { Overlay } from './ui/overlay.js';
import { Dashboard } from './ui/dashboard.js';
import { Timeline } from './ui/timeline.js';
import { ReportView } from './ui/report.js';
import { SettingsPanel } from './ui/settings.js';
import { AnalysisPanel } from './ui/analysis-ui.js';
import { EvaluationPanel } from './ui/evaluation-ui.js';
import { SessionStage } from './ui/session-stage.js';
import { AlarmVisuals } from './ui/alarm-visuals.js';
import { AppChrome } from './ui/app-chrome.js';
import { WorkbenchCharts } from './ui/workbench-charts.js';
import { FramePresenter } from './ui/frame-presenter.js';
import { bindVideoControls } from './ui/video-controls.js';
import { exportSessionJson, exportSessionCsv, exportReportHtml } from './ui/export-report.js';
import { ViewRouter } from './ui/view-router.js';
import { createSettingsHandlers } from './ui/settings-wiring.js';
import { bootEngine, startCamera, switchCamera, setSimulate, cancelStart, resetSession, stopSession, failStart } from './ui/session-actions.js';
import { toastOk, toastWarn } from './ui/toast.js';
import { initMotion } from './ui/motion.js';
import { installTestHooks } from './test-hooks.js';

/** 兼容别名：测试钩子与旧文档中以 State.* 引用状态 */
const State = SessionState;

class App {
  constructor() {
    // 必须最先载入用户配置：下面所有模块都在构造阶段读 CONFIG
    //（窗口长度、滑块初值等），读得太晚会导致保存过的参数刷新后不生效。
    loadUserConfig();

    this.sm = new SessionStateMachine();

    this.engine = new FaceEngine();
    this.camera = null;
    this.extractor = new FeatureExtractor();
    this.calibrator = new Calibrator();
    this.indicators = new IndicatorEngine();
    this.fusion = new FusionEngine();
    this.alarm = new AlarmSystem();
    this.recorder = new SessionRecorder();
    this.sim = new SimulatedDriver();
    this.lighting = new LightingMonitor();

    this.calib = null;
    this.lastFeat = null;
    this.lastInd = null;
    this.lastFusion = null;
    this.deviceInfo = null;

    this.simulate = false;
    this.lastFrameAt = 0;
    this.startAbort = false;
    this.rawWin = new TimeWindow(CONFIG.window.waveSec * 1000, 40);

    this.loop = new RenderLoop({
      onFrame: (now) => this._frame(now),
      targetFps: () => CONFIG.capture.targetFps,
    });

    this._initDom();
    this.charts = new WorkbenchCharts({ onResize: () => this._relayout() });
    this.stage = new SessionStage();
    this.alarmUi = new AlarmVisuals();
    this.chrome = new AppChrome({
      video: this.video,
      onThemeChanged: () => this._onThemeChanged(),
      onLayoutChanged: () => this._relayout(),
    });
    this.router = new ViewRouter(this);
    this.presenter = new FramePresenter(this);
    this._bindEvents();
    this.router.bind();
    this.chrome.syncButtonStates();
    this.chrome.initTheme();
    this.chrome.initProMode();
    this.chrome.renderEnv();
    this.showIdleStage();
    // 动效必须最后启动：它要在 DOM 与主题都就位后才能正确测量与接管
    initMotion();
  }

  /** 当前会话状态（唯一事实来源是状态机） */
  get state() {
    return this.sm.state;
  }

  isRunning() {
    return this.sm.is(State.RUNNING);
  }

  /* ==================== 初始化 ==================== */

  _initDom() {
    this.video = $('#video');
    this.overlay = new Overlay($('#overlay'));
    this.dash = new Dashboard();
    this.timeline = new Timeline('timeline', 'eventCount');
    this.report = new ReportView();
    this.analysis = new AnalysisPanel(() => this.recorder.samples);
    /**
     * 视频离线评测面板。
     * 复用同一个 FaceEngine 实例：评测与实时检测必须走完全相同的推理配置，
     * 否则得出的准确率不能代表实际系统表现。
     */
    this.evaluation = new EvaluationPanel(
      () => this.engine,
      () => this._bootEngine()
    );

    this.settings = new SettingsPanel(createSettingsHandlers(this));

    // 指标卡的窗口说明是写死在 HTML 里的"最近 30 秒"，
    // 用户改过窗口长度并保存后必须按实际值刷新，否则数字与说明会对不上。
    setText($('#sPerclos'), `最近 ${CONFIG.window.perclosSec} 秒`);
  }

  _bindEvents() {
    $('#btnStart').addEventListener('click', () => this.start(false));
    $('#btnProMode').addEventListener('click', () => this.chrome.toggleProMode());
    $('#btnPause').addEventListener('click', () => this.togglePause());
    $('#btnStop').addEventListener('click', () => this.stop());
    $('#btnRecalib').addEventListener('click', () => this.recalibrate());

    bindVideoControls(this);

    $('#btnTheme').addEventListener('click', () => this.chrome.toggleTheme());
    $('#btnDismissAlarm').addEventListener('click', () => this.alarmUi.hideBanner());

    $('#btnFilterEvents').addEventListener('click', (e) => {
      const only = !this.timeline.onlyAbnormal;
      this.timeline.setFilter(only);
      e.currentTarget.textContent = only ? '显示全部' : '仅看异常';
    });

    $('#btnExportJson').addEventListener('click', () =>
      exportSessionJson(this.recorder, {
        lastInd: this.lastInd,
        lastFusion: this.lastFusion,
        meta: this._engineMeta(),
      })
    );
    $('#btnExportCsv').addEventListener('click', () => exportSessionCsv(this.recorder));
    $('#btnPrint').addEventListener('click', () => exportReportHtml());
    $('#btnBackWork').addEventListener('click', () => this.start(this.simulate));

    // 报警视觉回调由 UI 提供
    this.alarm.onVisualAlarm = (level) => this.alarmUi.flash(level);
  }

  /* ==================== 布局与重绘 ==================== */

  /** 显隐/布局变化后：画布重新测量并重绘 */
  _relayout() {
    this.overlay.resize();
    this.charts.resizeAll();
    this.drawCharts(performance.now());
    this.report.redraw();
  }

  /** 主题切换后：重新取色并重绘 */
  _onThemeChanged() {
    this.overlay.refreshTheme();
    this.charts.refreshColors();
    this.drawCharts(performance.now());
    this.report.redraw();
  }

  drawCharts(now) {
    const wf = this.indicators.waveforms();
    this.charts.draw({ ...wf, raw: this.rawWin.toArray() }, this.calib, now);
  }

  showIdleStage() {
    this.stage.showIdle(() => this.start(false));
  }

  _engineMeta() {
    return {
      delegate: this.simulate ? '模拟' : this.engine.delegate,
      avgMs: this.engine.avgInferMs,
      frames: this.engine.stats.infer,
    };
  }

  /* ==================== 生命周期（全部迁移经状态机裁决） ==================== */

  async start(skipCalib = false) {
    if (this.sm.is(State.RUNNING, State.CALIBRATING, State.BOOTING)) return;

    // 报表页返回时的"再次检测"
    if (this.sm.is(State.REPORT)) resetSession(this);
    if (!this.sm.send(SessionEvent.START)) return;

    this.startAbort = false;
    this.router.switchView('viewWork');
    this.stage.showBoot();
    this.dash.setStatus('正在初始化', 'var(--warn)', true);

    // 音频必须在用户手势链路内解锁
    await this.alarm.unlock();
    if (this._cancelledStopCamera()) return;

    try {
      if (!this.simulate) {
        await this._bootEngine();
        if (this._cancelledStopCamera()) return;
        await this._startCamera();
        if (this._cancelledStopCamera()) return;
      } else {
        // 模拟模式无需摄像头与模型
        this.deviceInfo = { label: '模拟驾驶员（合成特征）', width: 0, height: 0 };
      }
    } catch (err) {
      if (this._cancelledStopCamera()) return;
      failStart(this, err);
      return;
    }

    this.overlay.resize();
    this.charts.resizeAll();

    if (skipCalib || this.simulate) {
      this.calib = this.simulate ? SimulatedDriver.calibration() : this.calibrator.useFallback();
      if (!this.sm.send(SessionEvent.BEGIN_RUNNING, { calibration: this.calib, simulated: this.simulate })) return;
      this._beginRunning();
      if (!this.simulate) {
        toastWarn('已跳过校准', '改用通用固定阈值，不同人的眼型差异可能带来误判');
      }
    } else {
      if (!this.sm.send(SessionEvent.BEGIN_CALIBRATION)) return;
      this._beginCalibration();
    }
  }

  /** 启动流程被取消时的统一收尾；未取消返回 false */
  _cancelledStopCamera() {
    if (!this.startAbort) return false;
    if (this.camera) this.camera.stop();
    cancelStart(this, '已取消启动');
    return true;
  }

  _bootEngine() {
    return bootEngine(this);
  }

  _startCamera() {
    return startCamera(this);
  }

  _switchCamera(id) {
    return switchCamera(this, id);
  }

  _beginCalibration() {
    this.extractor.reset();
    this.calibrator.start(performance.now());
    this.stage.showCalibrating(() => {
      if (this.state !== State.CALIBRATING) return;
      this.calib = this.calibrator.useFallback();
      if (!this.sm.send(SessionEvent.BEGIN_RUNNING, { calibration: this.calib })) return;
      this._beginRunning();
      toastWarn('已跳过校准', '改用通用固定阈值，不同人的眼型差异可能带来误判');
    });
    this.dash.setStatus('校准中', 'var(--warn)', true);
    this.loop.start();
  }

  recalibrate() {
    if (this.simulate) {
      toastWarn('演示模式无需校准');
      return;
    }
    if (!this.sm.send(SessionEvent.RECALIBRATE)) return;
    this.indicators.reset();
    this.fusion.reset();
    this.alarm.reset();
    this._beginCalibration();
  }

  _beginRunning() {
    this.stage.hide();
    this.extractor.reset();
    this.indicators.reset();
    this.fusion.reset();
    this.alarm.reset();
    this.rawWin.clear();
    this.timeline.clear();
    this.timeline.setBase(performance.now());
    this.recorder.begin(this.calib, this.deviceInfo);
    this._setPauseButton(true);
    this.dash.updateCalibration(this.calib, {
      avgMs: this.engine.avgInferMs,
      delegate: this.simulate ? '模拟' : this.engine.delegate || '--',
    });
    this.dash.setStatus(this.simulate ? '演示中' : '检测中', 'var(--ok)', true);
    this.loop.start();
  }

  togglePause() {
    if (this.sm.send(SessionEvent.PAUSE)) {
      this.loop.stop();
      this.stage.showPaused();
      this._setPauseButton(false);
      this.dash.setStatus('已暂停', 'var(--text-tertiary)', false);
    } else if (this.sm.send(SessionEvent.RESUME)) {
      this.stage.hide();
      this._setPauseButton(true);
      this.dash.setStatus(this.simulate ? '演示中' : '检测中', 'var(--ok)', true);
      this.loop.start();
    }
  }

  /** 暂停按钮同时切换图标与文字（文字比图标更明确） */
  _setPauseButton(running) {
    setAttr($('#pauseIcon'), 'href', running ? '#i-pause' : '#i-play');
    setText($('#pauseLabel'), running ? '暂停' : '继续');
  }

  stop() {
    stopSession(this);
  }

  _setSimulate(on) {
    setSimulate(this, on);
  }

  /* ==================== 主循环帧回调 ==================== */

  _frame(now) {
    this.lastFrameAt = now;
    this.presenter.trackFps(now);
    this.presenter.checkFrameRateHealth(now);

    /* ---- 取得特征 ---- */
    let feat;
    if (this.simulate) {
      feat = this.sim.frame(now);
    } else {
      const result = this.engine.detect(this.video, now);
      if (!result) return; // 同一帧或未就绪
      feat = this.extractor.extract(result, now, this.camera ? this.camera.aspect : 4 / 3);
    }
    this.lastFeat = feat;

    /* ---- 标定阶段 ---- */
    if (this.state === State.CALIBRATING) {
      const done = this.calibrator.feed(feat, now);
      this.stage.updateCalibProgress(this.calibrator.progress(), feat.ok);
      this.presenter.drawOverlay(feat, { closed: false, mouthOpen: false });
      if (done) this._finishCalibration();
      return;
    }

    if (this.state !== State.RUNNING) return;

    /* ---- 数据质量评估 ----
     * 模拟模式没有真实画面与关键点，跳过质量门控（合成数据默认有效）。 */
    let quality = null;
    if (!this.simulate && feat.ok) {
      quality = {
        face: evaluateFaceQuality(feat.landmarks, this.camera ? this.camera.aspect : 4 / 3, feat, this.calib),
        lighting: this.lighting.evaluate(this.video, now),
      };
    }

    /* ---- 指标 → 融合 ---- */
    const ind = this.indicators.update(feat, this.calib, quality);
    const fus = this.fusion.evaluate(ind, this.calib);
    this.indicators.pushScore(now, fus.score);
    this.rawWin.push(now, fus.raw);
    this.lastInd = ind;
    this.lastFusion = fus;

    /* ---- 事件 ---- */
    const evts = this.indicators.drainNewEvents();
    if (evts.length) {
      this.recorder.addEvents(evts);
      this.timeline.add(evts);
    }

    /* ---- 报警 ---- */
    const alarmEv = this.alarm.update(fus.level, now, fus.override === 'critical_closure' ? '持续闭眼' : '');
    if (alarmEv) {
      this.recorder.addEvent(alarmEv);
      this.timeline.add([alarmEv]);
      this.alarmUi.showBanner(fus.level, CONFIG.alarm.byLevel[fus.level].speak || alarmEv.message);
    }

    /* ---- 记录 ---- */
    this.recorder.sample(ind, fus, feat);

    /* ---- 渲染 ---- */
    this.presenter.present(feat, ind, fus, now);
  }

  _finishCalibration() {
    const r = this.calibrator.result;
    this.calib = r;
    if (this.calibrator.state === CalibState.FAILED) {
      toastWarn('校准没成功', `${r.reason}，已改用通用标准。建议把光线调亮一点再重新校准。`);
    } else {
      toastOk('校准完成', `已记住你睁眼的样子，判定标准按你本人调好了 · 质量${r.qualityLabel}`);
    }
    if (!this.sm.send(SessionEvent.CALIBRATION_DONE, { calibration: r })) return;
    this._beginRunning();
    this.timeline.add([
      {
        type: 'calibrated',
        ts: performance.now(),
        level: 'info',
        message: `睁眼基准 ${r.earBaseline.toFixed(3)}，闭眼判定线 ${r.earCloseThresh.toFixed(3)}`,
      },
    ]);
  }
}

/* ==================== 启动 ==================== */

const app = new App();
installTestHooks(app, SessionState);

/* ==================== PWA（可选，默认关闭） ====================
 * 日常开发不注册 Service Worker（源码 no-store，改完刷新即生效）；
 * 答辩演示/断网场景显式开启：
 *   ?pwa=1  注册 SW 并记住开关（之后普通访问也保持离线能力）
 *   ?pwa=0  注销 SW、清空缓存并关闭开关（回到开发模式）
 * 详见 README "开发者与演示工具链" 一节。 */
(async () => {
  if (!('serviceWorker' in navigator)) return;
  const params = new URLSearchParams(location.search);
  try {
    if (params.get('pwa') === '0') {
      localStorage.removeItem('fatigue.pwa');
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      if ('caches' in window) {
        for (const key of await caches.keys()) await caches.delete(key);
      }
      console.log('[PWA] 已注销 Service Worker 并清空缓存（开发模式）');
      return;
    }
    if (params.get('pwa') === '1') localStorage.setItem('fatigue.pwa', '1');
    if (localStorage.getItem('fatigue.pwa') !== '1') return;
    const reg = await navigator.serviceWorker.register('./sw.js');
    console.log('[PWA] Service Worker 已注册（演示/离线模式）', reg.scope);
  } catch (err) {
    console.warn('[PWA] Service Worker 注册失败（不影响正常使用）:', err);
  }
})();

console.log(
  '%c驾驶员疲劳检测系统 %c已就绪 · 全部推理在本地浏览器完成',
  'font-weight:600;color:#3e6ae1',
  'color:#5c5e62'
);
