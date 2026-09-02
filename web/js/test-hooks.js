/**
 * test-hooks.js — 自动化测试钩子（window.__fatigue）
 *
 * 第三轮角色二从 app.js 拆出。自动化验收脚本（tools/ui-smoke.mjs、
 * tools/e2e-fake-camera-test.mjs 等）通过它驱动系统、读取内部状态。
 * 仅本地环境（localhost / 局域网，即测试工具链起服务的地方）安装；
 * GitHub Pages 等线上环境不暴露——__fatigue 可驱动模拟启停，
 * 属于测试面而非产品面（2026-09 安全审计收口）。
 */
import { isLocalEnv } from './core/face-engine.js';

/**
 * @param {object} app 应用组合根
 * @param {object} State 状态枚举（SessionState）
 */
export function installTestHooks(app, State) {
  if (!isLocalEnv()) return; // 线上不安装，本地测试链路不受影响
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
    /** E3 启动自检结果（null = 尚未完成） */
    get preflight() {
      return app.preflight;
    },
    /** 启动模拟检测（自动化测试入口） */
    async startSimulation() {
      app.simulate = true;
      app.sim.reset();
      if (app.settings.swSimulate) app.settings.swSimulate.checked = true;
      app.alarm.setMuted(true); // 测试时静音，避免无人值守下持续鸣响
      await app.start(true);
      return app.state;
    },
    /** 仅初始化推理引擎（验证模型与 wasm 本地化是否正确） */
    async initEngineOnly() {
      try {
        await app._bootEngine();
        return { ok: true, delegate: app.engine.delegate };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    },
    stop: () => app.stop(),
    /** 让模拟剧本快进：直接把模拟起点往前挪，用于快速到达重度阶段 */
    fastForward(ms) {
      if (app.sim.t0 !== null) app.sim.t0 -= ms;
      return app.sim.phaseName;
    },
  };
}
