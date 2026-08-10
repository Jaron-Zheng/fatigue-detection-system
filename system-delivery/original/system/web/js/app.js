/**
 * app.js — 应用主控制器
 *
 * 职责：状态机 + 主循环 + 各模块编排。
 *
 * 数据流（单向，便于调试与论文画图）：
 *
 *   摄像头帧
 *      ↓ FaceEngine (WASM 推理)
 *   478 关键点 + 52 blendshape + 4×4 姿态矩阵
 *      ↓ FeatureExtractor
 *   EAR / MAR / pitch,yaw,roll / 语义系数        ← 特征层
 *      ↓ IndicatorEngine (滑动窗口 + 状态机)
 *   PERCLOS / 闭眼时长 / 眨眼率 / 哈欠 / 点头 …   ← 指标层
 *      ↓ FusionEngine (隶属函数 + 加权 + EMA + 滞回)
 *   疲劳指数 0–100 + 四级等级                     ← 融合层
 *      ↓
 *   AlarmSystem（声光报警） / Dashboard（可视化） / SessionRecorder（记录）
 */

import { CONFIG, loadUserConfig } from './config.js';
import { $, setText, setAttr, toggleClass, throttle, cssVar } from './util/dom.js';
import { fmtDuration, clamp } from './util/math.js';
import { TimeWindow } from './util/ring-buffer.js';

import { FaceEngine, CameraSource } from './core/face-engine.js';
import { FeatureExtractor } from './core/features.js';
import { Calibrator, CalibState } from './core/calibration.js';
import { IndicatorEngine } from './core/indicators.js';
import { FusionEngine } from './core/fusion.js';
import { AlarmSystem } from './core/alarm.js';
import { SessionRecorder, downloadFile, timestampName } from './core/recorder.js';
import { SimulatedDriver } from './core/sim-driver.js';
import { evaluateFaceQuality, LightingMonitor } from './core/quality.js';

import { Overlay } from './ui/overlay.js';
import { LineChart } from './ui/chart.js';
import { Dashboard } from './ui/dashboard.js';
import { Timeline } from './ui/timeline.js';
import { ReportView } from './ui/report.js';
import { SettingsPanel } from './ui/settings.js';
import { AnalysisPanel } from './ui/analysis-ui.js';
import { EvaluationPanel } from './ui/evaluation-ui.js';
import { toast, toastOk, toastWarn, toastError } from './ui/toast.js';
import { initMotion, refreshMotion, runCountUp } from './ui/motion.js';

const State = {
  IDLE: 'idle',
  BOOTING: 'booting',
  CALIBRATING: 'calibrating',
  RUNNING: 'running',
  PAUSED: 'paused',
  REPORT: 'report',
  ERROR: 'error',
};

class App {
  constructor() {
    /**
     * 必须放在最前面。
     *
     * 下面所有东西都会在构造阶段读取 CONFIG：IndicatorEngine 按
     * window.* 建滑动窗口、图表按 waveSec 定窗宽、SettingsPanel 按当前值渲染滑块。
     * 如果等到 _initTheme() 里才载入用户配置（之前就是这样），
     * 用户在设置里点了「保存」、刷新页面后会发现滑块又回到默认值——
     * 参数其实存进了 localStorage，只是读得太晚，界面与窗口都已经按默认值建好了。
     */
    loadUserConfig();

    this.state = State.IDLE;

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
    this.frameTimes = [];
    this.fps = 0;
    this.lastFrameAt = 0;
    this.lastChartAt = 0;
    this.loopRunning = false;
    this.loopTimer = null;
    this.lowFpsWarnedAt = 0;
    this.startAbort = false;
    this.rawWin = new TimeWindow(CONFIG.window.waveSec * 1000, 40);
    this.bannerTimer = null;
    this.veilTimer = null;

    this._initDom();
    this._initCharts();
    this._bindEvents();
    this._syncButtonStates();
    this._initTheme();
    this._initProMode();
    this._renderEnv();
    this._showIdleStage();
    // 动效必须最后启动：它要在 DOM 与主题都就位后才能正确测量与接管
    initMotion();
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

    this.stageOverlay = $('#stageOverlay');
    this.calibRing = $('#calibRing');
    this.calibBar = $('#calibBar');
    this.calibNum = $('#calibNum');
    this.overlayTitle = $('#overlayTitle');
    this.overlayText = $('#overlayText');
    this.overlayActions = $('#overlayActions');

    this.alarmVeil = $('#alarmVeil');
    this.alarmBanner = $('#alarmBanner');

    this.settings = new SettingsPanel({
      onWindowChange: () => {
        this.indicators.syncWindows();
        this.rawWin = new TimeWindow(CONFIG.window.waveSec * 1000, 40);
        this.chartScore.opts.windowMs = CONFIG.window.waveSec * 1000;
        this.chartEye.opts.windowMs = CONFIG.window.waveSec * 1000;
        setText($('#sPerclos'), `最近 ${CONFIG.window.perclosSec} 秒`);
      },
      onRenderChange: () => {
        toggleClass(this.video, 'mirrored', CONFIG.render.mirror);
        toggleClass($('#btnMirror'), 'is-on', CONFIG.render.mirror);
        toggleClass($('#btnMesh'), 'is-on', CONFIG.render.showMesh);
      },
      onTestAlarm: async () => {
        await this.alarm.unlock();
        this.alarm.test('moderate');
        this._flash('moderate');
      },
      onCameraChange: (id) => this._switchCamera(id),
      onDelegateChange: () => {
        toastWarn('推理委托已切换', '需要重新开始检测才会生效');
      },
      onSimulateChange: (on) => this._setSimulate(on),
    });

    // 指标卡的窗口说明是写死在 HTML 里的"最近 30 秒"，
    // 用户改过窗口长度并保存后必须按实际值刷新，否则数字与说明会对不上。
    setText($('#sPerclos'), `最近 ${CONFIG.window.perclosSec} 秒`);
  }

  _initCharts() {
    const wMs = CONFIG.window.waveSec * 1000;
    this.chartScore = new LineChart($('#chartScore'), {
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

    this.chartEye = new LineChart($('#chartEye'), {
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

    const onResize = throttle(() => {
      this.overlay.resize();
      this.chartScore.resize();
      this.chartEye.resize();
      this.report.redraw();
      this._drawCharts(performance.now());
    }, 140);
    window.addEventListener('resize', onResize);
  }

  _bindEvents() {
    $('#btnStart').addEventListener('click', () => this.start(false));

    $('#btnProMode').addEventListener('click', () => this._toggleProMode());

    $('#btnPause').addEventListener('click', () => this.togglePause());
    $('#btnStop').addEventListener('click', () => this.stop());
    $('#btnRecalib').addEventListener('click', () => this.recalibrate());

    /** 开关型按钮：同步视觉状态与 aria-pressed（屏幕阅读器需要知道开关状态） */
    const setToggle = (btn, on) => {
      toggleClass(btn, 'is-on', on);
      btn.setAttribute('aria-pressed', String(on));
    };

    $('#btnMesh').addEventListener('click', () => {
      const on = !CONFIG.render.showMesh;
      CONFIG.render.showMesh = on;
      CONFIG.render.showContours = on;
      CONFIG.render.showIris = on;
      setToggle($('#btnMesh'), on);
      $('#swMesh').checked = on;
      if (!on) this.overlay.clear();
    });

    $('#btnMirror').addEventListener('click', () => {
      const on = !CONFIG.render.mirror;
      CONFIG.render.mirror = on;
      toggleClass(this.video, 'mirrored', on);
      setToggle($('#btnMirror'), on);
      $('#swMirror').checked = on;
    });

    $('#btnHud').addEventListener('click', () => {
      const on = !CONFIG.render.showMetricsHud;
      CONFIG.render.showMetricsHud = on;
      $('#hud').style.opacity = on ? '1' : '0';
      setToggle($('#btnHud'), on);
    });

    $('#btnFullscreen').addEventListener('click', () => this._toggleFullscreen());

    $('#btnMute').addEventListener('click', () => {
      const muted = !this.alarm.muted;
      this.alarm.setMuted(muted);
      $('#muteIcon').setAttribute('href', muted ? '#i-mute' : '#i-sound');
      toggleClass($('#btnMute'), 'is-on', muted);
      toast(muted ? '已静音' : '已恢复声音', muted ? '视觉报警仍然有效' : '', 'info', 2000);
    });

    $('#btnTheme').addEventListener('click', () => this._toggleTheme());

    $('#btnDismissAlarm').addEventListener('click', () => this._hideBanner());

    $('#btnFilterEvents').addEventListener('click', (e) => {
      const only = !this.timeline.onlyAbnormal;
      this.timeline.setFilter(only);
      e.currentTarget.textContent = only ? '显示全部' : '仅看异常';
    });

    $('#btnExportJson').addEventListener('click', () => this._exportJson());
    $('#btnExportCsv').addEventListener('click', () => this._exportCsv());
    $('#btnPrint').addEventListener('click', () => this._exportReport());
    $('#btnBackWork').addEventListener('click', () => this.start(this.simulate));

    $('#brandLink').addEventListener('click', (e) => {
      e.preventDefault();
      this._gotoView('viewHome');
    });

    /**
     * 全局导航的三个入口。
     *
     * 用事件委托而不是逐个绑定：链接是纯展示元素，
     * 真正的规则集中在 _gotoView 里一处，改起来不会漏。
     */
    for (const link of document.querySelectorAll('.gn-links a[data-goto]')) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this._gotoView(link.dataset.goto);
      });
    }

    // 退出全屏时（包括 Esc 键）重新测量 Canvas
    document.addEventListener('fullscreenchange', () => {
      setTimeout(() => {
        this.overlay.resize();
        this._drawOverlay(this.lastFeat, {
          closed: this.lastInd ? this.lastInd.eyeState === 'closed' : false,
          mouthOpen: this.lastInd ? this.lastInd.mouthOpenMs > 0 : false,
          level: this.lastFusion ? this.lastFusion.level : 'awake',
        });
      }, 120);
    });

    // 键盘快捷键：空格暂停 / Esc 结束
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space' && (this.state === State.RUNNING || this.state === State.PAUSED)) {
        e.preventDefault();
        this.togglePause();
      }
    });

    // 报警视觉回调由 UI 提供
    this.alarm.onVisualAlarm = (level) => this._flash(level);

    // 页面隐藏时暂停，避免后台跑推理白耗电
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === State.RUNNING) {
        this._autoPaused = true;
        this.togglePause();
      } else if (!document.hidden && this._autoPaused && this.state === State.PAUSED) {
        this._autoPaused = false;
        this.togglePause();
      }
    });
  }

  /* ==================== 专业模式 ==================== */

  /**
   * 专业模式：一个开关切换界面的信息密度。
   *
   * 关闭（默认）：只留普通人能直接读懂的东西——疲劳指数、几个中文指标、
   *   报告结论与建议。这是日常使用的形态。
   * 打开：展开全部原始特征值（EAR/MAR/欧拉角）、融合贡献明细、个人基准值、
   *   算法参数滑块，以及三套实验工具（敏感性分析、离线复现、视频评测）。
   *   这是写论文与答辩演示的形态。
   *
   * 做成分层而不是直接删除：那些技术面板是毕业设计的实验数据来源，
   * 删掉论文就没有数据支撑；但一直摆在首屏又会让普通用户不知从何看起。
   */
  _initProMode() {
    const on = localStorage.getItem('fatigue.proMode') === '1';
    this._applyProMode(on, false);
  }

  _toggleProMode() {
    const on = !document.body.classList.contains('pro-mode');
    localStorage.setItem('fatigue.proMode', on ? '1' : '0');
    this._applyProMode(on, true);
  }

  _applyProMode(on, notify) {
    document.body.classList.toggle('pro-mode', on);
    const btn = $('#btnProMode');
    if (btn) {
      toggleClass(btn, 'is-on', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    // 显隐会改变卡片布局，Canvas 必须在新布局稳定后重新测量，
    // 否则图表会保持旧宽度、出现拉伸或空白。
    requestAnimationFrame(() => {
      this.overlay.resize();
      this.chartScore.resize();
      this.chartEye.resize();
      this._drawCharts(performance.now());
      this.report.redraw();
    });
    if (notify) {
      toast(
        on ? '专业模式已开启' : '专业模式已关闭',
        on ? '已展开全部技术指标与实验分析工具' : '界面已回到简洁视图',
        'info',
        2600
      );
    }
  }

  _initTheme() {
    const saved = localStorage.getItem('fatigue.theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.dataset.theme = saved;
    } else {
      document.documentElement.dataset.theme = 'auto';
    }
    this._syncThemeIcon();
  }

  _toggleTheme() {
    const cur = document.documentElement.dataset.theme;
    const isDarkNow =
      cur === 'dark' || (cur === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDarkNow ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('fatigue.theme', next);
    this._syncThemeIcon();
    // 图表颜色取自 CSS 变量，主题切换后需要重新取色并重绘
    setTimeout(() => {
      this.overlay.refreshTheme();
      this._refreshChartColors();
      this._drawCharts(performance.now());
      this.report.redraw();
    }, 60);
  }

  /** 页面加载后将按钮视觉状态与实际 CONFIG 同步（用户保存的配置可能与 HTML 默认值不同） */
  _syncButtonStates() {
    const setToggle = (btn, on) => {
      if (!btn) return;
      toggleClass(btn, 'is-on', on);
      btn.setAttribute('aria-pressed', String(on));
    };
    setToggle($('#btnMesh'), CONFIG.render.showMesh);
    setToggle($('#btnMirror'), CONFIG.render.mirror);
    setToggle($('#btnHud'), CONFIG.render.showMetricsHud);
    toggleClass(this.video, 'mirrored', CONFIG.render.mirror);
    $('#hud').style.opacity = CONFIG.render.showMetricsHud ? '1' : '0';
  }

  _syncThemeIcon() {
    const cur = document.documentElement.dataset.theme;
    const isDark = cur === 'dark' || (cur === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    $('#themeIcon').setAttribute('href', isDark ? '#i-sun' : '#i-moon');
  }

  _refreshChartColors() {
    this.chartScore.opts.series[0].color = cssVar('--text-quaternary', '#aeaeb2');
    this.chartScore.opts.series[1].color = cssVar('--chart-score', '#e8730c');
    this.chartEye.opts.series[0].color = cssVar('--chart-ear', '#0071e3');
    this.chartEye.opts.series[1].color = cssVar('--chart-mar', '#9a4bd6');
  }

  _renderEnv() {
    const gl = (() => {
      try {
        const c = document.createElement('canvas');
        const g = c.getContext('webgl2') || c.getContext('webgl');
        if (!g) return 'WebGL 不可用';
        const dbg = g.getExtension('WEBGL_debug_renderer_info');
        return dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'WebGL 可用';
      } catch {
        return '未知';
      }
    })();
    setText(
      $('#footEnv'),
      `运行环境：${navigator.hardwareConcurrency || '?'} 逻辑核心 · ${gl} · ${location.origin}`
    );
  }

  /* ==================== 生命周期 ==================== */

  async start(skipCalib = false) {
    if (this.state === State.RUNNING || this.state === State.CALIBRATING || this.state === State.BOOTING) return;

    // 报表页返回时的"再次检测"
    if (this.state === State.REPORT) this._resetSession();

    this.startAbort = false;
    this.state = State.BOOTING;
    this._switchView('viewWork');
    this._showBootStage();
    this.dash.setStatus('正在初始化', 'var(--warn)', true);

    // 音频必须在用户手势链路内解锁
    await this.alarm.unlock();
    if (this.startAbort) {
      this._cancelStart('已取消启动');
      return;
    }

    try {
      if (!this.simulate) {
        await this._bootEngine();
        if (this.startAbort) {
          if (this.camera) this.camera.stop();
          this._cancelStart('已取消启动');
          return;
        }
        await this._startCamera();
        if (this.startAbort) {
          if (this.camera) this.camera.stop();
          this._cancelStart('已取消启动');
          return;
        }
      } else {
        // 模拟模式无需摄像头与模型
        this.deviceInfo = { label: '模拟驾驶员（合成特征）', width: 0, height: 0 };
      }
    } catch (err) {
      if (this.startAbort) {
        this._cancelStart('已取消启动');
        return;
      }
      this._fail(err);
      return;
    }

    this.overlay.resize();
    this.chartScore.resize();
    this.chartEye.resize();

    if (skipCalib || this.simulate) {
      this.calib = this.simulate ? SimulatedDriver.calibration() : this.calibrator.useFallback();
      this._beginRunning();
      if (!this.simulate) {
        toastWarn('已跳过校准', '改用通用固定阈值，不同人的眼型差异可能带来误判');
      }
    } else {
      this._beginCalibration();
    }
  }

  async _bootEngine() {
    if (this.engine.ready) return;
    const box = $('#bootBox');
    box.hidden = false;
    const setProgress = (msg, pct) => {
      setText($('#bootMsg'), msg);
      $('#bootBar').style.width = pct + '%';
      this.dash.setStatus(msg, 'var(--warn)', true);
    };
    try {
      // 首屏可能已切走，仍然更新进度文本供状态栏使用
      await this.engine.init(setProgress);
      toastOk('推理引擎就绪', `委托 ${this.engine.delegate} · 模型已本地加载`);
    } finally {
      box.hidden = true;
    }
  }

  async _startCamera() {
    if (!this.camera) this.camera = new CameraSource(this.video);
    this.dash.setStatus('正在开启摄像头', 'var(--warn)', true);
    const info = await this.camera.start(this._cameraId || null);
    this.deviceInfo = info;
    const cams = await this.camera.listCameras();
    this.settings.setCameras(cams, this._cameraId);
    toggleClass(this.video, 'mirrored', CONFIG.render.mirror);
  }

  _cancelStart(status = '未启动') {
    this._stopLoop();
    const box = $('#bootBox');
    if (box) box.hidden = true;
    this.calibRing.hidden = true;
    this.state = State.IDLE;
    this._showIdleStage();
    this.dash.setStatus(status, 'var(--text-tertiary)', false);
  }

  _showIdleStage() {
    this.stageOverlay.hidden = false;
    this.calibRing.hidden = true;
    setText(this.overlayTitle, '准备好开始了吗？');
    setText(this.overlayText, '开启摄像头后，系统会先了解你的自然睁眼状态，再开始持续监测。');
    this.overlayActions.innerHTML = '';

    const start = document.createElement('button');
    start.className = 'btn btn-primary';
    start.type = 'button';
    start.textContent = '开始检测';
    start.addEventListener('click', () => this.start(false));
    this.overlayActions.appendChild(start);
  }

  _showBootStage() {
    this.stageOverlay.hidden = false;
    this.calibRing.hidden = true;
    setText(this.overlayTitle, '正在准备视觉引擎');
    setText(this.overlayText, '模型和摄像头均在本机启动，不会上传任何影像数据。');
    this.overlayActions.innerHTML = '';
  }

  async _switchCamera(id) {
    this._cameraId = id || null;
    if (this.state !== State.RUNNING && this.state !== State.PAUSED && this.state !== State.CALIBRATING) return;
    try {
      this.camera.stop();
      await this.camera.start(this._cameraId);
      this.engine.resetStats();
      this.recalibrate();
      toastOk('已切换摄像头', '正在重新校准');
    } catch (err) {
      toastError('切换失败', err.message);
    }
  }

  _beginCalibration() {
    this.state = State.CALIBRATING;
    this.extractor.reset();
    this.calibrator.start(performance.now());
    this.stageOverlay.hidden = false;
    this.calibRing.hidden = false;
    setText(this.overlayTitle, '正在认识你的眼睛');
    setText(this.overlayText, '请正视摄像头，自然睁眼、放松表情。系统在记录你平时睁眼的样子，作为判断闭眼的个人标准。');
    this.dash.setStatus('校准中', 'var(--warn)', true);

    /* 「直接开始」入口：
     * 首屏不再摆这个按钮（普通用户没有理由主动跳过校准），
     * 但功能必须保留——「有个人基准 vs 用通用固定阈值」是论文里的对照实验，
     * 少了它就没法量化个性化标定带来的提升。所以收在校准遮罩内做次要链接。 */
    this.overlayActions.innerHTML = '';
    const skip = document.createElement('button');
    skip.className = 'btn btn-ghost btn-sm';
    skip.type = 'button';
    skip.id = 'btnSkipCalib';
    skip.textContent = '跳过，直接开始';
    skip.title = '使用通用固定阈值。个体眼型差异可能带来误判，仅在做对照实验时使用';
    skip.addEventListener('click', () => {
      if (this.state !== State.CALIBRATING) return;
      this.calib = this.calibrator.useFallback();
      this._beginRunning();
      toastWarn('已跳过校准', '改用通用固定阈值，不同人的眼型差异可能带来误判');
    });
    this.overlayActions.appendChild(skip);

    this._startLoop();
  }

  recalibrate() {
    if (this.simulate) {
      toastWarn('演示模式无需校准');
      return;
    }
    if (this.state !== State.RUNNING && this.state !== State.PAUSED) return;
    this.indicators.reset();
    this.fusion.reset();
    this.alarm.reset();
    this._beginCalibration();
  }

  _beginRunning() {
    this.state = State.RUNNING;
    this.stageOverlay.hidden = true;
    this.calibRing.hidden = true;
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
    this._startLoop();
  }

  togglePause() {
    if (this.state === State.RUNNING) {
      this.state = State.PAUSED;
      this._stopLoop();
      this.stageOverlay.hidden = false;
      this.calibRing.hidden = true;
      setText(this.overlayTitle, '检测已暂停');
      setText(this.overlayText, '按空格键或点击「继续」按钮恢复检测。暂停期间不计入统计。');
      this.overlayActions.innerHTML = '';
      this._setPauseButton(false);
      this.dash.setStatus('已暂停', 'var(--text-tertiary)', false);
    } else if (this.state === State.PAUSED) {
      this.state = State.RUNNING;
      this.stageOverlay.hidden = true;
      this._setPauseButton(true);
      this.dash.setStatus(this.simulate ? '演示中' : '检测中', 'var(--ok)', true);
      this._startLoop();
    }
  }

  /** 暂停按钮同时切换图标与文字（文字比图标更明确） */
  _setPauseButton(running) {
    setAttr($('#pauseIcon'), 'href', running ? '#i-pause' : '#i-play');
    setText($('#pauseLabel'), running ? '暂停' : '继续');
  }

  /** 全屏：优先放大视频舞台，退出时恢复画布尺寸 */
  async _toggleFullscreen() {
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
    setTimeout(() => {
      this.overlay.resize();
      this._drawOverlay(this.lastFeat, {
        closed: this.lastInd ? this.lastInd.eyeState === 'closed' : false,
        mouthOpen: this.lastInd ? this.lastInd.mouthOpenMs > 0 : false,
        level: this.lastFusion ? this.lastFusion.level : 'awake',
      });
    }, 120);
  }

  stop() {
    if (this.state === State.BOOTING || this.state === State.CALIBRATING) {
      this.startAbort = true;
      if (this.camera) this.camera.stop();
      this.alarm.reset();
      this._hideBanner();
      this._hideVeil();
      this._cancelStart('已取消启动');
      toast('已取消启动', '当前初始化/校准流程已停止', 'info', 2200);
      return;
    }
    if (this.state !== State.RUNNING && this.state !== State.PAUSED) return;
    this._stopLoop();
    this.recorder.end();
    if (this.camera) this.camera.stop();
    this.alarm.reset();
    this._hideBanner();
    this._hideVeil();
    this.state = State.REPORT;
    this.dash.setStatus('已结束', 'var(--text-tertiary)', false);

    const summary = this.recorder.summary(this.lastInd, this.lastFusion, {
      delegate: this.simulate ? '模拟' : this.engine.delegate,
      avgMs: this.engine.avgInferMs,
      frames: this.engine.stats.infer,
    });
    // 必须先切换视图再渲染：报告页在 .view 未 active 时是 display:none，
    // 此时 canvas 的 getBoundingClientRect() 为 0，图表会画成空白。
    this._switchView('viewReport');
    this.report.render(summary, this.recorder.samples);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toastOk('检测结束', `已生成报告 · 时长 ${summary.durationText}`);
  }

  _resetSession() {
    this.indicators.reset();
    this.fusion.reset();
    this.alarm.reset();
    this.rawWin.clear();
    this.lastInd = null;
    this.lastFusion = null;
    this.lastFeat = null;
    this.overlay.clear();
  }

  _fail(err) {
    if (this.camera) this.camera.stop();
    const box = $('#bootBox');
    if (box) box.hidden = true;
    this.state = State.ERROR;
    this._stopLoop();
    const msg = (err && err.message) || String(err);
    this.stageOverlay.hidden = false;
    this.calibRing.hidden = true;
    setText(this.overlayTitle, '无法开始检测');
    setText(this.overlayText, msg);
    this.overlayActions.innerHTML = '';
    const retry = document.createElement('button');
    retry.className = 'btn btn-primary';
    retry.textContent = '重试';
    retry.addEventListener('click', () => this.start(false));
    const simBtn = document.createElement('button');
    simBtn.className = 'btn btn-secondary';
    simBtn.textContent = '改用演示模式';
    simBtn.addEventListener('click', () => {
      this._setSimulate(true);
      this.settings.swSimulate.checked = true;
      this.start(true);
    });
    this.overlayActions.append(retry, simBtn);
    this.dash.setStatus('启动失败', 'var(--danger)', false);
    toastError('启动失败', msg);
    console.error(err);
  }

  _setSimulate(on) {
    this.simulate = on;
    this.sim.reset();
    if (on) {
      if (this.camera) this.camera.stop();
      toast('演示模式已开启', '将按预设剧本模拟一段由清醒到重度疲劳的过程，不使用摄像头', 'info', 4200);
      if (
        this.state === State.RUNNING ||
        this.state === State.PAUSED ||
        this.state === State.CALIBRATING
      ) {
        this.startAbort = true;
        this._stopLoop();
        this.calib = SimulatedDriver.calibration();
        this._beginRunning();
      }
    } else {
      toast('演示模式已关闭', '请重新开始检测以启用真实摄像头', 'info', 3000);
      if (
        this.state === State.RUNNING ||
        this.state === State.PAUSED ||
        this.state === State.CALIBRATING
      ) {
        this.startAbort = true;
        if (this.camera) this.camera.stop();
        this._stopLoop();
        this.state = State.IDLE;
        this.dash.setStatus('未启动');
      }
    }
  }

  /* ==================== 主循环 ==================== */

  /**
   * 主循环采用 setTimeout 定时驱动，而不是 requestAnimationFrame。
   *
   * 原因：rAF 与显示合成器绑定，在窗口被遮挡、系统节能、低刷新率或
   * 无头环境下会被大幅降频（实测可低至 1fps）。而 PERCLOS 这类指标是
   * 「按帧统计闭眼占比」，采样率骤降会直接让指标失真——对安全相关功能
   * 不可接受。setTimeout 不受合成器节流影响，配合耗时补偿可稳定维持
   * 目标帧率。页面真正切到后台时，由 visibilitychange 主动暂停，不会白耗电。
   */
  _startLoop() {
    if (this.loopRunning) return;
    this.loopRunning = true;
    const tick = () => {
      if (!this.loopRunning) return;
      const t0 = performance.now();
      try {
        this._frame(t0);
      } catch (err) {
        console.error('[主循环] 异常：', err);
      }
      // 扣除本帧计算耗时，保持平均节拍稳定
      const interval = 1000 / Math.max(8, CONFIG.capture.targetFps);
      const cost = performance.now() - t0;
      this.loopTimer = setTimeout(tick, Math.max(2, interval - cost));
    };
    this.loopTimer = setTimeout(tick, 0);
  }

  _stopLoop() {
    this.loopRunning = false;
    if (this.loopTimer !== null) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
  }

  _frame(now) {
    this.lastFrameAt = now;

    // FPS 统计
    this.frameTimes.push(now);
    while (this.frameTimes.length > 30) this.frameTimes.shift();
    if (this.frameTimes.length > 2) {
      const span = this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0];
      this.fps = span > 0 ? ((this.frameTimes.length - 1) * 1000) / span : 0;
    }
    this._checkFrameRateHealth(now);

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
      this._renderCalibProgress(now, feat);
      this._drawOverlay(feat, { closed: false, mouthOpen: false });
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
      this._showBanner(fus.level, CONFIG.alarm.byLevel[fus.level].speak || alarmEv.message);
    }

    /* ---- 记录 ---- */
    this.recorder.sample(ind, fus, feat);

    /* ---- 渲染 ---- */
    this._drawOverlay(feat, {
      closed: ind.eyeState === 'closed',
      mouthOpen: ind.mouthOpenMs > 0,
      level: fus.level,
    });
    this.dash.updateHud(feat, ind, this.fps, now);
    this.dash.setFaceState(ind.facePresent, ind.facePresent ? 0 : 2000);
    this.dash.setQualityState(ind);
    this.dash.updateScore(fus, ind, FusionEngine.explain(fus, ind));
    this.dash.updateMetrics(ind, fus, now);

    if (now - this.lastChartAt > 180) {
      this.lastChartAt = now;
      this._drawCharts(now);
      this.dash.updateEngineInfo({
        avgMs: this.simulate ? 0 : this.engine.avgInferMs,
        delegate: this.simulate ? '模拟' : this.engine.delegate || '--',
      });
    }
  }

  /**
   * 帧率健康度监测。
   *
   * PERCLOS 是按帧统计的时间占比，采样率过低会让指标失真（例如 5fps 时，
   * 一次 200ms 的眨眼可能完全落在采样间隔之间而被漏掉）。
   * 因此实际帧率持续低于目标的一半时，主动提示用户，而不是让系统
   * 悄悄给出不可靠的结论——这属于安全相关功能应有的自我诚实。
   */
  _checkFrameRateHealth(now) {
    if (this.state !== State.RUNNING) return;
    if (this.frameTimes.length < 20) return;
    const target = Math.max(8, CONFIG.capture.targetFps);
    if (this.fps >= target * 0.5) return;
    if (now - this.lowFpsWarnedAt < 30000) return;
    this.lowFpsWarnedAt = now;
    toastWarn(
      '帧率偏低',
      `当前 ${this.fps.toFixed(1)} FPS（目标 ${target}）。PERCLOS 等时间窗指标精度会下降，建议关闭其他占用 GPU 的程序，或在设置中改用 CPU 委托。`,
      6500
    );
  }

  _drawOverlay(feat, state) {
    if (!CONFIG.render.showMesh && !CONFIG.render.showContours) {
      this.overlay.clear();
      return;
    }
    if (this.simulate) {
      this.overlay.drawSynthetic(feat, state);
    } else {
      this.overlay.draw(feat, state, { vw: this.video.videoWidth, vh: this.video.videoHeight });
    }
  }

  _renderCalibProgress(now, feat) {
    const p = this.calibrator.progress();
    const CIRC = 2 * Math.PI * 52;
    this.calibBar.style.strokeDashoffset = String(CIRC * (1 - p));
    const remain = Math.ceil(CONFIG.calibration.durationSec * (1 - p));
    setText(this.calibNum, String(Math.max(0, remain)));
    // 倒计时按有效时长走，人脸不在画面时会停住，
    // 所以这里必须说清楚"为什么不动"，否则用户只会觉得卡住了
    setText(
      this.overlayText,
      feat.ok
        ? '请正视摄像头，自然睁眼、放松表情。系统在记录你平时睁眼的样子，作为判断闭眼的个人标准。'
        : '还没看到你的脸，倒计时已暂停。请让面部完整进入画面，光线不要太暗。'
    );
  }

  _finishCalibration() {
    const r = this.calibrator.result;
    this.calib = r;
    if (this.calibrator.state === CalibState.FAILED) {
      toastWarn('校准没成功', `${r.reason}，已改用通用标准。建议把光线调亮一点再重新校准。`);
    } else {
      toastOk('校准完成', `已记住你睁眼的样子，判定标准按你本人调好了 · 质量${r.qualityLabel}`);
    }
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

  _drawCharts(now) {
    const wf = this.indicators.waveforms();
    this.chartScore.render({ score: wf.score, raw: this.rawWin.toArray() }, now);

    // 闭眼阈值参考线随标定结果动态更新
    if (this.calib) {
      this.chartEye.opts.refLines = [
        {
          y: this.calib.earCloseThresh,
          color: cssVar('--danger', '#e5322d'),
          label: `闭眼阈值 ${this.calib.earCloseThresh.toFixed(3)}`,
        },
        {
          y: this.calib.marOpenThresh,
          color: cssVar('--chart-mar', '#9a4bd6'),
          label: `张口阈值 ${this.calib.marOpenThresh.toFixed(2)}`,
          dash: [2, 3],
        },
      ];
    }
    this.chartEye.render({ ear: wf.ear, mar: wf.mar }, now);
  }

  /* ==================== 报警视觉 ==================== */

  _flash(level) {
    if (!CONFIG.alarm.flashEnabled) return;
    setAttr(this.alarmVeil, 'data-level', level);
    this.alarmVeil.classList.add('on');
    clearTimeout(this.veilTimer);
    const dur = level === 'severe' ? 3400 : level === 'moderate' ? 2200 : 1400;
    this.veilTimer = setTimeout(() => this._hideVeil(), dur);
  }

  _hideVeil() {
    this.alarmVeil.classList.remove('on');
  }

  _showBanner(level, text) {
    setAttr(this.alarmBanner, 'data-level', level);
    setText($('#alarmText'), text);
    this.alarmBanner.classList.add('show');
    this.alarmBanner.setAttribute('aria-hidden', 'false');
    // 横幅占据顶部时把 Toast 下移，避免两者叠在一起
    document.body.classList.add('has-alarm');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => this._hideBanner(), level === 'severe' ? 8000 : 5000);
  }

  _hideBanner() {
    this.alarmBanner.classList.remove('show');
    this.alarmBanner.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('has-alarm');
  }

  /* ==================== 视图与导出 ==================== */

  _switchView(id) {
    for (const v of document.querySelectorAll('.view')) {
      v.classList.toggle('active', v.id === id);
    }
    // 视图切换后布局才确定，Canvas 需要在下一帧重新测量尺寸
    if (id === 'viewWork') {
      requestAnimationFrame(() => {
        this.overlay.resize();
        this.chartScore.resize();
        this.chartEye.resize();
        this._drawCharts(performance.now());
      });
    } else if (id === 'viewReport') {
      requestAnimationFrame(() => {
        this.report.redraw();
        // 报告的数字是渲染完才有的，递增动画必须等到这一刻再启动
        refreshMotion($('#viewReport'));
        runCountUp($('#viewReport'));
      });
    }
  }

  _gotoView(id) {
    const target = document.getElementById(id);
    if (!target || !target.classList.contains('view')) return;

    this._switchView(id);
    if (id === 'viewWork' && this.state === State.IDLE) this._showIdleStage();

    for (const link of document.querySelectorAll('.gn-links a[data-goto]')) {
      const active = link.dataset.goto === id;
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }

    requestAnimationFrame(() => {
      refreshMotion(target);
      if (id === 'viewHome') runCountUp(target);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  _exportJson() {
    const data = this.recorder.toJSON(this.lastInd, this.lastFusion, {
      delegate: this.simulate ? '模拟' : this.engine.delegate,
      avgMs: this.engine.avgInferMs,
      frames: this.engine.stats.infer,
    });
    downloadFile(timestampName('疲劳检测报告', 'json'), JSON.stringify(data, null, 2), 'application/json');
    toastOk('已导出 JSON', `${data.samples.length} 个采样点 · ${data.events.length} 条事件`);
  }

  _exportCsv() {
    const csv = this.recorder.toCSV();
    downloadFile(timestampName('疲劳检测指标', 'csv'), csv, 'text/csv;charset=utf-8');
    toastOk('已导出 CSV', '可直接用 Excel 打开绘图');
  }

  /**
   * 把报告页序列化为独立 HTML 文件直接下载，无需弹出打印对话框。
   * Canvas 图表转为 base64 data URL 内联，CSS 从已加载的样式表提取后内联，
   * 结果是一个可以在任何浏览器里双击打开的自包含报告文件。
   */
  async _exportReport() {

    // 把 Canvas 元素替换成等尺寸的 <img>（base64），避免跨上下文丢失图像
    const reportEl = document.getElementById('viewReport');
    const clone = reportEl.cloneNode(true);

    // 复制 Canvas 内容为 img
    reportEl.querySelectorAll('canvas').forEach((canvas, i) => {
      const img = clone.querySelectorAll('canvas')[i];
      if (!img) return;
      const dataUrl = canvas.toDataURL('image/png');
      const replacement = document.createElement('img');
      replacement.src = dataUrl;
      replacement.style.cssText = `width:100%;height:${canvas.offsetHeight}px;display:block;`;
      img.replaceWith(replacement);
    });

    // 移除不需要打印的按钮区域
    clone.querySelectorAll('.no-print').forEach((el) => el.remove());

    // 收集当前页面所有已加载的 CSS 文本（内联样式表 + <link> 表）
    let cssText = '';
    for (const sheet of document.styleSheets) {
      try {
        cssText += Array.from(sheet.cssRules).map((r) => r.cssText).join('\n') + '\n';
      } catch {
        // 跨域样式表无法读取，跳过
      }
    }

    // 把 CSS 变量当前计算值解析进来（确保颜色正确）
    const computed = getComputedStyle(document.documentElement);
    const vars = [
      '--bg','--bg-elevated','--bg-inset','--bg-sunken','--text','--text-secondary',
      '--text-tertiary','--text-quaternary','--accent','--accent-soft','--separator',
      '--separator-soft','--fill-quaternary','--fill-tertiary','--ok','--ok-soft',
      '--warn','--warn-soft','--caution','--caution-soft','--danger','--danger-soft',
      '--lv-awake','--lv-mild','--lv-moderate','--lv-severe',
      '--chart-score','--chart-ear','--chart-mar',
      '--sp-2','--sp-3','--sp-4','--sp-5','--sp-6','--sp-8',
      '--r-sm','--r-md','--r-lg','--r-xl',
      '--fs-hero','--fs-title','--fs-headline','--fs-subhead','--fs-body',
      '--fs-callout','--fs-caption','--fs-micro',
    ];
    const resolvedVars = vars.map((v) => `${v}:${computed.getPropertyValue(v).trim()}`).join(';');

    const title = document.getElementById('rpTitle')?.textContent || '疲劳检测报告';
    const subtitle = document.getElementById('rpSubtitle')?.textContent || '';

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
:root{${resolvedVars}}
${cssText}
/* 打印专用：去掉浏览器自动加的页眉/页脚/边框 */
@page{size:A4;margin:12mm 10mm;}
body{background:#fff!important;color:#1d1d1f!important;}
.card{box-shadow:none!important;border:none!important;break-inside:avoid;}
.global-nav,.subnav,.controls,.alarm-veil,.alarm-banner,.toast-host,.no-print{display:none!important;}
#viewReport{display:block!important;}
.view{display:block!important;}
/* 导出的 HTML 里没有 .has-motion（那是 motion.js 在运行时加的），
   起始态本就不会命中；这条只是双保险，防止将来样式调整后
   导出文件里出现"内容透明"这种最难排查的问题。 */
[data-reveal]{opacity:1!important;transform:none!important;filter:none!important;}
</style>
</head>
<body data-theme="light">
${clone.outerHTML}
</body>
</html>`;

    const name = timestampName('疲劳检测报告', 'html');
    downloadFile(name, html, 'text/html;charset=utf-8');
    toastOk('报告已下载', '双击文件即可在浏览器中查看，也可打印为 PDF');
  }
}

/* ==================== 启动 ==================== */

const app = new App();

/**
 * 暴露测试钩子：自动化验收脚本通过它驱动系统、读取内部状态。
 * 生产环境如需隐藏，可在此处加环境判断。
 */
window.__fatigue = {
  app,
  State,
  get state() {
    return app.state;
  },
  get score() {
    return app.lastFusion ? app.lastFusion.score : null;
  },
  get level() {
    return app.lastFusion ? app.lastFusion.level : null;
  },
  get indicators() {
    return app.lastInd;
  },
  get fusion() {
    return app.lastFusion;
  },
  get engineReady() {
    return app.engine.ready;
  },
  get engineError() {
    return app.engine.initError ? String(app.engine.initError.message || app.engine.initError) : null;
  },
  get alarmFireCount() {
    return app.alarm.fireCount;
  },
  get eventTotals() {
    return app.lastInd ? app.lastInd.totals : null;
  },
  get simPhase() {
    return app.sim.phaseName;
  },
  /** 启动模拟检测（自动化测试入口） */
  async startSimulation() {
    app.simulate = true;
    app.sim.reset();
    if (app.settings.swSimulate) app.settings.swSimulate.checked = true;
    app.alarm.setMuted(true); // 测试时静音，避免无人值守下持续鸣响
    await app.start(true);
    return app.state;
  },
  /** 仅初始化推理引擎（验证模型与 wasm 本地化是否正确） */
  async initEngineOnly() {
    try {
      await app._bootEngine();
      return { ok: true, delegate: app.engine.delegate };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  },
  stop: () => app.stop(),
  /** 让模拟剧本快进：直接把模拟起点往前挪，用于快速到达重度阶段 */
  fastForward(ms) {
    if (app.sim.t0 !== null) app.sim.t0 -= ms;
    return app.sim.phaseName;
  },
};

console.log(
  '%c驾驶员疲劳检测系统 %c已就绪 · 全部推理在本地浏览器完成',
  'font-weight:600;color:#0071e3',
  'color:#6e6e73'
);
