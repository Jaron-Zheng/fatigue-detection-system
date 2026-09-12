/**
 * render-loop.js — 主循环调度器（不依赖 DOM）
 *
 * 按 setTimeout 定时驱动帧回调，扣除本帧计算耗时保持平均节拍稳定。
 * 不用 requestAnimationFrame：rAF 与显示合成器绑定，在窗口被遮挡、
 * 系统节能、低刷新率或无头环境下会被大幅降频（实测可低至 1fps），
 * 而 PERCLOS 这类按帧统计的指标对采样率骤降不可接受。
 */

import { MIN_CAPTURE_FPS } from '../config.js';

export class RenderLoop {
  /**
   * @param options.onFrame 每帧回调，参数为 performance.now()
   * @param options.targetFps 目标帧率提供者（允许运行期读取最新配置）
   * @param options.onError 帧回调异常处理器
   */
  constructor({ onFrame, targetFps, onError }) {
    if (typeof onFrame !== 'function') throw new Error('RenderLoop 需要 onFrame 回调');
    this._onFrame = onFrame;
    this._targetFps = typeof targetFps === 'function' ? targetFps : () => 15;
    this._onError = onError || ((err) => console.error('[主循环] 异常：', err));
    this._running = false;
    this._timer = null;
  }

  get running() {
    return this._running;
  }

  start() {
    if (this._running) return;
    this._running = true;
    const tick = () => {
      if (!this._running) return;
      const t0 = performance.now();
      try {
        this._onFrame(t0);
      } catch (err) {
        this._onError(err);
      }
      const interval = 1000 / Math.max(MIN_CAPTURE_FPS, this._targetFps());
      const cost = performance.now() - t0;
      this._timer = setTimeout(tick, Math.max(2, interval - cost));
    };
    this._timer = setTimeout(tick, 0);
  }

  stop() {
    this._running = false;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}
