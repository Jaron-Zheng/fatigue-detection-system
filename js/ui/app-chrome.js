/**
 * app-chrome.js — 应用外壳：主题切换、专业模式、按钮状态同步、环境信息
 *
 * 第三轮角色二从 app.js 拆出。这些能力与检测会话的生命周期无关，
 * 只影响"界面长什么样"，改动后通过回调通知应用重绘画布类组件。
 */

import { $, setText, toggleClass } from '../util/dom.js';
import { CONFIG, loadUserConfig, resetConfig } from '../config.js';
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
    try {
      localStorage.setItem('fatigue.theme', next);
    } catch {
      /* 存储写满/隐私模式：主题本会话内仍生效，仅不持久化 */
    }
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
    try {
      localStorage.setItem('fatigue.proMode', on ? '1' : '0');
    } catch {
      /* 存储不可用：本会话内切换仍生效 */
    }
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

  /* ---------- 跨标签页同步 ---------- */

  /**
   * 监听 storage 事件，与其他标签页保持一致（storage 事件只在
   * "别的窗口"修改 localStorage 时在本地触发，正好用作被动方同步）。
   *
   * 不同步的后果（批次三角色7实测）：标签 A 切主题/专业模式/保存参数后，
   * 标签 B 的界面与内存 CONFIG 仍停留在旧值——B 随后生成的检测、消融
   * 实验、报告全部基于过期参数，且没有任何提示，属于沉默型状态-产出不一致。
   *
   * @param {() => void} [onConfigReloaded] 配置被远端更新后的回调
   *   （刷新指标卡窗口说明、重建设置抽屉滑块等依赖 CONFIG 的 DOM）
   */
  bindCrossTabSync(onConfigReloaded) {
    window.addEventListener('storage', (e) => {
      if (e.key === 'fatigue.theme') {
        const saved = e.newValue;
        if (saved === 'light' || saved === 'dark') {
          document.documentElement.dataset.theme = saved;
        } else {
          document.documentElement.dataset.theme = 'auto';
        }
        this._syncThemeIcon();
        // 图表取色依赖 CSS 变量，主题回放后必须重绘（与 toggleTheme 同口径）
        setTimeout(() => this._onThemeChanged(), 60);
      } else if (e.key === 'fatigue.proMode') {
        // notify=false：视觉立即对齐即可，不必用 toast 打断用户
        this._applyProMode(e.newValue === '1', false);
      } else if (e.key === 'fatigue.config.v1') {
        // newValue 为 null 说明另一窗口"恢复默认"（removeItem），需整体回落；
        // 否则重放补丁。saveUserConfig 每次写入完整分组，重放即得最新全量。
        if (e.newValue === null) resetConfig();
        else loadUserConfig();
        this.syncButtonStates();
        if (onConfigReloaded) onConfigReloaded();
        toast('设置已在其他窗口更新', '本页参数已同步为最新值', 'info', 3200);
      }
    });
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
    // GPU 串友好化：去掉 "(0x000021C4)" 这类十六进制设备 ID，
    // 超过 48 字符截断加省略号；origin 只留 host，不带协议
    const gpu = String(gl)
      .replace(/\s*\(0x[0-9A-Fa-f]+\)/g, '')
      .trim();
    const gpuText = gpu.length > 48 ? gpu.slice(0, 48) + '…' : gpu;
    setText(
      $('#footEnv'),
      `运行环境：${navigator.hardwareConcurrency || '?'} 逻辑核心 · ${gpuText} · ${location.host}`
    );
  }
}
