/**
 * view-router.js — 三视图导航与页面级行为（键盘/可见性/全屏）
 *
 * 视图切换规则、全局导航链接、空格暂停快捷键、
 * 页面隐藏自动暂停、全屏变化重绘，集中在一处。
 */

import { $ } from '../util/dom.js';
import { SessionState } from '../core/session-state-machine.js';
import { refreshMotion, runCountUp } from './motion.js';
import { toast } from './toast.js';

export class ViewRouter {
  /** @param {object} app 应用组合根 */
  constructor(app) {
    this.app = app;
    /** 视图顺序（用于判断切换方向，驱动导航底线动画） */
    this._viewOrder = ['viewHome', 'viewWork', 'viewReport'];
    this._lastView = 'viewHome';
  }

  bind() {
    const app = this.app;

    $('#brandLink').addEventListener('click', (e) => {
      e.preventDefault();
      this.gotoView('viewHome');
    });

    /**
     * 所有带 data-goto 的链接（顶栏导航 + 首页各处 CTA）。
     * 事件委托到 document，避免逐个容器圈定漏绑。
     */
    document.addEventListener('click', (e) => {
      const link = e.target.closest('a[data-goto]');
      if (!link) return;
      e.preventDefault();
      this.gotoView(link.dataset.goto);
    });

    // 退出全屏时重新测量 Canvas
    document.addEventListener('fullscreenchange', () => {
      setTimeout(() => app.presenter.redrawAfterResize(), 120);
    });

    // 空格暂停（仅工作台生效，避免在首页/报告页"隐形"操控后台会话）
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const onWorkbench = document.querySelector('#viewWork.active') !== null;
      if (e.code === 'Space' && onWorkbench && (app.state === SessionState.RUNNING || app.state === SessionState.PAUSED)) {
        e.preventDefault();
        app.togglePause();
      }
    });

    // 页面隐藏时暂停，回前台自动续跑，但必须 toast 告知
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && app.state === SessionState.RUNNING) {
        // 先暂停再立标志：顺序反了标志立即失效
        app.togglePause();
        app._autoPaused = true;
      } else if (!document.hidden && app._autoPaused && app.state === SessionState.PAUSED) {
        app._autoPaused = false;
        app.togglePause();
        toast('已自动继续检测', '刚才页面在后台被暂停，现在已恢复；如需暂停请点「暂停」', 'info', 3200);
      }
    });

    // 初始化导航高亮
    const activeView = document.querySelector('.view.active');
    if (activeView) {
      for (const link of document.querySelectorAll('.gn-links a[data-goto]')) {
        if (link.dataset.goto === activeView.id) {
          link.setAttribute('aria-current', 'page');
        } else {
          link.removeAttribute('aria-current');
        }
      }
    }
  }

  /* 切换视图（无转场动画，只有导航底线保留方向感知动效） */
  switchView(id) {
    const app = this.app;
    const prevId = this._lastView;

    // 点击当前视图不重播动画
    if (prevId === id) return;

    // 判断切换方向：向右导航为 forward，向左为 backward
    const prevIdx = this._viewOrder.indexOf(prevId);
    const nextIdx = this._viewOrder.indexOf(id);
    const direction = nextIdx >= prevIdx ? 'forward' : 'backward';

    // 给导航链接容器加方向类，驱动底线动画
    const linksEl = document.querySelector('.gn-links');
    if (linksEl) {
      linksEl.classList.remove('dir-prev', 'dir-next');
      linksEl.classList.add(direction === 'forward' ? 'dir-next' : 'dir-prev');
      setTimeout(() => {
        linksEl.classList.remove('dir-prev', 'dir-next');
      }, 500);
    }

    // 切换 active
    for (const v of document.querySelectorAll('.view')) {
      v.classList.toggle('active', v.id === id);
    }

    // 导航高亮（单一事实来源：switchView 和 gotoView 都走这里）
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
        refreshMotion($('#viewReport'));
        runCountUp($('#viewReport'));
      });
    }

    this._lastView = id;
  }

  /* 带会话状态裁决的视图切换（用户点击导航时走这里） */
  gotoView(id) {
    const app = this.app;
    const target = document.getElementById(id);
    if (!target || !target.classList.contains('view')) return;

    /* 会话进行中不放行报告页 */
    const active = [SessionState.BOOTING, SessionState.CALIBRATING, SessionState.RUNNING, SessionState.PAUSED];
    if (id === 'viewReport' && active.includes(app.state)) {
      toast('检测进行中', '本次检测结束后会自动生成报告，已回到工作台', 'info', 3200);
      id = 'viewWork';
    }

    /* 会话已结束（报告态）不放行工作台 */
    if (id === 'viewWork' && app.state === SessionState.REPORT) {
      toast('本次检测已结束', '报告已生成，可在此查看或导出；要开始新一轮，请点「再次检测」', 'info', 3600);
      id = 'viewReport';
    }

    this.switchView(id);
    if (id === 'viewWork' && app.state === SessionState.IDLE) app.showIdleStage();

    requestAnimationFrame(() => {
      refreshMotion(target);
      if (id === 'viewHome') runCountUp(target);
    });
    // 瞬时滚动归顶
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
}
