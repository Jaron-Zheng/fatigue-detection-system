/**
 * regression-quality-r2.mjs — 质量加固 r2 回归测试（零依赖，Node 18+）
 *
 * 运行：node tools/regression-quality-r2.mjs
 * 覆盖：
 *   Q-01 CameraSource 并发 start()：先发后至的流被回收，只保留最新一轮
 *   Q-02 stop() 期间落定的 getUserMedia 流被立即回收
 *   Q-03 SessionRecorder.end() 幂等
 *   Q-04 标定睁眼基线下限（异常→失败回退；正常/窄眼型不误伤）
 *   Q-05 状态机 onChange 钩子隔离
 *   Q-06 sw.js 静态守护（版本递增 / 无裸 cache.put / 导航回退忽略 query）
 *   Q-07 summary() 大采样数组不因 Math.max 展开栈溢出
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const tick = () => new Promise((r) => setTimeout(r, 0));

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([name, true]);
    console.log('  ✓ ' + name);
  } catch (e) {
    results.push([name, false, e]);
    console.log('  ✗ ' + name + '\n    ' + ((e && e.stack) || e));
  }
}

/* ---------- 浏览器环境最小桩（CameraSource 依赖） ---------- */
function makeTrack(label) {
  return {
    label,
    kind: 'video',
    readyState: 'live',
    muted: false,
    stopped: false,
    stop() {
      this.stopped = true;
      this.readyState = 'ended';
    },
    addEventListener() {},
    removeEventListener() {},
  };
}
function makeStream(label = 'Fake Color Camera') {
  const track = makeTrack(label);
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}
function makeVideo() {
  return {
    srcObject: null,
    paused: true,
    readyState: 4,
    videoWidth: 640,
    videoHeight: 480,
    muted: false,
    defaultMuted: false,
    playsInline: false,
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    async play() {
      this.paused = false;
    },
  };
}
function deferred() {
  let resolve, reject;
  const p = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { p, resolve, reject };
}
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
/** 每次 getUserMedia 依次取队列里的 deferred，测试可精确控制落定顺序 */
function installNavigator(queue) {
  defineGlobal('window', { isSecureContext: true });
  defineGlobal('navigator', {
    mediaDevices: { getUserMedia: () => queue.shift().p, enumerateDevices: async () => [] },
    userAgent: 'node-test',
  });
}

console.log('质量加固 r2 回归测试');

const { CameraSource } = await mod('web/js/core/face-engine.js');
const { SessionRecorder } = await mod('web/js/core/recorder.js');
const { Calibrator, CalibState } = await mod('web/js/core/calibration.js');
const { CONFIG } = await mod('web/js/config.js');
const { SessionStateMachine, SessionEvent, SessionState } = await mod('web/js/core/session-state-machine.js');

await test('Q-01 并发 start()：先发后至的流被回收，只保留最新一轮', async () => {
  const dA = deferred();
  const dB = deferred();
  installNavigator([dA, dB]);
  const video = makeVideo();
  const cam = new CameraSource(video);
  const sA = makeStream();
  const sB = makeStream();
  const pA = cam.start(null); // 第一轮：授权弹窗挂起
  await tick();
  const pB = cam.start(null); // 用户取消后立即重开：第二轮
  await tick();
  dB.resolve(sB); // 第二轮先落定
  const infoB = await pB;
  dA.resolve(sA); // 第一轮迟到
  await assert.rejects(pA, /CAMERA_SUPERSEDED/);
  assert.equal(sA.track.stopped, true, '迟到的流必须 stop()');
  assert.equal(sB.track.stopped, false, '最新一轮的流不能被误停');
  assert.equal(cam.stream, sB);
  assert.equal(video.srcObject, sB);
  assert.equal(infoB.width, 640);
});

await test('Q-02 stop() 期间落定的 getUserMedia 流被立即回收', async () => {
  const d = deferred();
  installNavigator([d]);
  const cam = new CameraSource(makeVideo());
  const s = makeStream();
  const p = cam.start(null);
  await tick();
  cam.stop();
  d.resolve(s);
  await assert.rejects(p, /CAMERA_SUPERSEDED/);
  assert.equal(s.track.stopped, true);
  assert.equal(cam.stream, null);
});

await test('Q-03 recorder.end() 幂等：并发/双击结束只记一条 session_end', () => {
  const r = new SessionRecorder();
  r.begin(null, null);
  r.end();
  const endedAt = r.endedAt;
  r.end();
  assert.equal(r.events.filter((e) => e.type === 'session_end').length, 1);
  assert.equal(r.endedAt, endedAt);
});

function runCalib(ear) {
  const c = new Calibrator();
  let now = 0;
  c.start(now);
  const feat = { ok: true, ear, mar: 0.08, pitch: 0, yaw: 0, roll: 0, scale: 0.3, blinkScore: 0.05 };
  for (let i = 0; i < 600 && c.state === CalibState.COLLECTING; i++) {
    now += 33;
    c.feed(feat, now);
  }
  return c;
}
await test('Q-04a 睁眼基线异常（标定期间闭眼）→ 标定失败并回退通用阈值，而非导出≈0 的闭眼线', () => {
  const c = runCalib(0.06);
  assert.equal(c.state, CalibState.FAILED);
  assert.match(c.result.reason, /基线异常/);
  assert.equal(c.result.earCloseThresh, CONFIG.calibration.fallback.earClose);
});
await test('Q-04b 正常睁眼基线 0.30 仍成功（不误伤）', () => {
  const c = runCalib(0.3);
  assert.equal(c.state, CalibState.DONE);
  assert.ok(c.result.ok);
});
await test('Q-04c 窄眼型基线 0.16 仍成功（下限不得误伤低 EAR 人群）', () => {
  const c = runCalib(0.16);
  assert.equal(c.state, CalibState.DONE);
});

await test('Q-05 onChange 钩子抛错：后续钩子仍执行，错误仍上抛，状态已迁移', () => {
  const sm = new SessionStateMachine();
  const seen = [];
  sm.onChange(() => {
    throw new Error('boom');
  });
  sm.onChange((from, to) => seen.push(to));
  const origErr = console.error;
  console.error = () => {};
  try {
    assert.throws(() => sm.send(SessionEvent.START), /boom/);
  } finally {
    console.error = origErr;
  }
  assert.deepEqual(seen, [SessionState.BOOTING]);
  assert.equal(sm.state, SessionState.BOOTING);
});

await test('Q-06 sw.js：CACHE_VERSION 已递增、cache.put 走容错、导航回退忽略 query', () => {
  const src = readFileSync(path.join(ROOT, 'web/sw.js'), 'utf8');
  const m = src.match(/CACHE_VERSION = '([^']+)'/);
  assert.ok(m, '找不到 CACHE_VERSION');
  assert.notEqual(m[1], 'fatigue-v4-r1', '部署前必须递增 CACHE_VERSION');
  assert.ok(!/\bcache\.put\(req, res\.clone\(\)\);/.test(src), '不允许未捕获的裸 cache.put');
  assert.match(src, /ignoreSearch: true/);
});

await test('Q-08 L-01 决策守护：可执行代码全同源，CSP script-src 无第三方域', () => {
  // 1) 运行时代码里不允许出现推理运行时的第三方 CDN（可执行代码投毒面归零）
  const engine = readFileSync(path.join(ROOT, 'web/js/core/face-engine.js'), 'utf8');
  assert.ok(!/registry\.npmmirror\.com/.test(engine), 'face-engine 不得在运行时 import 第三方 CDN 的 bundle/wasm');
  assert.match(engine, /await import\(LOCAL_BUNDLE\)/, 'vision_bundle 必须同源加载');
  assert.match(engine, /forVisionTasks\(LOCAL_WASM\)/, 'wasm 基路径必须同源');
  // 2) 线上 CSP：script-src 只许 self + wasm-unsafe-eval；jsdelivr 仅出现在 connect-src（模型镜像，全程 SHA-256 校验）
  const html = readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, 'index.html 缺少 CSP meta');
  const scriptSrc = (csp[1].match(/script-src ([^;]+);/) || [])[1] || '';
  assert.ok(
    scriptSrc.split(' ').every((d) => d === "'self'" || d === "'wasm-unsafe-eval'"),
    `script-src 不得含第三方域（实际：${scriptSrc}）`,
  );
  const connectSrc = (csp[1].match(/connect-src ([^;]+);/) || [])[1] || '';
  assert.ok(/cdn\.jsdelivr\.net/.test(connectSrc), '模型镜像域需保留在 connect-src');
  assert.ok(!/npmmirror/.test(csp[1]), 'bundle/wasm 的 CDN 域应从 CSP 整体移除');
});

await test('Q-07 summary() 在 30 万采样点下不因 Math.max 展开栈溢出', () => {
  const r = new SessionRecorder();
  r.begin(null, null);
  const orig = CONFIG.record.maxSamples;
  CONFIG.record.maxSamples = 1e7;
  try {
    for (let i = 0; i < 300000; i++) {
      r.samples.push({ t: i * 500, score: 1, perclos: i === 1234 ? 0.9 : 0.1, dataValid: 1, facePresent: 1, level: 'awake' });
    }
    const s = r.summary({ sessionMs: 300000 * 500 }, null, null);
    assert.equal(s.maxPerclos, 0.9);
  } finally {
    CONFIG.record.maxSamples = orig;
  }
});

const failed = results.filter((r) => !r[1]).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
