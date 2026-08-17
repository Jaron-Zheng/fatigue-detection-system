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
import { toast } from './toast.js';

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

    // 键盘快捷键：空格暂停（仅工作台生效——在首页/报告页按空格
    // 会"隐形"操控一个看不见的后台会话，用户完全不知情）
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const onWorkbench = document.querySelector('#viewWork.active') !== null;
      if (e.code === 'Space' && onWorkbench && (app.state === SessionState.RUNNING || app.state === SessionState.PAUSED)) {
        e.preventDefault();
        app.togglePause();
      }
    });

    // 页面隐藏时暂停，避免后台跑推理白耗电；回前台自动续跑，
    // 但必须 toast 告知——否则用户以为还暂停着，实际已在检测，
    // 对安全类产品这种"状态不透明"比打断更危险
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && app.state === SessionState.RUNNING) {
        // 先暂停再立标志：togglePause 内部会清除 _autoPaused，
        // 顺序反了标志立即失效，回前台就不会自动恢复了
        app.togglePause();
        app._autoPaused = true;
      } else if (!document.hidden && app._autoPaused && app.state === SessionState.PAUSED) {
        app._autoPaused = false;
        app.togglePause();
        toast('已自动继续检测', '刚才页面在后台被暂停，现在已恢复；如需暂停请点暂停按钮', 'info', 3200);
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

    /* 会话进行中不放行报告页：那里只有上一会话的过期报告或空态，
     * 用户可能导出半截数据或被旧结论误导。提示后带回工作台。
     * 正常结束（stopSession）走 switchView 直达，不受此限。 */
    const active = [SessionState.BOOTING, SessionState.CALIBRATING, SessionState.RUNNING, SessionState.PAUSED];
    if (id === 'viewReport' && active.includes(app.state)) {
      toast('检测进行中', '本次检测结束后会自动生成报告，已回到工作台', 'info', 3200);
      id = 'viewWork';
    }

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
