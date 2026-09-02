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
 */
function isLocalEnv() {
  const host = location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' ||
    /^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
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
 * 下载模型文件为 Uint8Array（供 modelAssetBuffer 使用）。
 * 线上按镜像链依次尝试（前三个 jsdelivr 域名各设超时，同源兜底不限时）；
 * 本地直接同源加载。全部失败时抛错，由调用方回退 modelAssetPath。
 * @param {(msg: string, pct: number) => void} [onProgress] 加载进度回调
 */
async function fetchModelBuffer(onProgress = () => {}) {
  const local = isLocalEnv();
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
    this.stats = { infer: 0, totalMs: 0, lastMs: 0, dropped: 0 };
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
      const tryCreate = async (delegate) => {
        const opts = modelBuffer
          ? { modelAssetBuffer: modelBuffer.slice(), delegate }
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
      };

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
      // 时间戳回退等偶发错误：跳过该帧而不是崩掉整个循环
      console.warn('[FaceEngine] detectForVideo 异常，跳过该帧：', err);
      return null;
    }
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
    this.stats = { infer: 0, totalMs: 0, lastMs: 0, dropped: 0 };
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
 */
export class CameraSource {
  constructor(videoEl) {
    this.video = videoEl;
    this.stream = null;
    this.deviceId = null;
  }

  static get supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  async listCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  async start(deviceId = null) {
    if (!CameraSource.supported) {
      throw new Error('当前浏览器不支持摄像头采集（navigator.mediaDevices 不可用）。请使用最新版 Chrome / Edge。');
    }
    const c = CONFIG.capture;
    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: c.width }, height: { ideal: c.height } }
        : { facingMode: c.facingMode, width: { ideal: c.width }, height: { ideal: c.height }, frameRate: { ideal: 30 } },
    };

    try {
      /**
       * 权限弹窗超时兜底：
       * 用户忽略权限对话框时 getUserMedia 会一直 pending，
       * 界面将停留在 BOOTING 无任何反馈（实测"卡死"投诉的根源之一）。
       * 15 秒未决即放弃并给出可操作的提示。
       */
      // 声明必须先于 Promise 构造：executor 同步执行，若 timerId 还在
      // TDZ（let 提升但未初始化）赋值会直接抛 ReferenceError
      let timerId = null;
      const timeout = new Promise((_, reject) => {
        timerId = setTimeout(() => reject(new Error('CAMERA_PERMISSION_TIMEOUT')), 15000);
      });
      const clearTimeout15s = () => clearTimeout(timerId);
      this.stream = await Promise.race([
        navigator.mediaDevices.getUserMedia(constraints).then((s) => {
          clearTimeout15s();
          return s;
        }),
        timeout,
      ]);
    } catch (err) {
      if (err && err.message === 'CAMERA_PERMISSION_TIMEOUT') {
        throw new Error('等待摄像头授权超时（15 秒无响应）。请在浏览器弹窗中点击「允许」，然后重新开始检测。', { cause: err });
      }
      throw new Error(CameraSource.friendlyError(err), { cause: err });
    }

    this.deviceId = deviceId;
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;

    try {
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('摄像头画面加载超时，请检查设备是否被其他程序占用。')), 12000);
        const onReady = () => {
          clearTimeout(to);
          resolve(undefined);
        };
        if (this.video.readyState >= 2) onReady();
        else this.video.addEventListener('loadeddata', onReady, { once: true });
      });

      await this.video.play().catch(() => {});
      return {
        width: this.video.videoWidth,
        height: this.video.videoHeight,
        label: this.stream.getVideoTracks()[0] ? this.stream.getVideoTracks()[0].label : 'camera',
      };
    } catch (err) {
      this.stop();
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
        return '摄像头被其他程序占用（如会议软件、相机应用）。请关闭后重试。';
      case 'OverconstrainedError':
        return '摄像头不支持请求的分辨率，请在设置中降低采集分辨率。';
      case 'SecurityError':
        return '当前页面不是安全上下文，无法访问摄像头。请通过 http://localhost 访问。';
      default:
        return '摄像头启动失败：' + ((err && err.message) || String(err));
    }
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
  }

  get aspect() {
    const w = this.video.videoWidth || CONFIG.capture.width;
    const h = this.video.videoHeight || CONFIG.capture.height;
    return w / h;
  }
}
