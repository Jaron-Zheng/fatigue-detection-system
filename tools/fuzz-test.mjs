#!/usr/bin/env node
/**
 * fuzz-test.mjs — 算法鲁棒性模糊测试（第三轮角色七）
 *
 * 回归测试的剧本是人设计的，覆盖不到人没想到的输入组合。
 * 本脚本用程序生成大量随机/极端输入去撞现有测试没覆盖的边界：
 *   · 闭眼/睁眼切换的随机时长（大量样本压在 50-150ms 边界附近，
 *     因为正常眨眼窗口是 60-500ms，边界最容易出 bug）
 *   · 随机化的头部姿态角速度（含远超点头阈值的尖峰）
 *   · 间歇性人脸丢失（ok:false 帧 + 长时间丢失段）
 *   · 帧率抖动（16-120ms 随机间隔 + 偶发 0.5-2s 卡顿 + 重复时间戳）
 *   · 极端特征值（EAR 打到 0 / MAR 打到 1 / 姿态角 ±90°）
 *   · 状态机的随机操作序列（合法/非法事件乱序注入）
 *
 * 每轮断言（任何一条违反即记录失败并可凭种子复现）：
 *   · fusion.score 不出现 NaN/Infinity 且始终在 0-100
 *   · fusion.level 始终是四个合法等级之一
 *   · 指标层数值字段有限（允许窗口未就绪时为 null）
 *   · recorder.samples / events、indicators.events 不超过容量上限
 *   · 状态机不死锁：随机操作序列下状态始终合法、send 行为与 can 一致
 *
 * 用法：
 *   node tools/fuzz-test.mjs [--rounds 1000] [--seconds 60] [--seed 1]
 *   node tools/fuzz-test.mjs --repro <轮种子>   # 复现某一轮失败
 *
 * 每一轮的种子 = 主种子 × 100000 + 轮序号，失败时直接打印该轮种子。
 */
'use strict';

import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_JS = path.resolve(__dirname, '../web/js');

// ── 浏览器 API 最小 mock（与 regression-test.mjs 一致） ──
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Date.now() };
}
if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { userAgent: 'NodeFuzzTest/1.0' };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

const importFromWeb = (rel) => import(pathToFileURL(path.join(WEB_JS, rel)).href);

const { CONFIG } = await importFromWeb('config.js');
const { SimulatedDriver } = await importFromWeb('core/sim-driver.js');
const { IndicatorEngine } = await importFromWeb('core/indicators.js');
const { FusionEngine } = await importFromWeb('core/fusion.js');
const { SessionRecorder } = await importFromWeb('core/recorder.js');
const { SessionStateMachine, SessionState, SessionEvent } = await importFromWeb(
  'core/session-state-machine.js'
);

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ROUNDS = Number(get('--rounds', 1000));
const SECONDS = Number(get('--seconds', 60));
const MASTER_SEED = Number(get('--seed', 1));
const REPRO = get('--repro', null);

/** 确定性伪随机数发生器：同一种子必得同一序列（与 sim-driver 同款 mulberry32） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEVELS = new Set(['awake', 'mild', 'moderate', 'severe']);
const STATES = new Set(Object.values(SessionState));
const EVENTS = Object.values(SessionEvent);
const EAR_OPEN = 0.3;

/**
 * 随机化驾驶员：接口与 SimulatedDriver.frame 对齐（输出同一形状的特征对象），
 * 但所有行为参数都从 rng 里摇出来，不重放任何固定剧本。
 */
class FuzzDriver {
  constructor(rng) {
    this.rng = rng;
    this.t0 = null;
    this.nextClosureAt = 0;
    this.closureUntil = 0;
    this.closureDur = 0;
    this.nextYawnAt = 3000;
    this.yawnUntil = 0;
    this.yawnStart = 0;
    this.yawnDur = 0;
    this.nextNodAt = 5000;
    this.nodUntil = 0;
    this.nodStart = 0;
    this.nodAmp = 20;
    this.faceLostUntil = 0;
    this.sway = 1 + rng() * 18; // 头部摆动幅度 1-19°
    this.droop = rng() < 0.35 ? 5 + rng() * 15 : 0; // 部分"驾驶员"持续低头
    this.noise = 0.002 + rng() * 0.02; // 关键点噪声幅度
  }

  /** 摇一次闭眼时长：40% 压在 50-150ms 边界带，其余覆盖全量程 */
  _rollClosureMs() {
    const r = this.rng();
    if (r < 0.4) return 50 + this.rng() * 100; // 边界带：50-150ms
    if (r < 0.7) return 150 + this.rng() * 350; // 正常眨眼：150-500ms
    if (r < 0.9) return 500 + this.rng() * 1000; // 长闭眼：0.5-1.5s
    return 1500 + this.rng() * 2500; // 微睡眠级：1.5-4s
  }

  frame(ts) {
    if (this.t0 === null) {
      this.t0 = ts;
      this.nextClosureAt = ts + 500;
    }
    const rng = this.rng;
    const elapsed = ts - this.t0;

    /* ---- 间歇性人脸丢失 ---- */
    if (ts < this.faceLostUntil) return { ok: false, ts };
    if (rng() < 0.0008) this.faceLostUntil = ts + 500 + rng() * 7500; // 0.5-8s 丢失段

    /* ---- 闭眼调度 ---- */
    if (ts >= this.nextClosureAt) {
      this.closureDur = this._rollClosureMs();
      this.closureUntil = ts + this.closureDur;
      this.nextClosureAt = ts + this.closureDur + 300 + rng() * 5200;
    }
    const closing = ts < this.closureUntil;

    /* ---- 哈欠 / 点头调度 ---- */
    if (ts >= this.nextYawnAt) {
      this.yawnStart = ts;
      this.yawnDur = 1200 + rng() * 2800;
      this.yawnUntil = ts + this.yawnDur;
      this.nextYawnAt = ts + this.yawnDur + 4000 + rng() * 40000;
    }
    if (ts >= this.nextNodAt) {
      this.nodStart = ts;
      this.nodUntil = ts + 400 + rng() * 600;
      this.nodAmp = 10 + rng() * 40; // 10-50°，远超点头阈值制造尖峰
      this.nextNodAt = ts + 2000 + rng() * 30000;
    }

    /* ---- EAR：方波+余弦边沿+噪声+偶发极值 ---- */
    let ear = EAR_OPEN;
    if (closing && this.closureDur > 0) {
      const prog = 1 - (this.closureUntil - ts) / this.closureDur;
      const edge = Math.min(0.28, 120 / Math.max(1, this.closureDur));
      let k = prog < edge ? prog / edge : prog > 1 - edge ? (1 - prog) / edge : 1;
      k = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, k)));
      ear = EAR_OPEN + (0.055 - EAR_OPEN) * k;
    }
    ear += (rng() - 0.5) * this.noise;
    if (rng() < 0.004) ear = rng() < 0.5 ? 0 : 0.45 + rng() * 0.1; // 极值离群点
    ear = Math.max(-0.05, ear); // 允许轻微负值：关键点噪声真实存在

    /* ---- MAR ---- */
    let mar = 0.06 + Math.sin(elapsed / 800) * 0.015;
    if (ts < this.yawnUntil && this.yawnDur > 0) {
      const prog = Math.min(1, Math.max(0, (ts - this.yawnStart) / this.yawnDur));
      mar = 0.06 + (0.85 - 0.06) * Math.sin(Math.PI * prog) ** 0.55;
    }
    mar += (rng() - 0.5) * this.noise * 0.6;
    if (rng() < 0.003) mar = 0.9 + rng() * 0.3; // 极端张口

    /* ---- 头部姿态：随机摆动 + 点头尖峰 + 偶发极端角 ---- */
    let pitch = Math.sin(elapsed / (1800 + rng() * 400)) * this.sway * 0.5 + this.droop;
    const yaw = Math.sin(elapsed / 3100 + 0.7) * this.sway;
    const roll = Math.sin(elapsed / 3900) * this.sway * 0.4;
    if (ts < this.nodUntil) {
      const prog = (ts - this.nodStart) / Math.max(1, this.nodUntil - this.nodStart);
      pitch += Math.sin(Math.PI * Math.min(1, prog)) * this.nodAmp;
    }
    if (rng() < 0.002) pitch = (rng() < 0.5 ? -1 : 1) * (60 + rng() * 30); // 姿态突变

    const prevPitch = this._prevPitch;
    const prevTs = this._prevTs;
    let pitchVel = 0;
    if (prevPitch !== undefined && prevTs !== undefined && ts > prevTs) {
      pitchVel = ((pitch - prevPitch) * 1000) / (ts - prevTs);
    }
    this._prevPitch = pitch;
    this._prevTs = ts;

    const blinkScore = Math.min(1, Math.max(0, (EAR_OPEN - ear) / (EAR_OPEN - 0.055))) * 0.95 + 0.03;
    const jawOpen = Math.min(1, Math.max(0, (mar - 0.06) / (0.85 - 0.06))) * 0.95;

    return {
      ok: true,
      ts,
      simulated: true,
      landmarks: null,
      ear,
      earL: ear,
      earR: ear,
      earRaw: { l: ear, r: ear },
      mar,
      pitch,
      yaw,
      roll,
      pitchVel,
      poseSource: 'simulated',
      scale: 0.22,
      gaze: { h: (rng() - 0.5) * 40, v: (rng() - 0.5) * 30 }, // 随机视线偏离
      blend: { eyeBlinkLeft: blinkScore, eyeBlinkRight: blinkScore, jawOpen },
      blinkScore,
      squintScore: 0,
      browDown: 0,
      jawOpen,
    };
  }
}

/** 帧间隔发生器：抖动 + 偶发大卡顿 + 偶发重复时间戳 */
function makeDtRoller(rng) {
  return () => {
    const r = rng();
    if (r < 0.02) return 500 + rng() * 1500; // 2%：大卡顿
    if (r < 0.025) return 0; // 0.5%：重复时间戳（dt=0）
    return 16 + rng() * 104; // 正常帧率抖动 16-120ms
  };
}

const finiteOrNull = (v) => v === null || v === undefined || Number.isFinite(v);

/** 跑一轮随机剧本，返回失败原因数组（空 = 通过） */
function runRound(roundSeed) {
  const rng = mulberry32(roundSeed);
  const failures = [];
  const calib = SimulatedDriver.calibration();
  const indicators = new IndicatorEngine();
  const fusion = new FusionEngine();
  const recorder = new SessionRecorder();
  recorder.begin(calib, { simulated: true });
  const driver = new FuzzDriver(rng);
  const rollDt = makeDtRoller(rng);

  let t = 1000;
  const end = t + SECONDS * 1000;
  let frames = 0;

  try {
    while (t < end) {
      const feat = driver.frame(t);
      const ind = indicators.update(feat, calib);
      const fus = fusion.evaluate(ind, calib);
      recorder.sample(ind, fus, feat);
      frames++;

      if (!Number.isFinite(fus.score) || fus.score < 0 || fus.score > 100) {
        failures.push(`t=${t} fusion.score 越界: ${fus.score}`);
        break;
      }
      if (!LEVELS.has(fus.level)) {
        failures.push(`t=${t} 非法等级: ${fus.level}`);
        break;
      }
      for (const k of ['perclos', 'blinkRate', 'avgBlinkMs', 'yawnRate', 'nodRate', 'headDevRatio', 'maxClosureMs', 'currentClosureMs', 'faceLostRatio']) {
        const v = ind[k];
        // 既有语义：尚无眨眼事件时 avgBlinkMs=NaN 表示"无数据"，
        // 下游 fusion/UI/recorder 均用 Number.isFinite 守卫（recorder 落盘为 null），此处尊重该约定
        if (k === 'avgBlinkMs' && Number.isNaN(v)) continue;
        if (!finiteOrNull(v) || (Number.isFinite(v) && (k === 'perclos' || k === 'headDevRatio' || k === 'faceLostRatio') && (v < 0 || v > 1))) {
          failures.push(`t=${t} 指标 ${k} 非法: ${v}`);
          break;
        }
      }
      if (failures.length) break;
      if (indicators.events.length > CONFIG.record.maxEvents) {
        failures.push(`t=${t} indicators.events 超容量: ${indicators.events.length}`);
        break;
      }

      // 新产生的事件搬进 recorder（与 app.js 的 drainNewEvents 接线等价）
      const evts = indicators.drainNewEvents();
      if (evts.length) recorder.addEvents(evts);

      t += rollDt();
    }

    if (!failures.length) {
      if (recorder.samples.length > CONFIG.record.maxSamples + 64) {
        failures.push(`samples 超容量: ${recorder.samples.length}`);
      }
      if (recorder.events.length > CONFIG.record.maxEvents) {
        failures.push(`recorder.events 超容量: ${recorder.events.length}`);
      }
      // 收尾：报告链路也不能炸
      const lastInd = indicators.update({ ok: false, ts: end }, calib);
      const lastFus = fusion.evaluate(lastInd, calib);
      recorder.end();
      const sum = recorder.summary(lastInd, lastFus, null);
      if (!sum || !Number.isFinite(sum.durationMs) || sum.durationMs < 0) {
        failures.push(`summary 异常: durationMs=${sum && sum.durationMs}`);
      }
    }
  } catch (err) {
    failures.push(`t=${t} 抛出异常: ${err.message}`);
  }
  return { failures, frames };
}

/** 状态机模糊：随机事件序列注入，断言状态始终合法且 send 与 can 行为一致 */
function runStateMachineFuzz(seed, ops = 300) {
  const rng = mulberry32(seed);
  const sm = new SessionStateMachine();
  const payloadPool = [undefined, {}, { simulated: true }, { calibration: SimulatedDriver.calibration() }];
  for (let i = 0; i < ops; i++) {
    const ev = EVENTS[Math.floor(rng() * EVENTS.length)];
    const payload = payloadPool[Math.floor(rng() * payloadPool.length)];
    const allowed = sm.can(ev, payload);
    const before = sm.state;
    let ok;
    try {
      ok = sm.send(ev, payload);
    } catch (err) {
      return `第${i}步 send(${ev}) 抛异常: ${err.message}`;
    }
    if (ok !== allowed) return `第${i}步 can/send 不一致: can=${allowed} send=${ok} (state=${before}, event=${ev})`;
    if (!STATES.has(sm.state)) return `第${i}步后进入非法状态: ${sm.state}`;
    if (!ok && sm.state !== before) return `第${i}步被拒绝但状态变了: ${before} → ${sm.state}`;
  }
  // 任何序列结束后，系统都必须存在合法出路（不死锁）：
  // 要么已经在起点 IDLE，要么能通过合法事件序列回到 IDLE。
  // 注意不能用固定的 START→CANCEL 探路：RUNNING 状态下 START 是非法的，
  // 合法出路是 FINISH→REPORT→START→CANCEL（或 SIM_EXIT 直达 IDLE）。
  const escapeRoutes = [
    [],
    [SessionEvent.SIM_EXIT],
    [SessionEvent.FINISH, SessionEvent.START, SessionEvent.CANCEL],
    [SessionEvent.RESUME, SessionEvent.FINISH, SessionEvent.START, SessionEvent.CANCEL],
    [SessionEvent.CANCEL],
    [SessionEvent.START, SessionEvent.CANCEL],
  ];
  const reachableIdle = escapeRoutes.some((route) => {
    const probe = new SessionStateMachine({ initial: sm.state });
    for (const ev of route) probe.send(ev, { simulated: true });
    return probe.state === SessionState.IDLE;
  });
  if (!reachableIdle) {
    return `随机序列后状态机无合法出路（死锁）: state=${sm.state}`;
  }
  return null;
}

/* ==================== 主流程 ==================== */
console.log('\n=== 驾驶员疲劳检测系统 · 模糊测试 ===');

if (REPRO !== null) {
  const s = Number(REPRO);
  console.log(`复现模式：种子 ${s}，${SECONDS}s 剧本`);
  const r = runRound(s);
  if (r.failures.length) {
    console.error(`  ✗ 复现成功，失败原因：\n    ${r.failures.join('\n    ')}`);
    process.exit(1);
  }
  console.log(`  ✓ 该种子跑 ${r.frames} 帧未复现失败`);
  process.exit(0);
}

const startedAt = Date.now();
let totalFrames = 0;
const badRounds = [];

for (let i = 0; i < ROUNDS; i++) {
  const roundSeed = MASTER_SEED * 100000 + i;
  const r = runRound(roundSeed);
  totalFrames += r.frames;
  if (r.failures.length) badRounds.push({ seed: roundSeed, failures: r.failures });
  if ((i + 1) % 100 === 0) {
    const eta = ((Date.now() - startedAt) / (i + 1)) * (ROUNDS - i - 1) / 1000;
    console.log(`  进度 ${i + 1}/${ROUNDS}，累计 ${totalFrames} 帧，失败 ${badRounds.length} 轮，预计剩余 ${eta.toFixed(0)}s`);
  }
}

console.log('\n[状态机随机操作序列模糊]');
let smFailures = 0;
for (let i = 0; i < 200; i++) {
  const err = runStateMachineFuzz(MASTER_SEED * 7919 + i);
  if (err) {
    smFailures++;
    console.error(`  ✗ 序列种子 ${MASTER_SEED * 7919 + i}: ${err}`);
    if (smFailures >= 5) break;
  }
}
if (smFailures === 0) console.log('  ✓ 200 组随机操作序列：状态始终合法，can/send 一致，无死锁');

const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n=== 结果: ${ROUNDS} 轮剧本 + 200 组状态机序列，${totalFrames} 帧，耗时 ${elapsedSec}s ===`);
if (badRounds.length || smFailures) {
  console.error(`✗ 发现问题 ${badRounds.length + smFailures} 处，可用 --repro <种子> 复现：`);
  for (const b of badRounds.slice(0, 10)) {
    console.error(`  种子 ${b.seed}: ${b.failures.join(' | ')}`);
  }
  console.log('\n发现的问题必须按"现象→复现条件（种子）→根因→修复→验证"写入 docs/模糊测试问题汇总.md');
  process.exit(1);
} else {
  console.log(`✓ ${ROUNDS} 轮随机剧本（每轮 ${SECONDS}s、覆盖 50-150ms 边界闭眼/人脸丢失/帧率抖动/极端特征值）未发现新缺陷`);
  console.log(`  主种子 ${MASTER_SEED}；更换种子重跑：node tools/fuzz-test.mjs --seed <n>`);
}
