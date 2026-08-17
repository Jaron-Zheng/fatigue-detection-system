/**
 * face-engine.js — 人脸关键点推理引擎（MediaPipe Face Landmarker 封装）
 *
 * 全部推理在浏览器本地完成：
 *   摄像头帧 → WebAssembly/WebGL 推理 → 478 个 3D 关键点 + 52 个表情系数
 *              + 4×4 头部变换矩阵
 * 视频帧从不离开本机，不存在隐私上传问题——这是选择端侧方案的首要理由。
 *
 * 兼容性策略：
 *   · 优先 GPU 委托（WebGL 后端），失败自动回退 CPU（XNNPACK）；
 *   · wasm 目录同时包含 SIMD 与非 SIMD 版本，运行时由 MediaPipe 自动择优；
 *   · 全部资源本地托管，断网可用。
 */

import { CONFIG } from '../config.js';

/**
 * 本地资源根路径。
 *
 * 注意这里必须解析成绝对 URL，不能直接写 './vendor'：
 *   · 动态 import() 的相对路径基准是「当前模块文件」→ 会解析成 /js/core/vendor/...
 *   · 而 MediaPipe 内部 fetch wasm/模型时的基准是「文档 URL」→ /vendor/...
 * 两个基准不一致，用相对路径必然有一方出错。
 * 用 import.meta.url 换算出绝对 URL 后，两者都能正确命中。
 */
const VENDOR_BASE = new URL('../../vendor', import.meta.url).href;

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
      onProgress('正在载入推理运行时…', 10);
      const mod = await import(`${VENDOR_BASE}/tasks-vision/vision_bundle.mjs`);
      const { FaceLandmarker, FilesetResolver } = mod;

      onProgress('正在初始化 WebAssembly…', 30);
      const fileset = await FilesetResolver.forVisionTasks(`${VENDOR_BASE}/tasks-vision/wasm`);
      this._vision = { FaceLandmarker, fileset };

      const baseOptions = {
        modelAssetPath: `${VENDOR_BASE}/models/face_landmarker.task`,
      };

      onProgress('正在加载人脸关键点模型…', 55);
      // 先尝试 GPU，失败则回退 CPU
      const tryCreate = async (delegate) => {
        return FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { ...baseOptions, delegate },
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
      timeout._clear = () => clearTimeout(timerId);
      this.stream = await Promise.race([
        navigator.mediaDevices.getUserMedia(constraints).then((s) => {
          timeout._clear();
          return s;
        }),
        timeout,
      ]);
    } catch (err) {
      if (err && err.message === 'CAMERA_PERMISSION_TIMEOUT') {
        throw new Error('等待摄像头授权超时（15 秒无响应）。请在浏览器弹窗中点击「允许」，然后重新开始检测。');
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
