/**
 * face-engine.js — 人脸关键点推理引擎（MediaPipe Face Landmarker 封装）
 *
 * 全部推理在浏览器本地完成：
 *   摄像头帧 → WebAssembly/WebGL 推理 → 478 个 3D 关键点 + 52 个表情系数
 *              + 4×4 头部变换矩阵
 * 视频帧从不离开本机，不存在隐私上传问题——这是选择端侧方案的首要理由。
 *
 * 兼容性策略：
 *   · 优先 GPU 委托（WebGL 后端），失败自动回退 CPU（XPNPACK）；
 *   · wasm 目录同时包含 SIMD 与非 SIMD 版本，运行时由 MediaPipe 自动择优；
 *
 * 资源加载策略（CDN 优先 + 同源回退）：
 *   线上环境优先用 npmmirror CDN 加载 WASM/运行时（CORS 已支持），
 *   CDN 不可用时回退到 GitHub Pages 同源加载。
 *   模型文件（约 3.7MB）走 jsdelivr gh 镜像链（gcore→fastly→cdn，
 *   实测 550–690KB/s），全部失败后回退同源（国内实测仅约 20KB/s，
 *   是"加载不出来"的主因），本地运行始终同源加载。
 */

import { CONFIG } from '../config.js';

/**
 * 资源根路径——基于当前模块位置解析出 vendor 目录的绝对 URL。
 *
 * 注意这里必须解析成绝对 URL，不能直接写 './vendor'：
 *   · 动态 import() 的相对路径基准是「当前模块文件」→ 会解析成 /js/core/vendor/...
 *   · 而 MediaPipe 内部 fetch wasm/模型时的基准是「文档 URL」→ /vendor/...
 * 两个基准不一致，用相对路径必然有一方出错。
 * 用 import.meta.url 换算出绝对 URL 后，两者都能正确命中。
 */
const VENDOR_BASE = new URL('../../vendor', import.meta.url).href;

/**
 * 国内 CDN — npmmirror（淘宝 NPM 镜像），CORS 完整支持。
 */
const MP_VERSION = '1.0.0';
const CDN_BASE = `https://registry.npmmirror.com/@mediapipe/tasks-vision/${MP_VERSION}/files`;
const CDN_BUNDLE = `${CDN_BASE}/vision_bundle.mjs`;
const CDN_WASM = `${CDN_BASE}/wasm`;

/**
 * 同源路径（GitHub Pages 仓库 vendor 目录）
 */
const LOCAL_BUNDLE = `${VENDOR_BASE}/tasks-vision/vision_bundle.mjs`;
const LOCAL_WASM = `${VENDOR_BASE}/tasks-vision/wasm`;
const MODEL_URL = `${VENDOR_BASE}/models/face_landmarker.task`;

/**
 * 模型镜像链 —— GitHub Pages 直连在国内实测约 20KB/s（3.7MB 需 3 分钟），
 * 是线上"推理引擎加载不出来"的主因。jsdelivr gh 镜像实测 550–690KB/s，
 * 依次尝试 gcore / fastly / cdn 三个域名，最后回退同源。
 */
const GH_REF = 'Jaron-Zheng/fatigue-detection-system@gh-pages';
const MODEL_MIRRORS = [
  `https://gcore.jsdelivr.net/gh/${GH_REF}/vendor/models/face_landmarker.task`,
  `https://fastly.jsdelivr.net/gh/${GH_REF}/vendor/models/face_landmarker.task`,
  `https://cdn.jsdelivr.net/gh/${GH_REF}/vendor/models/face_landmarker.task`,
];
const MIRROR_TIMEOUT_MS = 12000;

/**
 * 判断是否为本地运行环境。
 * （test-hooks.js 复用本函数做线上/本地分流，改动语义需两处同步。）
 */
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

/**
 * 尝试从指定 URL 加载 ES 模块，超时则回退。
 */
async function importWithTimeout(url, timeoutMs = 8000) {
  const race = Promise.race([
    import(url),
    new Promise((_, reject) => setTimeout(() => reject(new Error('CDN_TIMEOUT')), timeoutMs)),
  ]);
  return race;
}

/**
 * 模型完整性校验（防 CDN 投毒/损坏，2026-09 安全审计新增）。
 *
 * 期望哈希来自同源 vendor/inventory.json（fetch-vendor.js 生成，
 * 随仓库一起版本化）——模型可以走 jsdelivr 镜像链，但期望值永远
 * 从本仓库同源读取，攻击者即使控制镜像也无法让哈希对上。
 * 校验失败的源按「源失败」处理：切换下一候选，最终回退同源。
 *
 * 已知边界（如实记录）：vision_bundle.mjs 与 wasm 走 MediaPipe
 * 内部加载，无法在此处拦截校验，其防护依赖版本锁定路径 +
 * index.html CSP 的 CDN 域白名单 + 同源兜底。
 */

/** 读同源 inventory.json 里模型的期望 SHA-256（小写十六进制）。失败返回 null（降级为不校验）。 */
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

/** 计算 Uint8Array 的 SHA-256 十六进制。非安全上下文（如局域网 http）无 crypto.subtle，返回 null 表示跳过校验。 */
async function sha256Hex(buf) {
  if (!globalThis.crypto?.subtle) return null;
  const d = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 下载模型文件为 Uint8Array（供 modelAssetBuffer 使用）。
 * 线上按镜像链依次尝试（前三个 jsdelivr 域名各设超时，同源兜底不限时）；
 * 本地直接同源加载。每个源下载完成后做 SHA-256 校验，失败视同源故障
 * 切换下一候选。全部失败时抛错，由调用方回退 modelAssetPath。
 * @param {(msg: string, pct: number) => void} [onProgress] 加载进度回调
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
    /** 连续 detectForVideo 抛错次数（成功一次即清零） */
    this.consecutiveFailures = 0;
    this._modelBuffer = null;
    this._fallingBack = null;
    /**
     * MediaPipe VIDEO 模式要求送入的时间戳严格单调递增，否则整张计算图报
     * "Packet timestamp mismatch" 并且该帧推理直接失败。
     * 实时检测用 performance.now()（很大的数），而离线视频评测从 0 开始，
     * 两者共用同一个引擎实例时必然冲突。这里跟踪已使用的最大时间戳，
     * 在 detect() 内做单调化兜底。
     */
    this.lastTimestamp = -1;
  }

  /**
   * 申请一段安全的时间戳基准，保证不与此前用过的时间戳冲突。
   * 离线评测在开始前调用一次，把"视频内时间"整体平移到该基准之上。
   */
  reserveTimestampBase(gapMs = 2000) {
    return Math.max(0, this.lastTimestamp + gapMs);
  }

  /**
   * 初始化模型。
   * @param {(msg:string, pct:number)=>void} onProgress 加载进度回调
   */
  async init(onProgress = () => {}) {
    try {
      const local = isLocalEnv();

      // --- 第一步：加载 vision_bundle.mjs ---
      onProgress('正在载入推理运行时…', 10);
      let bundleUrl, wasmBase, mod;
      if (local) {
        // 本地：直接用本地文件
        bundleUrl = LOCAL_BUNDLE;
        wasmBase = LOCAL_WASM;
        mod = await import(bundleUrl);
      } else {
        // 线上：CDN 优先，超时回退同源
        bundleUrl = CDN_BUNDLE;
        wasmBase = CDN_WASM;
        try {
          mod = await importWithTimeout(CDN_BUNDLE, 8000);
          onProgress('CDN 加载成功，正在初始化…', 20);
        } catch (cdnErr) {
          console.warn('[FaceEngine] CDN 加载失败，回退同源：', cdnErr.message);
          onProgress('CDN 较慢，切换备用源…', 15);
          bundleUrl = LOCAL_BUNDLE;
          wasmBase = LOCAL_WASM;
          mod = await import(LOCAL_BUNDLE);
        }
      }
      const { FaceLandmarker, FilesetResolver } = mod;

      // --- 第二步：初始化 WASM ---
      onProgress('正在初始化 WebAssembly…', 30);
      const fileset = await FilesetResolver.forVisionTasks(wasmBase);
      this._vision = { FaceLandmarker, fileset };

      // --- 第三步：加载模型（镜像链下载 → modelAssetBuffer）---
      onProgress('正在加载人脸关键点模型…', 55);
      let modelBuffer = null;
      try {
        modelBuffer = await fetchModelBuffer(onProgress);
      } catch (modelErr) {
        console.warn('[FaceEngine] 模型镜像链全部失败，改用 modelAssetPath：', modelErr.message);
      }
      // 先尝试 GPU，失败则回退 CPU（buffer 会被引擎消耗，重试需传副本）
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

  /** 用当前 fileset 与模型创建一个指定委托的 landmarker（init 与运行期回退共用） */
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

  /**
   * 运行期回退 CPU：部分显卡/驱动上 GPU 委托能创建成功，但 detectForVideo
   * 每帧都抛错（WebGL 上下文丢失、着色器编译失败等）。原实现只是
   * "跳过该帧"，结果是校准永远不推进、画面无任何反馈。
   * 连续失败达到阈值时由上层调用本方法切到 CPU，切换失败返回 false。
   */
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
   * 对一帧视频做推理。
   * MediaPipe 的 VIDEO 模式要求时间戳单调递增，且同一帧不可重复送入，
   * 否则会抛错。因此用 video.currentTime 去重。
   *
   * @param {HTMLVideoElement} video
   * @param {number} tsMs 时间戳（内部会做单调化）
   * @param {boolean} skipDedup 跳过同帧去重。
   *        实时流中同一帧可能被轮询多次，去重可省下无谓推理；
   *        但离线评测是主动 seek 定位，即使目标时刻与此前某次相同
   *        （例如标定段与评测段都经过 0s），也必须重新推理，
   *        否则该采样点会被当成"人脸丢失"而污染统计。
   * @returns {object|null} 推理结果；被去重或未就绪时返回 null
   */
  detect(video, tsMs, skipDedup = false) {
    if (!this.ready || !this.landmarker) return null;
    if (video.readyState < 2) return null;
    if (!skipDedup && video.currentTime === this.lastVideoTime) {
      this.stats.dropped++;
      return null;
    }
    this.lastVideoTime = video.currentTime;

    /**
     * 时间戳单调化兜底。
     *
     * 这个时间戳只用于 MediaPipe 内部的帧排序与跟踪平滑，不参与关键点坐标计算；
     * 上层算法用的是自己传入的逻辑时间戳（feat.ts），两者互不影响。
     * 因此在发生冲突时把它抬到 lastTimestamp+1 是安全的——
     * 代价仅是极少数帧的内部时序被压缩，远好于整帧推理失败。
     */
    const ts = tsMs > this.lastTimestamp ? Math.round(tsMs) : this.lastTimestamp + 1;
    this.lastTimestamp = ts;

    const t0 = performance.now();
    let result;
    try {
      result = this.landmarker.detectForVideo(video, ts);
    } catch (err) {
      // 时间戳回退等偶发错误：跳过该帧而不是崩掉整个循环；
      // 连续失败计数供上层判断是否需要回退 CPU（见 fallbackToCpu）
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
    // 注意：不重置 lastTimestamp。它必须跨会话保持单调，
    // 否则下一次会话又会与已用过的时间戳冲突。
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
 *
 * 说明：http://localhost 属于 Secure Context，因此无需 HTTPS 即可调用
 * getUserMedia。若通过 IP 访问（如 192.168.x.x）浏览器会拒绝，
 * 这也是本项目服务器只监听 127.0.0.1 的原因之一。
 *
 * 2026-09 黑屏根修（"权限已授予但画面全黑/校准倒计时不动"）——真机复现的四类根因：
 *   1. video.play() 被拒绝（iOS 低电量模式、自动播放策略、用户手势在模型加载
 *      期间过期）却被 .catch(()=>{}) 吞掉：视频停在 currentTime=0，
 *      FaceEngine.detect 的同帧去重把每一帧都丢弃，校准永远不推进，
 *      而校准遮罩是 90% 不透明的近黑色——用户看到的就是"黑屏"。
 *      → play() 失败改为多次重试 + 明确抛错，由 app 层提供"点击重试"出口
 *        （点击本身就是新的用户手势，重试必然成功）。
 *   2. 等待 loadeddata 后才 play()：部分 Safari/WebView 对 MediaStream
 *      不先 play 就不推进 readyState，12 秒后报"画面加载超时"。
 *      → 先 play() 再等首帧（loadeddata / playing / videoWidth>0 三选一）。
 *   3. Windows Hello 红外摄像头 / 虚拟摄像头被当成默认设备：画面全黑或灰。
 *      → 首次启动无指定设备时，在授权后枚举设备，自动避开 IR/虚拟摄像头。
 *   4. 授权超时后用户再点"允许"，迟到的流没人回收：指示灯常亮，下次启动
 *      NotReadableError（设备被占用）。→ 迟到的流立即 stop。
 */
export class CameraSource {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.deviceId = null;
    /** 采集轨道意外结束（拔线/系统撤销权限/被其他应用抢占）时回调 */
    this.onTrackLost = null;
    this._boundTrackEnded = null;
  }

  static get supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /** 常见"不是给人看画面"的设备名（红外/深度/虚拟摄像头） */
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
      // 兜底：只保留设备选择（若有），放弃分辨率/帧率约束
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

  /**
   * 带超时的 getUserMedia。
   * 用户忽略权限对话框时 Promise 会一直 pending，界面停留在 BOOTING 无任何反馈；
   * 15 秒未决即放弃并给出可操作提示。超时后若用户才点"允许"，迟到的流会被立即回收。
   */
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
            // 已超时放弃：回收迟到的流，避免摄像头被"幽灵流"占用
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
      // 超时路径：原始请求之后若成功也要回收
      req.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
      throw err;
    } finally {
      clearTimeout(timerId);
    }
  }

  /**
   * 首次启动（未指定设备）时避开红外/虚拟摄像头：
   * 已经拿到一次授权后 enumerateDevices 才会返回设备名，据此判断当前轨道
   * 是否是 IR 相机；若是且存在其他可用相机，则切换过去。
   * 返回最终使用的流（可能与传入相同）。
   */
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

  /**
   * 确保 <video> 处于播放状态。失败重试三次（每次间隔递增），
   * 仍失败则抛出 VIDEO_PLAY_BLOCKED，由上层给出"点击重试"出口。
   */
  async ensurePlaying(retries = 3) {
    const v = this.video;
    if (!v.srcObject) throw new Error('VIDEO_NO_STREAM');
    let lastErr = null;
    for (let i = 0; i <= retries; i++) {
      try {
        // play() 在已播放时返回已 resolve 的 Promise，重复调用安全
        await v.play();
        if (!v.paused) return true;
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
    const e = new Error('VIDEO_PLAY_BLOCKED');
    /** @type {any} */ (e).cause = lastErr;
    throw e;
  }

  /** 等待首帧可用：loadeddata / playing / videoWidth>0 任一满足即可 */
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
    // 重复调用先回收旧流（切换设备/重试路径），避免同一设备被两条流占用
    this.stop();

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
      // 分辨率/设备约束不满足：退化为最宽松约束再试一次（老旧/USB 摄像头常见）
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

    if (!deviceId) stream = await this._avoidUndesirableDevice(stream);
    this.stream = stream;
    if (deviceId) this.deviceId = deviceId;

    // 轨道意外结束（拔线、系统撤销权限、被其他应用抢占）：通知上层而不是静默黑屏
    const track = stream.getVideoTracks()[0];
    if (track) {
      this._boundTrackEnded = () => {
        if (this.stream !== stream) return;
        if (typeof this.onTrackLost === 'function') this.onTrackLost(new Error('摄像头连接已断开（设备被拔出、被其他程序占用或权限被系统撤销）。'));
      };
      track.addEventListener('ended', this._boundTrackEnded);
    }

    // 属性必须先于 srcObject 设置：部分 WebKit 在赋流瞬间就依据 muted/playsInline 决定能否自动播放
    const v = this.video;
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('muted', '');
    v.setAttribute('autoplay', '');
    v.srcObject = stream;

    try {
      // 先 play 再等首帧（顺序很关键，见文件头说明）
      await this.ensurePlaying();
      await this._waitFirstFrame();
      return {
        width: v.videoWidth,
        height: v.videoHeight,
        label: track ? track.label : 'camera',
      };
    } catch (err) {
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
