/**
 * frame-presenter.js — 每帧渲染、FPS 统计与帧率健康度监测
 *
 * 第三轮角色二从 app.js 拆出：把一帧数据"画到哪里、怎么显示"的
 * 细节集中在此；app.js 的帧回调只保留数据管线的编排。
 */

import { CONFIG } from '../config.js';
import { FusionEngine } from '../core/fusion.js';
import { toastWarn } from './toast.js';

export class FramePresenter {
  /** @param {object} app 应用组合根 */
  constructor(app) {
    this.app = app;
    this.frameTimes = [];
    this.fps = 0;
    this.lastChartAt = 0;
    this.lowFpsWarnedAt = 0;
  }

  /** 记录帧时间戳并更新滑动 FPS 统计 */
  trackFps(now) {
    this.frameTimes.push(now);
    while (this.frameTimes.length > 30) this.frameTimes.shift();
    if (this.frameTimes.length > 2) {
      const span = this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0];
      this.fps = span > 0 ? ((this.frameTimes.length - 1) * 1000) / span : 0;
    }
    return this.fps;
  }

  /**
   * 帧率健康度监测。
   *
   * PERCLOS 是按帧统计的时间占比，采样率过低会让指标失真（例如 5fps 时，
   * 一次 200ms 的眨眼可能完全落在采样间隔之间而被漏掉）。
   * 因此实际帧率持续低于目标的一半时，主动提示用户，而不是让系统
   * 悄悄给出不可靠的结论——这属于安全相关功能应有的自我诚实。
   */
  checkFrameRateHealth(now) {
    if (!this.app.isRunning()) return;
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

  drawOverlay(feat, state) {
    const app = this.app;
    if (!CONFIG.render.showMesh && !CONFIG.render.showContours) {
      app.overlay.clear();
      return;
    }
    if (app.simulate) {
      app.overlay.drawSynthetic(feat, state);
    } else {
      app.overlay.draw(feat, state, { vw: app.video.videoWidth, vh: app.video.videoHeight });
    }
  }

  /** 全屏等尺寸变化后按最新一帧数据重画叠加层 */
  redrawAfterResize() {
    const app = this.app;
    app.overlay.resize();
    this.drawOverlay(app.lastFeat, {
      closed: app.lastInd ? app.lastInd.eyeState === 'closed' : false,
      mouthOpen: app.lastInd ? app.lastInd.mouthOpenMs > 0 : false,
      level: app.lastFusion ? app.lastFusion.level : 'awake',
    });
  }

  /** 运行态每帧的可视化刷新：叠加层 + 仪表盘 + 节流图表 */
  present(feat, ind, fus, now) {
    const app = this.app;
    this.drawOverlay(feat, {
      closed: ind.eyeState === 'closed',
      mouthOpen: ind.mouthOpenMs > 0,
      level: fus.level,
    });
    app.dash.updateHud(feat, ind, this.fps, now);
    app.dash.setFaceState(ind.facePresent, ind.facePresent ? 0 : 2000);
    app.dash.setQualityState(ind);
    app.dash.updateScore(fus, ind, FusionEngine.explain(fus, ind));
    app.dash.updateMetrics(ind, fus, now);

    if (now - this.lastChartAt > 180) {
      this.lastChartAt = now;
      app.drawCharts(now);
      app.dash.updateEngineInfo({
        avgMs: app.simulate ? 0 : app.engine.avgInferMs,
        delegate: app.simulate ? '模拟' : app.engine.delegate || '--',
      });
    }
  }
}
