/**
 * test-hooks.js — 自动化测试钩子（window.__fatigue）
 *
 * 自动化验收脚本（tools/ui-smoke.mjs、tools/e2e-fake-camera-test.mjs 等）
 * 通过它驱动系统、读取内部状态。仅本地环境安装，线上不暴露——
 * __fatigue 可驱动模拟启停，属于测试面而非产品面。
 */
import { isLocalEnv } from './core/face-engine.js';

/**
 * @param {object} app 应用组合根
 * @param {object} State 状态枚举（SessionState）
 */
export function installTestHooks(app, State) {
  if (!isLocalEnv()) return;
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
    /* 启动自检结果（null = 尚未完成） */
    get preflight() {
      return app.preflight;
    },
    /* 启动模拟检测（自动化测试入口） */
    async startSimulation() {
      app.simulate = true;
      app.sim.reset();
      if (app.settings.swSimulate) app.settings.swSimulate.checked = true;
      app.alarm.setMuted(true); // 测试时静音，避免无人值守下持续鸣响
      await app.start(true);
      return app.state;
    },
    /* 仅初始化推理引擎（验证模型与 wasm 本地化是否正确） */
    async initEngineOnly() {
      try {
        await app._bootEngine();
        return { ok: true, delegate: app.engine.delegate };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    },
    stop: () => app.stop(),
    /* 让模拟剧本快进：直接把模拟起点往前挪，用于快速到达重度阶段 */
    fastForward(ms) {
      if (app.sim.t0 !== null) app.sim.t0 -= ms;
      return app.sim.phaseName;
    },
  };
}
