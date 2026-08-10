/**
 * evaluator.js — 视频离线评测执行器
 *
 * 把「视频文件 → 固定步长取帧 → 完整算法管线 → 与人工标签比对」串成一条流水线。
 *
 * 关键设计：**复用与实时检测完全相同的算法模块**
 * （FeatureExtractor / Calibrator / IndicatorEngine / FusionEngine）。
 * 如果评测走另一套简化实现，得出的准确率就不能代表实际系统的表现，
 * 实验也就失去意义。这也是为什么算法层从一开始就与 UI、输入源解耦。
 *
 * 评测流程：
 *   ① 标定段：取视频前若干秒（或用户指定区间）做个性化基线标定；
 *   ② 评测段：从 0 开始按固定步长逐点推理，累积指标并输出逐点判定；
 *   ③ 比对：把每个采样点的系统判定与人工区间标签配对，算混淆矩阵。
 */

import { CONFIG } from '../config.js';
import { FeatureExtractor } from './features.js';
import { Calibrator, CalibState } from './calibration.js';
import { IndicatorEngine } from './indicators.js';
import { FusionEngine } from './fusion.js';
import { evaluateFaceQuality } from './quality.js';
import { computeMetrics, computeLatency, sweepPositiveThreshold } from './evaluation.js';

export class VideoEvaluator {
  /**
   * @param {FaceEngine} engine 已初始化的推理引擎
   * @param {VideoFileSource} source 已载入视频的输入源
   */
  constructor(engine, source) {
    this.engine = engine;
    this.source = source;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }

  /**
   * 执行评测。
   *
   * @param {object} opts
   *   stepMs       采样步长（毫秒），默认取 CONFIG.evaluation.stepMs
   *   calibSec     用于标定的时长（从视频开头算），0 表示跳过标定用通用阈值
   *   annotation   IntervalAnnotation 实例（可为 null，此时只出指标不出准确率）
   *   positiveFrom 二分类正类起始等级
   *   onProgress   (done, total, tSec) => void
   */
  async run(opts = {}) {
    const ev = CONFIG.evaluation;
    const stepMs = opts.stepMs || ev.stepMs;
    const calibSec = opts.calibSec === undefined ? ev.calibSec : opts.calibSec;
    const annotation = opts.annotation || null;
    const positiveFrom = opts.positiveFrom || 'mild';
    const onProgress = opts.onProgress || (() => {});
    const annotationSnapshot = annotation ? annotation.toJSON() : [];

    const duration = this.source.duration;
    if (!(duration > 0)) return { error: '无法获取视频时长，请确认文件完整' };
    if (stepMs > CONFIG.window.maxSampleGapMs) {
      return {
        error:
          `采样步长 ${stepMs}ms 超过了观测间断阈值 ${CONFIG.window.maxSampleGapMs}ms，` +
          `每一帧都会被判为间断而无法累积 PERCLOS。请把步长调小。`,
      };
    }

    this.cancelled = false;
    const extractor = new FeatureExtractor();
    const calibrator = new Calibrator();
    const indicators = new IndicatorEngine();
    const fusion = new FusionEngine();
    const aspect = this.source.aspect;

    /**
     * 时间戳基准。
     *
     * 送入 MediaPipe 的时间戳必须全局严格单调递增。这里有两处会破坏单调性：
     *   ① 引擎可能刚跑过实时检测，已用过很大的 performance.now() 时间戳；
     *   ② 本次评测内部分两阶段（标定、评测），若两阶段都从 0 开始就会回退。
     * 因此先向引擎申请一个安全基准，再让标定段与评测段在这个基准之上
     * 各占一段互不重叠的区间。
     *
     * 注意上层算法（指标层/融合层）用的仍是"视频内相对时间"，
     * 只有传给引擎的时间戳带偏移，两者不能混用。
     */
    const tsBase = this.engine.reserveTimestampBase(2000);
    const calibSpanMs = Math.ceil(Math.min(calibSec, duration) * 1000) + stepMs;
    const evalTsBase = tsBase + calibSpanMs + 1000;

    /* ---------- 阶段一：个性化标定 ---------- */
    let calib;
    let calibInfo = { used: false };
    if (calibSec > 0) {
      // 标定器按真实时间推进，这里用虚拟时间戳喂它
      const savedDuration = CONFIG.calibration.durationSec;
      try {
        CONFIG.calibration.durationSec = calibSec;
        calibrator.start(0);
        const calibEnd = Math.min(calibSec, duration);
        for (let t = 0; t < calibEnd; t += stepMs / 1000) {
          if (this.cancelled) return { cancelled: true };
          await this.source.seekTo(t);
          const localMs = t * 1000;
          // 引擎收到的是带偏移的时间戳；标定器收到的是视频内相对时间
          const res = this.engine.detect(this.source.video, Math.round(tsBase + localMs), true);
          const feat = res ? extractor.extract(res, localMs, aspect) : { ok: false, ts: localMs };
          if (calibrator.feed(feat, localMs)) break;
        }
        if (calibrator.state !== CalibState.DONE) calibrator._finish();
      } finally {
        CONFIG.calibration.durationSec = savedDuration;
      }
      calib = calibrator.result;
      calibInfo = {
        used: true,
        ok: !!(calib && calib.ok),
        reason: calib && calib.reason,
        earBaseline: calib && calib.earBaseline,
        earCloseThresh: calib && calib.earCloseThresh,
        quality: calib && calib.qualityLabel,
        sampleCount: calib && calib.sampleCount,
        durationSec: calibSec,
      };
    }
    if (!calib || !calib.ok) {
      calib = calibrator.useFallback();
      calibInfo.fallback = true;
    }

    /* ---------- 阶段二：逐点推理 ---------- */
    extractor.reset();
    const samples = [];
    const total = Math.max(1, Math.floor((duration * 1000) / stepMs));
    let done = 0;
    let faceLostPoints = 0;

    for (let ms = 0; ms < duration * 1000; ms += stepMs) {
      if (this.cancelled) return { cancelled: true };
      const tSec = ms / 1000;
      await this.source.seekTo(tSec);

      const res = this.engine.detect(this.source.video, Math.round(evalTsBase + ms), true);
      const feat = res ? extractor.extract(res, ms, aspect) : { ok: false, ts: ms };
      if (!feat.ok) faceLostPoints++;

      let quality = null;
      if (feat.ok && feat.landmarks) {
        quality = {
          face: evaluateFaceQuality(feat.landmarks, aspect, feat, calib),
          // 视频评测不做逐帧光照评估（开销大且离线场景光照恒定），沿用默认
          lighting: { valid: true, label: '光照未评估' },
        };
      }

      const ind = indicators.update(feat, calib, quality);
      const fus = fusion.evaluate(ind, calib);
      indicators.pushScore(ms, fus.score);

      samples.push({
        tSec: Number(tSec.toFixed(3)),
        tMs: Math.round(ms),
        score: Number(fus.score.toFixed(2)),
        raw: Number(fus.raw.toFixed(2)),
        level: fus.level,
        unreliable: fus.unreliable,
        perclos: Number(ind.perclos.toFixed(4)),
        perclosReady: ind.perclosReady,
        maxClosureMs: Math.round(ind.maxClosureMs),
        currentClosureMs: Math.round(ind.currentClosureMs),
        blinkRate: Number(ind.blinkRate.toFixed(2)),
        avgBlinkMs: Number.isFinite(ind.avgBlinkMs) ? Math.round(ind.avgBlinkMs) : null,
        yawnRate: Number(ind.yawnRate.toFixed(3)),
        nodRate: Number(ind.nodRate.toFixed(3)),
        headDevRatio: Number(ind.headDevRatio.toFixed(3)),
        ear: feat.ok && Number.isFinite(feat.ear) ? Number(feat.ear.toFixed(4)) : null,
        mar: feat.ok && Number.isFinite(feat.mar) ? Number(feat.mar.toFixed(4)) : null,
        pitch: feat.ok && Number.isFinite(feat.pitch) ? Number(feat.pitch.toFixed(2)) : null,
        yaw: feat.ok && Number.isFinite(feat.yaw) ? Number(feat.yaw.toFixed(2)) : null,
        facePresent: feat.ok ? 1 : 0,
        dataValid: ind.dataValid === false ? 0 : 1,
      });

      done++;
      if (done % 8 === 0 || done === total) onProgress(done, total, tSec);
      // 让出主线程，保持界面可响应与进度可见
      if (done % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    /* ---------- 阶段三：与人工标签比对 ---------- */
    let metrics = null;
    let latency = null;
    let sweep = null;
    let labelStats = null;

    if (annotation && annotation.intervals.length) {
      const pairs = samples.map((s) => ({
        truth: annotation.labelAt(s.tSec) || 'unlabeled',
        pred: s.level,
        weightMs: stepMs,
      }));
      pairs.forEach((p, i) => {
        samples[i].truth = p.truth;
      });
      metrics = computeMetrics(pairs, positiveFrom);
      const series = samples.map((s, i) => ({
        tSec: s.tSec,
        truth: pairs[i].truth,
        pred: s.level,
      }));
      latency = computeLatency(series, positiveFrom);
      sweep = sweepPositiveThreshold(pairs);

      const cnt = { normal: 0, fatigue: 0, ignore: 0, unlabeled: 0 };
      for (const p of pairs) cnt[p.truth] = (cnt[p.truth] || 0) + 1;
      labelStats = {
        counts: cnt,
        secs: Object.fromEntries(Object.entries(cnt).map(([k, v]) => [k, (v * stepMs) / 1000])),
        coverageSec: annotation.coverage,
      };
    }

    const events = indicators.events.map((e) => ({
      type: e.type,
      tSec: Number((e.ts / 1000).toFixed(2)),
      level: e.level || 'info',
      message: e.message || '',
      durationMs: e.durationMs || null,
    }));

    return {
      ok: true,
      file: this.source.file ? { name: this.source.file.name, sizeBytes: this.source.file.size } : null,
      video: {
        durationSec: Number(duration.toFixed(2)),
        width: this.source.video.videoWidth,
        height: this.source.video.videoHeight,
      },
      config: { stepMs, calibSec, positiveFrom },
      calibration: calibInfo,
      annotation: annotationSnapshot,
      samples,
      events,
      metrics,
      latency,
      sweep,
      labelStats,
      quality: {
        faceLostPoints,
        faceLostRatio: samples.length ? faceLostPoints / samples.length : 0,
        // 人脸丢失率过高说明视频本身不适合评测（取景、光照或遮挡问题）
        usable: samples.length > 0 && faceLostPoints / samples.length < 0.35,
      },
      summary: {
        finalLevel: samples.length ? samples[samples.length - 1].level : 'awake',
        peakScore: samples.reduce((m, s) => Math.max(m, s.score), 0),
        avgScore: samples.length ? samples.reduce((a, s) => a + s.score, 0) / samples.length : 0,
        levelSecs: (() => {
          const acc = { awake: 0, mild: 0, moderate: 0, severe: 0 };
          for (const s of samples) acc[s.level] = (acc[s.level] || 0) + stepMs / 1000;
          return acc;
        })(),
      },
    };
  }
}
