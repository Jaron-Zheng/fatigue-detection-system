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
import { toast, toastOk, toastWarn } from './ui/toast.js';
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
    /** 启动代次：每轮 start() 递增；跨 await 后代次不一致 = 本轮已被取消并由新一轮接管，必须静默退出 */
    this._startGen = 0;
    /** 会话看门狗状态（见 _watchdog）：最近一次成功推理 / 黑帧计数 / 提示节流 */
    this._wd = { lastInferAt: 0, lastPlayFixAt: 0, darkFrames: 0, darkWarnedAt: 0, mutedWarnedAt: 0, cpuFallbackDone: false };
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
    // 跨标签同步：其他窗口改主题/专业模式/保存参数后，本页立即对齐，
    // 避免后续检测与报告基于过期参数（批次三角色7缺陷修复）
    this.chrome.bindCrossTabSync(() => {
      // 依赖 CONFIG 的 DOM 必须一并刷新，否则说明文字与滑块仍是旧值
      setText($('#sPerclos'), `最近 ${CONFIG.window.perclosSec} 秒`);
      this.settings._build();
      this.settings._syncSwitches();
    });
    this.chrome.renderEnv();
    this.showIdleStage();
    // E3 启动自检：异步执行不阻塞首屏，结果渲染进设置抽屉。
    // 任何一项异常都不弹窗打断用户——清单本身就是展示面。
    this.preflight = null;
    this._runPreflight();
    // 动效必须最后启动：它要在 DOM 与主题都就位后才能正确测量与接管
    initMotion();
  }

  /** 启动自检：环境探测 + 渲染到设置抽屉（E3） */
  async _runPreflight() {
    try {
      const { runPreflight, preflightSummaryLabel } = await import('./core/preflight.js');
      this.preflight = await runPreflight();
      const ul = $('#preflightList');
      if (!ul) return;
      ul.replaceChildren(
        ...this.preflight.items.map((it) => {
          const li = document.createElement('li');
          li.className = 'preflight-item';
          li.dataset.status = it.status;
          const dot = document.createElement('span');
          dot.className = 'preflight-dot';
          const label = document.createElement('span');
          label.className = 'preflight-label';
          label.textContent = it.label;
          const status = document.createElement('span');
          status.className = 'preflight-status';
          status.textContent = { ok: '正常', warn: '降级', fail: '异常' }[it.status];
          const detail = document.createElement('span');
          detail.className = 'preflight-detail';
          detail.textContent = it.detail;
          li.append(dot, label, status, detail);
          return li;
        }),
      );
      const title = $('#preflightTitle');
      if (title) {
        title.textContent = `启动自检 · ${preflightSummaryLabel(this.preflight.summary)}`;
      }
    } catch (e) {
      // 自检自身失败不应影响应用：清单保留占位并给出可读原因
      const ul = $('#preflightList');
      if (ul) ul.textContent = `自检未完成：${String(e && e.message ? e.message : e)}`;
    }
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
    // 空态"开始一次检测"走与首页主按钮完全相同的启动链路（E10 解耦注入）
    this.report = new ReportView({
      onStart: () => this.start(false),
      // r3 P1：空态提示里的"开启专业模式"入口（this.chrome 在 _initDom 之后才创建，延迟取用）
      onToggleProMode: () => this.chrome && this.chrome.toggleProMode(),
    });
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
    $('#btnPrint').addEventListener('click', () => exportReportHtml(this.recorder));
    $('#btnBackWork').addEventListener('click', () => this.start(this.simulate));

    // 报警视觉回调由 UI 提供
    this.alarm.onVisualAlarm = (level) => this.alarmUi.flash(level);
    // B2 恢复通知回调（事件本体在主循环里写时间轴，此处只管弹通知）
    this.alarm.onRecovery = (ev) => this.alarmUi.notifyRecovery(ev);
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
    /* 已有活会话时绝不能静默吞掉这次点击——用户从首页/报告页点
     * "开始检测"会毫无反应，像是按钮坏了（真实用户反馈的"卡死"）。
     * 统一处理：带回工作台（会话画面所在处）+ toast 说明出路。 */
    if (this.sm.is(State.RUNNING, State.CALIBRATING, State.BOOTING)) {
      this.router.gotoView('viewWork');
      toast('已有进行中的检测', '已回到工作台；如需重新开始，请先结束当前检测', 'info', 3600);
      return;
    }
    if (this.sm.is(State.PAUSED)) {
      this.router.gotoView('viewWork');
      toast('检测处于暂停状态', '已回到工作台；点「继续」恢复检测，或先结束再重新开始', 'info', 3600);
      return;
    }

    // 报表页返回时的"再次检测"
    if (this.sm.is(State.REPORT)) {
      resetSession(this);
      this.report.resetReport();
    }
    if (!this.sm.send(SessionEvent.START)) return;

    this.startAbort = false;
    const gen = ++this._startGen;
    this.router.switchView('viewWork');
    this.stage.showBoot();
    this.dash.setStatus('正在初始化', 'var(--warn)', true);

    // 音频必须在用户手势链路内解锁
    await this.alarm.unlock();
    if (this._cancelledStopCamera(gen)) return;

    try {
      if (!this.simulate) {
        /* 摄像头与推理引擎并行启动，且摄像头请求先发出：
         *   · getUserMedia / video.play() 必须尽量贴近用户点击——首次模型
         *     加载可能长达数十秒，串行等完引擎再开摄像头时用户手势早已过期，
         *     部分浏览器（iOS 低电量模式、严格自动播放策略）会拒绝播放 → 黑屏；
         *   · 用户在模型加载期间就能看到自己的画面，"黑屏等待"的体感消失。
         * 摄像头失败不等引擎、引擎失败不等摄像头：任一失败立即进入错误舞台。 */
        const cameraP = this._startCamera();
        cameraP.catch(() => {}); // 由下方 await 统一处理，避免未捕获拒绝告警
        try {
          await this._bootEngine();
        } catch (engineErr) {
          // 引擎失败时摄像头可能仍在开启中：等它落定后再回收，避免幽灵流
          await cameraP.catch(() => {});
          throw engineErr;
        }
        if (this._cancelledStopCamera(gen)) return;
        await cameraP;
        if (this._cancelledStopCamera(gen)) return;
      } else {
        // 模拟模式无需摄像头与模型
        this.deviceInfo = { label: '模拟驾驶员（合成特征）', width: 0, height: 0 };
      }
    } catch (err) {
      if (this._cancelledStopCamera(gen)) return;
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
  _cancelledStopCamera(gen) {
    // 旧一轮 start() 在 await 期间被取消且用户已重新开始：状态机与摄像头已归新一轮所有，
    // 旧流程只能静默退出，否则会替新一轮 send(BEGIN_CALIBRATION) / failStart(FAIL) 造成串线
    if (gen !== undefined && gen !== this._startGen) return true;
    if (!this.startAbort) return false;
    if (this.camera) this.camera.stop();
    cancelStart(this, '已取消启动');
    return true;
  }

  _bootEngine() {
    return bootEngine(this);
  }

  async _startCamera() {
    await startCamera(this);
    if (this.camera) this.camera.onTrackLost = (err) => this._onTrackLost(err);
  }

  _switchCamera(id) {
    return switchCamera(this, id);
  }

  _beginCalibration() {
    this._resetWatchdog();
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
    if (!this.sm.send(SessionEvent.RECALIBRATE)) {
      /* 只在检测进行中/暂停时可重校准；其他状态下静默拒绝
       * 同样是"能点没反应"的假死体验，给出明确反馈。 */
      toast('当前无法重新校准', '重新校准只在检测进行中或暂停时可用', 'info', 3200);
      return;
    }
    this.indicators.reset();
    this.fusion.reset();
    this.alarm.reset();
    this.rawWin.clear();
    this.timeline.clear();
    this._beginCalibration();
  }

  _resetWatchdog() {
    this._wd = { lastInferAt: 0, lastPlayFixAt: 0, darkFrames: 0, darkWarnedAt: 0, mutedWarnedAt: 0, cpuFallbackDone: false, lastLightAt: 0 };
    this.lighting.reset();
  }

  _beginRunning() {
    this._resetWatchdog();
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
    /* 手动/键盘暂停必须清除自动暂停标志：否则"曾自动暂停过 → 用户手动
     * 恢复又手动暂停 → 切换标签页回来"会被 visibilitychange 误判为
     * "恢复上次自动暂停"，把用户明确按下的暂停擅自恢复成检测中。
     * 自动暂停路径在调用本方法之后再重新立标志（见 view-router.js）。 */
    this._autoPaused = false;
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
    } else {
      /* 两条迁移都被状态机拒绝（会话未开始或已结束时的陈旧/抢先点击）：
       * 静默吞掉会呈现"按钮能点但没反应"的假死状态，必须给反馈。 */
      toast('当前没有进行中的检测', '会话未开始或已结束，无法暂停或继续', 'info', 3200);
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

  _setSimulate(on, startStage = null) {
    setSimulate(this, on, startStage);
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
      if (!result) {
        // 同一帧或未就绪：交给看门狗判断是"正常去重"还是"画面卡死/推理持续失败"
        this._watchdog(now);
        return;
      }
      this._wd.lastInferAt = now;
      this._watchdogDarkFrame(now);
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
      if (alarmEv.type === 'recovery') {
        // B2 恢复事件：写时间轴留痕即可，通知由 alarm.onRecovery 回调发出
        this.recorder.addEvent(alarmEv);
        this.timeline.add([alarmEv]);
      } else {
        // 冷却期内的 suppressed 事件仍写入时间轴留痕，但不重复弹提示
        this.recorder.addEvent(alarmEv);
        this.timeline.add([alarmEv]);
        if (!alarmEv.suppressed) this.alarmUi.notify(fus.level, fus, alarmEv);
      }
    }

    /* ---- 记录 ---- */
    this.recorder.sample(ind, fus, feat);

    /* ---- 渲染 ---- */
    this.presenter.present(feat, ind, fus, now);
  }

  /* ==================== 会话看门狗 ==================== */

  /**
   * 推理长时间没有产出时的自愈与诊断（真机"黑屏/校准倒计时不动"的根修）。
   * 触发条件：连续 4 秒 detect() 未返回结果（同帧去重或推理抛错）。
   *   1. <video> 处于暂停（play() 被自动播放策略拒绝）→ 主动重试播放；
   *      重试仍失败 → 进入错误舞台，"重试"按钮的点击就是新的用户手势；
   *   2. 采集轨道已结束/被系统静音（拔线、隐私挡板、被其他应用抢占）→ 提示；
   *   3. GPU 推理连续抛错 → 运行期切换 CPU 委托，一次性。
   */
  _watchdog(now) {
    const wd = this._wd;
    if (!wd.lastInferAt) wd.lastInferAt = now; // 会话刚开始：从现在起计时
    const stalledMs = now - wd.lastInferAt;
    if (stalledMs < 4000) return;

    const video = this.video;
    const cam = this.camera;

    // 1) 画面暂停 —— 最常见的黑屏根因
    if (video && video.srcObject && video.paused && cam && now - wd.lastPlayFixAt > 3000) {
      wd.lastPlayFixAt = now;
      cam.ensurePlaying(2).then(
        () => {
          wd.lastInferAt = performance.now();
          toast('画面已恢复播放', '刚才浏览器暂停了摄像头画面，系统已自动恢复', 'info', 2600);
        },
        (err) => {
          if (!this.sm.is(State.CALIBRATING, State.RUNNING)) return;
          failStart(
            this,
            new Error('摄像头已授权，但浏览器拒绝播放画面（常见于 iPhone 低电量模式或浏览器自动播放限制）。请点击「重试」。', { cause: err }),
          );
        },
      );
      return;
    }

    // 2) 轨道不健康：ended 由 onTrackLost 处理；muted（系统暂停供帧）给出提示
    if (cam && cam.stream && !cam.healthy && now - wd.mutedWarnedAt > 15000) {
      wd.mutedWarnedAt = now;
      toastWarn('摄像头暂时没有画面', '设备可能被其他应用占用、隐私挡板关闭或系统暂停了供帧。若持续无画面，请在设置中切换摄像头。', 6000);
    }

    // 3) GPU 推理持续失败 → 运行期回退 CPU
    if (!wd.cpuFallbackDone && this.engine.consecutiveFailures >= 20 && this.engine.delegate !== 'CPU') {
      wd.cpuFallbackDone = true;
      this.engine.fallbackToCpu().then((ok) => {
        if (ok) {
          wd.lastInferAt = performance.now();
          toastWarn('已切换为 CPU 推理', '当前显卡的 GPU 推理持续失败，系统已自动改用 CPU 委托（帧率可能略降）', 5200);
          this.dash.updateEngineInfo({ avgMs: this.engine.avgInferMs, delegate: 'CPU' });
        } else if (this.sm.is(State.CALIBRATING, State.RUNNING)) {
          failStart(this, new Error('推理引擎在当前设备上持续失败（GPU 与 CPU 委托均不可用）。请更新显卡驱动或更换浏览器后重试。'));
        }
      });
    }
  }

  /**
   * 黑帧诊断：推理正常在跑但画面几乎全黑（红外摄像头、隐私挡板、镜头被遮），
   * 人脸不可能被检出，校准同样卡住。用光照监测的平均亮度判断，连续 ≥2 秒
   * 全黑给一次可操作提示（每 30 秒最多一次）。
   */
  _watchdogDarkFrame(now) {
    const wd = this._wd;
    const lit = this.lighting.evaluate(this.video, now);
    if (!lit || lit.valid === null) return;
    // evaluate 有 500ms 节流，未到间隔时返回缓存值；只在新评估时计数
    if (this._wd.lastLightAt === this.lighting.lastAt) return;
    this._wd.lastLightAt = this.lighting.lastAt;
    if (lit.average < 8 && lit.contrast < 6) wd.darkFrames++;
    else wd.darkFrames = 0;
    if (wd.darkFrames >= 4 && now - wd.darkWarnedAt > 30000) {
      wd.darkWarnedAt = now;
      this.dash.setStatus('画面全黑', 'var(--warn)', true);
      toastWarn(
        '摄像头画面全黑',
        '摄像头已开启但画面没有内容：请检查镜头是否被遮挡 / 隐私挡板是否关闭；若电脑有多个摄像头（如红外摄像头），请在设置中切换到普通彩色摄像头。',
        8000,
      );
    }
  }

  /** 采集轨道意外结束（拔线 / 系统撤销权限 / 被抢占）：进入错误舞台而不是静默黑屏 */
  _onTrackLost(err) {
    if (this.simulate) return;
    // 已有有效数据的会话：正常收束成报告，不让用户的数据随故障一起丢失
    if (this.sm.is(State.RUNNING, State.PAUSED) && this.recorder.samples.length > 30) {
      toastWarn('摄像头连接已断开', '本次检测已提前结束并生成报告', 6000);
      stopSession(this);
      return;
    }
    if (!this.sm.is(State.CALIBRATING, State.RUNNING, State.PAUSED, State.BOOTING)) return;
    failStart(this, err);
  }

  _finishCalibration() {
    const r = this.calibrator.result;
    this.calib = r;
    if (this.calibrator.state === CalibState.FAILED) {
      toastWarn('校准未成功', `${r.reason}，已改用通用标准。建议把光线调亮一点再重新校准。`);
    } else {
      toastOk('校准完成', `已记住你睁眼的样子，判定标准已按你的面部特征调整 · 质量${r.qualityLabel}`);
    }
    if (!this.sm.send(SessionEvent.CALIBRATION_DONE, { calibration: r })) return;
    // 校准完成瞬间在遮罩上短暂反馈 800ms（session-stage.showCalibrated 自己收尾）
    this.stage.showCalibrated();
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

/* ==================== ?demo= 一键演示（答辩直通车） ====================
 * 打开即自动进入演示模式并跳到工作台，省去「齿轮 → 滚到底 → 开开关 → 关抽屉」四步。
 *   ?demo=1         从头（清醒）开始完整剧本
 *   ?demo=mild      从轻度疲劳阶段开始
 *   ?demo=moderate  从中度疲劳阶段开始（约 30 秒出中度提醒，约 40 秒后升重度）
 * 提示：浏览器自动播放策略下报警声音需要一次任意点击/按键才会响，
 * 演示前先点一下页面即可。 */
(() => {
  const demo = new URLSearchParams(location.search).get('demo');
  if (!demo) return;
  const stage = ['awake', 'mild', 'moderate'].includes(demo) ? demo : 'awake';
  // 走与「设置里开演示开关 + 点开始检测」完全相同的语义：
  // IDLE 态不能用 SIM_ENTER（状态机只允许会话中途切入），
  // 配置 simulate 后经 start() 的 START→BOOTING→BEGIN_RUNNING 正规链路进入
  app.settings.swSimulate.checked = true;
  app.simulate = true;
  app.sim.reset();
  app.sim.setStartStage(stage);
  app.start(true);
})();

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
    const justEnabled = params.get('pwa') === '1';
    if (justEnabled) localStorage.setItem('fatigue.pwa', '1');
    if (localStorage.getItem('fatigue.pwa') !== '1') return;

    /* r3 P2：离线就绪必须对用户可见。
     * sw.js 现在在 install 阶段预缓存首页与全部源码，这里跟踪安装进度：
     *   · 首次开启（?pwa=1）：先提示"正在准备离线资源"，SW 激活后提示"已就绪"；
     *   · 安装失败（预缓存有文件 404/网络中断）：SW 变为 redundant，明确告知未就绪并给出重试办法；
     *   · 回访（SW 早已激活）：不打扰。 */
    const announceReady = (detail) => {
      toastOk(
        '离线模式已就绪',
        `已缓存首页与全部源码${detail ? `（${detail}）` : ''}，断网后仍可打开本页并运行演示模式。` +
          '真实摄像头检测需在线完成一次后才能离线使用（模型文件按需缓存）。',
        7000
      );
    };
    const announceFailed = () => {
      toastWarn('离线资源准备失败', '部分文件未能缓存（网络中断或资源缺失）。请联网后刷新页面重试；访问 ?pwa=0 可关闭离线模式。', 8000);
    };
    // 页面激活后 SW 会 postMessage SW_READY（含预缓存条目数）；同时兜底监听 statechange
    let announced = false;
    navigator.serviceWorker.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d.type === 'SW_READY' && justEnabled && !announced) {
        announced = true;
        announceReady(d.precached ? `${d.precached} 个文件` : '');
      }
    });

    if (justEnabled) toast('正在准备离线资源…', '首页与全部源码将写入本地缓存，完成后会再次提示。', 'info', 4000);
    const reg = await navigator.serviceWorker.register('./sw.js');
    console.log('[PWA] Service Worker 已注册（演示/离线模式）', reg.scope);

    const trackWorker = (worker) => {
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated' && justEnabled && !announced) {
          announced = true;
          announceReady('');
        } else if (worker.state === 'redundant' && !navigator.serviceWorker.controller) {
          // 没有任何已激活的 SW 兜底 → 本次安装失败
          announceFailed();
        }
      });
    };
    trackWorker(reg.installing);
    reg.addEventListener('updatefound', () => trackWorker(reg.installing));
    if (justEnabled && reg.active && !reg.installing && !reg.waiting && !announced) {
      // 再次带 ?pwa=1 进入且 SW 已激活：直接确认
      announced = true;
      announceReady('');
    }
  } catch (err) {
    console.warn('[PWA] Service Worker 注册失败（不影响正常使用）:', err);
    if (params.get('pwa') === '1') announceFailedSafe();
  }
  function announceFailedSafe() {
    toastWarn('离线模式开启失败', 'Service Worker 注册被浏览器拒绝（需 https 或 localhost）。不影响正常在线使用。', 8000);
  }
})();

console.log(
  '%c驾驶员疲劳检测系统 %c已就绪 · 全部推理在本地浏览器完成',
  'font-weight:600;color:#0071e3',
  'color:#5c5e62'
);
