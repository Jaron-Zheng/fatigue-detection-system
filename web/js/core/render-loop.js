/**
 * render-loop.js — 主循环调度器（不依赖 DOM）
 *
 * 职责只有一个：按目标帧率反复调用传入的帧回调，并记录运行状态。
 * 帧内做什么（推理、指标、渲染）全部由调用方通过 onFrame 回调决定。
 *
 * 采用 setTimeout 定时驱动，而不是 requestAnimationFrame。
 *
 * 原因：rAF 与显示合成器绑定，在窗口被遮挡、系统节能、低刷新率或
 * 无头环境下会被大幅降频（实测可低至 1fps）。而 PERCLOS 这类指标是
 * 「按帧统计闭眼占比」，采样率骤降会直接让指标失真——对安全相关功能
 * 不可接受。setTimeout 不受合成器节流影响，配合耗时补偿可稳定维持
 * 目标帧率。页面真正切到后台时，由调用方监听 visibilitychange 主动
 * 暂停，不会白耗电。
 */

export class RenderLoop {
  /**
   * @param {object} options
   * @param {(now:number)=>void} options.onFrame 每帧回调，参数为 performance.now()
   * @param {()=>number} options.targetFps 目标帧率提供者（允许运行期读取最新配置）
   * @param {(err:Error)=>void} [options.onError] 帧回调异常处理器，默认打印到 console
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
      // 扣除本帧计算耗时，保持平均节拍稳定
      const interval = 1000 / Math.max(8, this._targetFps());
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
