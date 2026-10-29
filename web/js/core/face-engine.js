/**
 * face-engine.js — 人脸关键点推理引擎（MediaPipe Face Landmarker 封装）
 *
 * 摄像头帧 → WebAssembly/WebGL 推理 → 478 个 3D 关键点 + 52 个表情系数
 * + 4×4 头部变换矩阵。全部推理在浏览器本地完成，视频帧不离开本机。
 *
 * 兼容性：优先 GPU 委托（WebGL），失败自动回退 CPU。
 * 资源加载：vision_bundle.mjs 与 wasm 全同源加载；模型文件走镜像链但
 * 每个候选均经 SHA-256 校验（期望值来自同源 inventory.json）。
 */

import { CONFIG } from '../config.js';

/** vendor 目录的绝对 URL（用 import.meta.url 换算，避免动态 import 与 fetch 基准不一致） */
const VENDOR_BASE = new URL('../../vendor', import.meta.url).href;

/** 同源路径 */
const LOCAL_BUNDLE = `${VENDOR_BASE}/tasks-vision/vision_bundle.mjs`;
const LOCAL_WASM = `${VENDOR_BASE}/tasks-vision/wasm`;
const MODEL_URL = `${VENDOR_BASE}/models/face_landmarker.task`;

/** 模型镜像链（线上加速，每个候选经 SHA-256 校验） */
const GH_REF = 'Jaron-Zheng/fatigue-detection-system@gh-pages';
const MODEL_MIRRORS = [
  `https://gcore.jsdelivr.net/gh/${GH_REF}/vendor/models/face_landmarker.task`,
  `https://fastly.jsdelivr.net/gh/${GH_REF}/vendor/models/face_landmarker.task`,
  `https://cdn.jsdelivr.net/gh/${GH_REF}/vendor/models/face_landmarker.task`,
];
const MIRROR_TIMEOUT_MS = 12000;

/** 判断是否为本地运行环境 */
export function isLocalEnv() {
  const host = location.hostname;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/** 读同源 inventory.json 里模型的期望 SHA-256 */
async function fetchExpectedModelSha() {
  try {
    const r = await fetch(`${VENDOR_BASE}/inventory.json`);
    if (!r.ok) return null;
    const inv = await r.json();
    const m = (inv.files || []).find((f) => f.file === 'models/face_landmarker.task');
    return m && typeof m.sha256 === 'string' ? m.sha256.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** 计算 Uint8Array 的 SHA-256 十六进制（非安全上下文返回 null） */
async function sha256Hex(buf) {
  if (!globalThis.crypto?.subtle) return null;
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 下载模型文件为 Uint8Array。
 * 本地直接同源加载；线上按镜像链依次尝试，每个源下载后做 SHA-256 校验。
 */
async function fetchModelBuffer(onProgress = () => {}) {
  const local = isLocalEnv();
  const expectedSha = await fetchExpectedModelSha();
  if (!expectedSha) console.warn('[FaceEngine] inventory.json 无模型哈希，跳过完整性校验');
  const candidates = local ? [MODEL_URL] : [...MODEL_MIRRORS, MODEL_URL];
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    const isLast = i === candidates.length - 1;
    const ctrl = new AbortController();
    const timer = isLast ? null : setTimeout(() => ctrl.abort(), MIRROR_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = new Uint8Array(await resp.arrayBuffer());
      if (buf.length < 1024) throw new Error('file too small: ' + buf.length);
      const gotSha = await sha256Hex(buf);
      if (expectedSha && gotSha && gotSha !== expectedSha) {
        throw new Error(`integrity mismatch: sha256 ${gotSha.slice(0, 12)}… ≠ 期望 ${expectedSha.slice(0, 12)}…`);
      }
      if (i > 0) {
        onProgress('主源较慢，已切换镜像源 ' + i + '/' + (candidates.length - 1), 58);
      }
      return buf;
    } catch (e) {
      lastErr = e;
      console.warn('[FaceEngine] 模型源失败（' + new URL(url).host + '）：', e.message);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr || new Error('model fetch failed');
}

export class FaceEngine {
  constructor() {
    this.landmarker = null;
    this.ready = false;
    this.delegate = null;
    this.lastVideoTime = -1;
    this.initError = null;
    this._vision = null;
    this.stats = { infer: 0, totalMs: 0, lastMs: 0, dropped: 0, errors: 0 };
    this.consecutiveFailures = 0;
    this._modelBuffer = null;
    this._fallingBack = null;
    // MediaPipe VIDEO 模式要求时间戳严格单调递增
    this.lastTimestamp = -1;
  }

  /** 申请安全时间戳基准，保证不与此前用过的时间戳冲突 */
  reserveTimestampBase(gapMs = 2000) {
    return Math.max(0, this.lastTimestamp + gapMs);
  }

  /** 初始化模型：加载运行时 → 初始化 WASM → 下载模型 → 创建 landmarker */
  async init(onProgress = () => {}) {
    try {
      onProgress('正在载入推理运行时…', 10);
      const mod = await import(LOCAL_BUNDLE);
      const { FaceLandmarker, FilesetResolver } = mod;

      onProgress('正在初始化 WebAssembly…', 30);
      const fileset = await FilesetResolver.forVisionTasks(LOCAL_WASM);
      this._vision = { FaceLandmarker, fileset };

      onProgress('正在加载人脸关键点模型…', 55);
      let modelBuffer = null;
      try {
        modelBuffer = await fetchModelBuffer(onProgress);
      } catch (modelErr) {
        if (/integrity mismatch/.test(String(modelErr && modelErr.message))) {
          throw new Error(
            '模型文件完整性校验失败（web/vendor/models/face_landmarker.task 与 inventory.json 记录的 SHA-256 不一致）。' +
              '文件可能损坏或被篡改，请运行 node tools/fetch-vendor.js 重新下载后重试。',
            { cause: modelErr },
          );
        }
        console.warn('[FaceEngine] 模型镜像链全部失败，改用 modelAssetPath：', modelErr.message);
      }
      this._modelBuffer = modelBuffer;
      const tryCreate = (delegate) => this._create(delegate);

      const preferred = CONFIG.capture.delegate === 'CPU' ? 'CPU' : 'GPU';
      try {
        this.landmarker = await tryCreate(preferred);
        this.delegate = preferred;
      } catch (gpuErr) {
        console.warn('[FaceEngine] GPU 委托不可用，回退 CPU：', gpuErr);
        onProgress('GPU 不可用，回退 CPU 推理…', 70);
        this.landmarker = await tryCreate('CPU');
        this.delegate = 'CPU';
      }
      this.consecutiveFailures = 0;

      onProgress('模型就绪', 100);
      this.ready = true;
      return true;
    } catch (err) {
      this.initError = err;
      this.ready = false;
      console.error('[FaceEngine] 初始化失败：', err);
      throw new Error(this._friendlyError(err), { cause: err });
    }
  }

  /** 用当前 fileset 与模型创建指定委托的 landmarker */
  _create(delegate) {
    const { FaceLandmarker, fileset } = this._vision;
    const opts = this._modelBuffer
      ? { modelAssetBuffer: this._modelBuffer.slice(), delegate }
      : { modelAssetPath: MODEL_URL, delegate };
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: opts,
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  /** 运行期回退 CPU：GPU 创建成功但 detectForVideo 连续抛错时调用 */
  async fallbackToCpu() {
    if (this.delegate === 'CPU' || !this._vision) return false;
    if (this._fallingBack) return this._fallingBack;
    this._fallingBack = (async () => {
      try {
        const next = await this._create('CPU');
        try {
          if (this.landmarker) this.landmarker.close();
        } catch {
          /* noop */
        }
        this.landmarker = next;
        this.delegate = 'CPU';
        this.consecutiveFailures = 0;
        this.lastVideoTime = -1;
        console.warn('[FaceEngine] GPU 推理连续失败，已在运行期切换为 CPU 委托');
        return true;
      } catch (err) {
        console.error('[FaceEngine] 运行期回退 CPU 失败：', err);
        return false;
      } finally {
        this._fallingBack = null;
      }
    })();
    return this._fallingBack;
  }

  _friendlyError(err) {
    const msg = String((err && err.message) || err);
    if (/fetch|network|Failed to load|404/i.test(msg)) {
      return '推理资源加载失败。请确认 web/vendor 下的模型与 wasm 文件完整（可运行 node tools/fetch-vendor.js 重新下载）。';
    }
    if (/WebAssembly|wasm/i.test(msg)) {
      return '当前浏览器的 WebAssembly 支持异常，建议使用最新版 Chrome 或 Edge。';
    }
    return '推理引擎初始化失败：' + msg;
  }

  /**
   * 对一帧视频做推理。用 video.currentTime 去重，时间戳做单调化兜底。
   * skipDedup 用于离线评测（主动 seek 定位时同一 currentTime 必须重新推理）。
   */
  detect(video, tsMs, skipDedup = false) {
    if (!this.ready || !this.landmarker) return null;
    if (video.readyState < 2) return null;
    if (!skipDedup && video.currentTime === this.lastVideoTime) {
      this.stats.dropped++;
      return null;
    }
    this.lastVideoTime = video.currentTime;

    const ts = tsMs > this.lastTimestamp ? Math.round(tsMs) : this.lastTimestamp + 1;
    this.lastTimestamp = ts;

    const t0 = performance.now();
    let result;
    try {
      result = this.landmarker.detectForVideo(video, ts);
    } catch (err) {
      this.consecutiveFailures = (this.consecutiveFailures || 0) + 1;
      this.stats.errors = (this.stats.errors || 0) + 1;
      if (this.consecutiveFailures <= 3 || this.consecutiveFailures % 50 === 0) {
        console.warn('[FaceEngine] detectForVideo 异常，跳过该帧（连续 ' + this.consecutiveFailures + ' 次）：', err);
      }
      return null;
    }
    this.consecutiveFailures = 0;
    const dt = performance.now() - t0;
    this.stats.infer++;
    this.stats.totalMs += dt;
    this.stats.lastMs = dt;
    return result;
  }

  get avgInferMs() {
    return this.stats.infer ? this.stats.totalMs / this.stats.infer : 0;
  }

  resetStats() {
    this.stats = { infer: 0, totalMs: 0, lastMs: 0, dropped: 0, errors: 0 };
    this.consecutiveFailures = 0;
    this.lastVideoTime = -1;
    // lastTimestamp 不重置：跨会话保持单调
  }

  close() {
    try {
      if (this.landmarker) this.landmarker.close();
    } catch {
      /* noop */
    }
    this.landmarker = null;
    this.ready = false;
  }
}

/**
 * CameraSource — 摄像头采集封装
 * http://localhost 属于 Secure Context，无需 HTTPS 即可调用 getUserMedia。
 * 带 15s 超时、自动避开红外/虚拟摄像头、迟到的流回收等保护。
 */
export class CameraSource {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.deviceId = null;
    this.onTrackLost = null;
    this._boundTrackEnded = null;
    // 启动代次：并发 start() 时，迟到的流按代次过期判断后回收
    this._startSeq = 0;
  }

  static get supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /** 红外/深度/虚拟摄像头设备名匹配 */
  static isUndesirableLabel(label) {
    return /\b(IR|infrared|depth)\b|红外|深度|virtual|OBS|Snap Camera|ManyCam|XSplit|DroidCam/i.test(label || '');
  }

  async listCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  _constraints(deviceId, { relaxed = false } = {}) {
    const c = CONFIG.capture;
    if (relaxed) {
      return { audio: false, video: deviceId ? { deviceId: { exact: deviceId } } : true };
    }
    return {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: c.width }, height: { ideal: c.height } }
        : {
            facingMode: c.facingMode,
            width: { ideal: c.width },
            height: { ideal: c.height },
            frameRate: { ideal: 30 },
          },
    };
  }

  /** 带超时的 getUserMedia，超时后迟到的流会被回收 */
  async _getUserMedia(constraints, timeoutMs = 15000) {
    let timerId = null;
    let settled = false;
    const req = navigator.mediaDevices.getUserMedia(constraints);
    const timeout = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error('CAMERA_PERMISSION_TIMEOUT')), timeoutMs);
    });
    try {
      const s = await Promise.race([
        req.then((s) => {
          if (settled) {
            s.getTracks().forEach((t) => t.stop());
            return null;
          }
          return s;
        }),
        timeout,
      ]);
      settled = true;
      return s;
    } catch (err) {
      settled = true;
      req.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
      throw err;
    } finally {
      clearTimeout(timerId);
    }
  }

  /** 首次启动时避开红外/虚拟摄像头 */
  async _avoidUndesirableDevice(stream) {
    const track = stream.getVideoTracks()[0];
    if (!track || !CameraSource.isUndesirableLabel(track.label)) return stream;
    const cams = await this.listCameras();
    const better = cams.find((d) => d.deviceId && !CameraSource.isUndesirableLabel(d.label));
    if (!better) return stream;
    try {
      const alt = await this._getUserMedia(this._constraints(better.deviceId), 8000);
      if (!alt) return stream;
      stream.getTracks().forEach((t) => t.stop());
      console.info('[Camera] 默认设备疑似红外/虚拟摄像头（' + track.label + '），已自动切换到：' + better.label);
      this.deviceId = better.deviceId;
      return alt;
    } catch {
      return stream;
    }
  }

  /** 确保 video 处于播放状态，失败重试三次 */
  async ensurePlaying(retries = 3) {
    const v = this.video;
    if (!v.srcObject) throw new Error('VIDEO_NO_STREAM');
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
      try {
        await v.play();
        if (!v.paused) return true;
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
    const e = new Error('VIDEO_PLAY_BLOCKED');
    e.cause = lastErr;
    throw e;
  }

  /** 等待首帧可用：loadeddata / playing / videoWidth>0 任一满足 */
  _waitFirstFrame(timeoutMs = 12000) {
    const v = this.video;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (ok, err) => {
        if (done) return;
        done = true;
        clearTimeout(to);
        clearInterval(poll);
        v.removeEventListener('loadeddata', onEvt);
        v.removeEventListener('playing', onEvt);
        v.removeEventListener('error', onErr);
        ok ? resolve(undefined) : reject(err);
      };
      const ready = () => v.readyState >= 2 || v.videoWidth > 0;
      const onEvt = () => ready() && finish(true);
      const onErr = () => finish(false, new Error('视频元素报告解码错误，请更换摄像头或浏览器后重试。'));
      const to = setTimeout(
        () => finish(false, new Error('摄像头画面加载超时（12 秒无画面）。请检查设备是否被其他程序占用、隐私挡板是否关闭，或在设置中切换摄像头。')),
        timeoutMs,
      );
      const poll = setInterval(() => ready() && finish(true), 200);
      v.addEventListener('loadeddata', onEvt);
      v.addEventListener('playing', onEvt);
      v.addEventListener('error', onErr);
      if (ready()) finish(true);
    });
  }

  async start(deviceId = null) {
    if (!CameraSource.supported) {
      if (!window.isSecureContext) {
        throw new Error('当前页面不是安全上下文（需 https:// 或 http://localhost），浏览器禁止访问摄像头。请改用 https 地址或本地 127.0.0.1 访问。');
      }
      throw new Error('当前浏览器不支持摄像头采集（navigator.mediaDevices 不可用）。请使用最新版 Chrome / Edge / Safari。');
    }
    this.stop();
    const seq = ++this._startSeq;
    const superseded = (s) => {
      if (seq === this._startSeq) return false;
      if (s) s.getTracks().forEach((t) => t.stop());
      return true;
    };

    let stream = null;
    try {
      stream = await this._getUserMedia(this._constraints(deviceId));
    } catch (err) {
      if (err && err.message === 'CAMERA_PERMISSION_TIMEOUT') {
        throw new Error('等待摄像头授权超时（15 秒无响应）。请在浏览器弹窗中点击「允许」，然后重新开始检测。', {
          cause: err,
        });
      }
      const name = err && err.name;
      if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError' || name === 'NotFoundError') {
        try {
          stream = await this._getUserMedia(this._constraints(deviceId, { relaxed: true }));
        } catch (err2) {
          throw new Error(CameraSource.friendlyError(err2), { cause: err2 });
        }
      } else {
        throw new Error(CameraSource.friendlyError(err), { cause: err });
      }
    }
    if (!stream) throw new Error('摄像头启动被取消。');
    if (superseded(stream)) throw new Error('CAMERA_SUPERSEDED');

    if (!deviceId) stream = await this._avoidUndesirableDevice(stream);
    if (superseded(stream)) throw new Error('CAMERA_SUPERSEDED');
    this.stream = stream;
    if (deviceId) this.deviceId = deviceId;

    const track = stream.getVideoTracks()[0];
    if (track) {
      this._boundTrackEnded = () => {
        if (this.stream !== stream) return;
        if (typeof this.onTrackLost === 'function') this.onTrackLost(new Error('摄像头连接已断开（设备被拔出、被其他程序占用或权限被系统撤销）。'));
      };
      track.addEventListener('ended', this._boundTrackEnded);
    }

    const v = this.video;
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('muted', '');
    v.setAttribute('autoplay', '');
    v.srcObject = stream;

    try {
      await this.ensurePlaying();
      if (seq !== this._startSeq) throw new Error('CAMERA_SUPERSEDED');
      await this._waitFirstFrame();
      if (seq !== this._startSeq) throw new Error('CAMERA_SUPERSEDED');
      return {
        width: v.videoWidth,
        height: v.videoHeight,
        label: track ? track.label : 'camera',
      };
    } catch (err) {
      if (err && err.message === 'CAMERA_SUPERSEDED') throw err;
      if (seq !== this._startSeq) throw new Error('CAMERA_SUPERSEDED', { cause: err });
      this.stop();
      if (err && err.message === 'VIDEO_PLAY_BLOCKED') {
        throw new Error(
          '摄像头已授权，但浏览器拒绝播放画面（常见于 iPhone 低电量模式、浏览器自动播放限制或页面长时间未响应操作）。请点击「重试」，或关闭低电量模式后再试。',
          { cause: err },
        );
      }
      throw err;
    }
  }

  static friendlyError(err) {
    const name = err && err.name;
    switch (name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return '摄像头权限被拒绝。请点击地址栏左侧的图标，把摄像头权限改为「允许」后刷新页面。';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return '未找到摄像头设备。请确认设备已连接且未被系统禁用。';
      case 'NotReadableError':
      case 'TrackStartError':
        return '摄像头被其他程序占用（如会议软件、相机应用），或被系统隐私设置禁用。请关闭占用程序 / 检查「设置 → 隐私 → 相机」后重试。';
      case 'OverconstrainedError':
      case 'ConstraintNotSatisfiedError':
        return '摄像头不支持请求的分辨率，请在设置中降低采集分辨率。';
      case 'SecurityError':
        return '当前页面不是安全上下文，无法访问摄像头。请通过 https 或 http://localhost 访问。';
      case 'AbortError':
        return '摄像头启动被系统中断（设备可能正在被另一个应用初始化），请稍后重试。';
      default:
        return '摄像头启动失败：' + ((err && err.message) || String(err));
    }
  }

  /** 当前轨道是否仍在正常产出画面 */
  get healthy() {
    const t = this.stream && this.stream.getVideoTracks()[0];
    return !!t && t.readyState === 'live' && !t.muted;
  }

  stop() {
    this._startSeq++;
    if (this.stream) {
      const t = this.stream.getVideoTracks()[0];
      if (t && this._boundTrackEnded) t.removeEventListener('ended', this._boundTrackEnded);
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this._boundTrackEnded = null;
    if (this.video) {
      this.video.srcObject = null;
    }
  }

  get aspect() {
    const w = this.video.videoWidth || CONFIG.capture.width;
    const h = this.video.videoHeight || CONFIG.capture.height;
    return w / h;
  }
}
