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
     * 所有带 data-goto 的链接（顶栏导航 + 首页各处 CTA）。
     *
     * 事件委托到 document：重设计后的 CTA 分布在首页各段落里，
     * 逐个按容器圈定会漏绑（第四轮真人走查发现首页收尾段
     * 「进入实时检测」点击后只跳 # 不进工作台）。
     * 真正的规则集中在 gotoView 里一处，改起来不会漏。
     */
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[data-goto]');
      if (!link) return;
      e.preventDefault();
      this.gotoView(link.dataset.goto);
    });

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
    // 导航高亮随一切视图切换更新（单一事实来源）：
    // start()/stopSession 走的是 switchView 而非 gotoView，
    // 只在 gotoView 里更新会漏掉「开始检测」「结束生成报告」两条路径
    for (const link of document.querySelectorAll('.gn-links a[data-goto]')) {
      const active = link.dataset.goto === id;
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
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

    requestAnimationFrame(() => {
      refreshMotion(target);
      if (id === 'viewHome') runCountUp(target);
    });
    // 视图切换用瞬时滚动：平滑滚动会与视图重排叠加成一段"看着没反应"的
    // 过渡（尤其从首页长页面切回时），干脆的立即归顶才符合 Tesla 的切换手感
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
}
