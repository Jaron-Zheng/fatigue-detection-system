/**
 * view-router.js — 三视图导航与页面级行为（键盘/可见性/全屏）
 *
 * 第三轮角色二从 app.js 拆出：视图切换规则、全局导航链接、
 * 空格暂停快捷键、页面隐藏自动暂停、全屏变化重绘，
 * 这些"页面怎么在三个视图间移动"的规则集中在一处，改起来不会漏。
 */

import { $ } from '../util/dom.js';
import { SessionState } from '../core/session-state-machine.js';
import { refreshMotion, runCountUp } from './motion.js';

export class ViewRouter {
  /** @param {object} app 应用组合根 */
  constructor(app) {
    this.app = app;
  }

  bind() {
    const app = this.app;

    $('#brandLink').addEventListener('click', (e) => {
      e.preventDefault();
      this.gotoView('viewHome');
    });

    /**
     * 全局导航的三个入口。
     *
     * 用事件委托而不是逐个绑定：链接是纯展示元素，
     * 真正的规则集中在 gotoView 里一处，改起来不会漏。
     */
    for (const link of document.querySelectorAll('.gn-links a[data-goto]')) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.gotoView(link.dataset.goto);
      });
    }

    // 退出全屏时（包括 Esc 键）重新测量 Canvas
    document.addEventListener('fullscreenchange', () => {
      setTimeout(() => app.presenter.redrawAfterResize(), 120);
    });

    // 键盘快捷键：空格暂停
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space' && (app.state === SessionState.RUNNING || app.state === SessionState.PAUSED)) {
        e.preventDefault();
        app.togglePause();
      }
    });

    // 页面隐藏时暂停，避免后台跑推理白耗电
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && app.state === SessionState.RUNNING) {
        app._autoPaused = true;
        app.togglePause();
      } else if (!document.hidden && app._autoPaused && app.state === SessionState.PAUSED) {
        app._autoPaused = false;
        app.togglePause();
      }
    });
  }

  switchView(id) {
    const app = this.app;
    for (const v of document.querySelectorAll('.view')) {
      v.classList.toggle('active', v.id === id);
    }
    // 视图切换后布局才确定，Canvas 需要在下一帧重新测量尺寸
    if (id === 'viewWork') {
      requestAnimationFrame(() => {
        app.overlay.resize();
        app.charts.resizeAll();
        app.drawCharts(performance.now());
      });
    } else if (id === 'viewReport') {
      requestAnimationFrame(() => {
        app.report.redraw();
        // 报告的数字是渲染完才有的，递增动画必须等到这一刻再启动
        refreshMotion($('#viewReport'));
        runCountUp($('#viewReport'));
      });
    }
  }

  gotoView(id) {
    const app = this.app;
    const target = document.getElementById(id);
    if (!target || !target.classList.contains('view')) return;

    this.switchView(id);
    if (id === 'viewWork' && app.state === SessionState.IDLE) app.showIdleStage();

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
}
