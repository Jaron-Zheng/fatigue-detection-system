/**
 * video-source.js — 视频文件输入源与固定步长离线评测
 *
 * 【为什么不能直接"播放视频然后实时检测"】
 * 实时播放时每秒能处理多少帧取决于主机性能、GPU 负载、浏览器调度。
 * 同一段视频在不同机器上会得到不同的采样序列，PERCLOS 这类时间占比指标
 * 也会随之漂移——结果不可复现，不能用作实验数据。
 *
 * 因此评测采用**固定步长 seek**：把视频定位到 t、t+Δ、t+2Δ … 逐点取帧推理。
 * 这样采样序列完全由 Δ 决定，与播放速度和主机性能无关，任何机器上重跑
 * 都得到同一结果。代价是耗时长于实时播放（每次 seek 都要等解码）。
 *
 * 【步长的取舍】
 * 正常眨眼持续 100~400ms。步长取 200ms 时，一次 150ms 的眨眼可能整个落在
 * 两个采样点之间而被漏掉，导致眨眼频率被低估；但 PERCLOS 与长闭眼
 * （>500ms）仍然可靠，因为它们跨越多个采样点。
 * 默认取 100ms 以尽量保住眨眼检出，同时把这个局限如实标注在报告里。
 */

import { CONFIG } from '../config.js';

const MAX_VIDEO_FILE_BYTES = 1024 * 1024 * 1024;

export class VideoFileSource {
  constructor(videoEl) {
    this.video = videoEl;
    this.url = null;
    this.file = null;
    this.ready = false;
  }

  /** 载入本地文件（不上传，仅用 blob URL 在本机解码） */
  async load(file) {
    if (!file || typeof file.size !== 'number' || typeof file.name !== 'string') {
      throw new Error('请选择一个本地视频文件。');
    }
    if (file.size <= 0) throw new Error('所选视频为空，请重新选择文件。');
    if (file.size > MAX_VIDEO_FILE_BYTES) {
      throw new Error('视频超过 1GB 安全限制。请裁剪为较短片段后再进行离线评测。');
    }
    if (file.type && !file.type.startsWith('video/')) {
      throw new Error('请选择视频文件。建议使用 MP4（H.264）格式。');
    }
    this.release();
    this.file = file;
    this.url = URL.createObjectURL(file);
    const v = this.video;
    v.srcObject = null;
    v.src = this.url;
    v.muted = true;
    v.playsInline = true;
    v.loop = false;

    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('视频加载超时，可能是格式不受支持（建议 MP4/H.264）')), 20000);
      const ok = () => {
        clearTimeout(to);
        resolve();
      };
      const fail = () => {
        clearTimeout(to);
        reject(new Error('无法解码该视频文件，请改用 MP4（H.264）格式'));
      };
      if (v.readyState >= 2) ok();
      else {
        v.addEventListener('loadeddata', ok, { once: true });
        v.addEventListener('error', fail, { once: true });
      }
    });

    // 部分浏览器在 loadeddata 时 duration 仍为 Infinity，先等一次 durationchange
    if (!Number.isFinite(v.duration) || v.duration <= 0) {
      await new Promise((r) => {
        v.addEventListener('durationchange', () => r(), { once: true });
        setTimeout(r, 1200);
      });
    }
    this._duration = await this._probeDuration();

    this.ready = true;
    return {
      name: file.name,
      sizeBytes: file.size,
      duration: this._duration,
      width: v.videoWidth,
      height: v.videoHeight,
      durationProbed: !Number.isFinite(v.duration) || v.duration <= 0,
    };
  }

  /**
   * 探测真实时长。
   *
   * 流式录制的 WebM（MediaRecorder、部分录屏软件与手机 App 的导出）
   * 不会写入 Duration 元数据，此时 video.duration 为 Infinity，
   * 直接使用会导致评测无法启动。
   *
   * 标准处理办法：把 currentTime 设到一个远超实际时长的位置，
   * 浏览器会把它钳制到可播放的末尾，此时读回 currentTime 即为真实时长。
   * 探测完必须复位到 0，否则后续逐点 seek 的起点就错了。
   */
  async _probeDuration() {
    const v = this.video;
    if (Number.isFinite(v.duration) && v.duration > 0) return v.duration;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        v.removeEventListener('seeked', onSeeked);
        // 复位到开头，供后续评测使用
        try {
          v.currentTime = 0;
        } catch {
          /* 忽略 */
        }
        resolve(Number.isFinite(val) && val > 0 ? val : 0);
      };
      const onSeeked = () => finish(v.currentTime);
      v.addEventListener('seeked', onSeeked);
      try {
        v.currentTime = 1e7; // 远大于任何实际视频时长
      } catch {
        finish(0);
        return;
      }
      setTimeout(() => finish(Number.isFinite(v.duration) ? v.duration : v.currentTime), 3000);
    });
  }

  /** 精确定位到指定时刻并等待该帧解码完成 */
  seekTo(t) {
    const v = this.video;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        v.removeEventListener('seeked', done);
        resolve();
      };
      // seek 到完全相同的时间不会触发 seeked，这里做一个极小偏移兜底
      if (Math.abs(v.currentTime - t) < 1e-4) {
        // 已在目标位置：用 rAF 让出一帧，确保画面已提交
        requestAnimationFrame(() => requestAnimationFrame(done));
        return;
      }
      v.addEventListener('seeked', done);
      v.currentTime = t;
      // 兜底超时，避免个别浏览器不触发 seeked 导致卡死
      setTimeout(done, 800);
    });
  }

  get aspect() {
    const w = this.video.videoWidth || CONFIG.capture.width;
    const h = this.video.videoHeight || CONFIG.capture.height;
    return w / h;
  }

  get duration() {
    if (Number.isFinite(this.video.duration) && this.video.duration > 0) return this.video.duration;
    // 元数据缺失时使用载入阶段探测到的时长
    return Number.isFinite(this._duration) && this._duration > 0 ? this._duration : 0;
  }

  release() {
    if (this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.ready = false;
    this.file = null;
    this._duration = 0;
  }
}

/**
 * 时间区间标注表。
 *
 * 用户录一段包含多种状态的连续视频，然后在时间轴上划分区间并打标签。
 * 相比"一个视频一个标签"，区间标注的好处是状态过渡自然，
 * 还能检验系统在状态切换时的响应延迟。
 *
 * 标签体系与系统输出对齐但更粗（二分类 + 未标注）：
 *   normal  正常/清醒
 *   fatigue 疲劳（含轻度以上）
 *   ignore  不计入评估（例如调整坐姿、离开画面的片段）
 *
 * 为什么用二分类而不是四级：主观自评很难可靠区分"轻度"与"中度"，
 * 强行四分类会引入大量标注噪声。二分类的判据明确（"我当时困不困"），
 * 标注一致性高，得出的准确率指标也更可信。
 */
export class IntervalAnnotation {
  constructor() {
    /** @type {{start:number, end:number, label:string}[]} */
    this.intervals = [];
  }

  add(start, end, label) {
    const s = Math.max(0, Math.min(start, end));
    const e = Math.max(start, end);
    if (e - s < 0.2) return { error: '区间过短（至少 0.2 秒）' };
    if (!['normal', 'fatigue', 'ignore'].includes(label)) return { error: '未知标签：' + label };
    // 与已有区间重叠时，先裁掉重叠部分，保证任一时刻只有一个标签
    this.intervals = this.intervals.flatMap((iv) => {
      if (e <= iv.start || s >= iv.end) return [iv];
      const parts = [];
      if (iv.start < s) parts.push({ ...iv, end: s });
      if (iv.end > e) parts.push({ ...iv, start: e });
      return parts;
    });
    this.intervals.push({ start: s, end: e, label });
    this.intervals.sort((a, b) => a.start - b.start);
    return { ok: true };
  }

  remove(index) {
    if (index >= 0 && index < this.intervals.length) this.intervals.splice(index, 1);
  }

  clear() {
    this.intervals.length = 0;
  }

  /** 查询某时刻（秒）的人工标签；未标注返回 null */
  labelAt(tSec) {
    for (const iv of this.intervals) {
      if (tSec >= iv.start && tSec < iv.end) return iv.label;
    }
    return null;
  }

  get coverage() {
    return this.intervals.reduce((s, iv) => s + (iv.end - iv.start), 0);
  }

  toJSON() {
    return this.intervals.map((iv) => ({
      start: Number(iv.start.toFixed(2)),
      end: Number(iv.end.toFixed(2)),
      label: iv.label,
    }));
  }

  static fromJSON(arr) {
    const a = new IntervalAnnotation();
    for (const iv of arr || []) a.add(iv.start, iv.end, iv.label);
    return a;
  }
}
