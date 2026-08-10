/**
 * app-chrome.js — 应用外壳：主题切换、专业模式、按钮状态同步、环境信息
 *
 * 第三轮角色二从 app.js 拆出。这些能力与检测会话的生命周期无关，
 * 只影响"界面长什么样"，改动后通过回调通知应用重绘画布类组件。
 */

import { $, setText, toggleClass } from '../util/dom.js';
import { CONFIG } from '../config.js';
import { toast } from './toast.js';

export class AppChrome {
  /**
   * @param {object} options
   * @param {HTMLVideoElement} options.video
   * @param {()=>void} options.onThemeChanged 主题切换完成后（画布需重新取色重绘）
   * @param {()=>void} options.onLayoutChanged 显隐变化后（画布需重新测量尺寸）
   */
  constructor({ video, onThemeChanged, onLayoutChanged }) {
    this.video = video;
    this._onThemeChanged = onThemeChanged;
    this._onLayoutChanged = onLayoutChanged;
  }

  /* ---------- 主题 ---------- */

  initTheme() {
    const saved = localStorage.getItem('fatigue.theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.dataset.theme = saved;
    } else {
      document.documentElement.dataset.theme = 'auto';
    }
    this._syncThemeIcon();
  }

  toggleTheme() {
    const cur = document.documentElement.dataset.theme;
    const isDarkNow =
      cur === 'dark' || (cur === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDarkNow ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('fatigue.theme', next);
    this._syncThemeIcon();
    // 图表颜色取自 CSS 变量，主题切换后需要重新取色并重绘
    setTimeout(() => this._onThemeChanged(), 60);
  }

  _syncThemeIcon() {
    const cur = document.documentElement.dataset.theme;
    const isDark = cur === 'dark' || (cur === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    $('#themeIcon').setAttribute('href', isDark ? '#i-sun' : '#i-moon');
  }

  /* ---------- 专业模式 ---------- */

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
  initProMode() {
    const on = localStorage.getItem('fatigue.proMode') === '1';
    this._applyProMode(on, false);
  }

  toggleProMode() {
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
    requestAnimationFrame(() => this._onLayoutChanged());
    if (notify) {
      toast(
        on ? '专业模式已开启' : '专业模式已关闭',
        on ? '已展开全部技术指标与实验分析工具' : '界面已回到简洁视图',
        'info',
        2600
      );
    }
  }

  /* ---------- 状态同步与环境信息 ---------- */

  /** 页面加载后将按钮视觉状态与实际 CONFIG 同步（用户保存的配置可能与 HTML 默认值不同） */
  syncButtonStates() {
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

  renderEnv() {
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
}
