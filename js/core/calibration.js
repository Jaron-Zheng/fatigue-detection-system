/**
 * calibration.js — 个性化基线标定
 *
 * 检测开始前采集数秒「自然睁眼 + 正视前方」样本，
 * 得到该驾驶员的个体基线（EAR 睁眼值、MAR 闭口值、头部姿态零点），
 * 再按比例导出闭眼/睁眼/张口阈值。失败时回退通用固定阈值。
 */

import { CONFIG } from '../config.js';
import { median, stdev, mean } from '../util/math.js';

export const CalibState = {
  IDLE: 'idle',
  COLLECTING: 'collecting',
  DONE: 'done',
  FAILED: 'failed',
};

export class Calibrator {
  constructor() {
    this.state = CalibState.IDLE;
    this.startTs = 0;
    this.samples = { ear: [], mar: [], pitch: [], yaw: [], roll: [], scale: [], blink: [] };
    this.result = null;
    this.lostFrames = 0;
    this.totalFrames = 0;
  }

  /** 开始标定采集 */
  start(now = performance.now()) {
    this.state = CalibState.COLLECTING;
    this.startTs = now;
    for (const k of Object.keys(this.samples)) this.samples[k].length = 0;
    this.result = null;
    this.lostFrames = 0;
    this.totalFrames = 0;
    this.validMs = 0;
    this.lastTs = null;
  }

  get durationMs() {
    return CONFIG.calibration.durationSec * 1000;
  }

  /** 标定进度 0~1（按累计有效时长） */
  progress() {
    if (this.state !== CalibState.COLLECTING) return this.state === CalibState.DONE ? 1 : 0;
    return Math.min(1, this.validMs / this.durationMs);
  }

  /**
   * 送入一帧特征，返回 true 表示标定已结束（成功或失败）。
   * 帧间隔上限 500ms，防止卡顿时记入大段时间。
   * 眨眼帧会被剔除（避免把睁眼基线拉低）。
   */
  feed(feat, now = performance.now()) {
    if (this.state !== CalibState.COLLECTING) return false;
    this.totalFrames++;

    const dt = this.lastTs === null ? 0 : Math.min(Math.max(now - this.lastTs, 0), 500);
    this.lastTs = now;
    if (feat.ok) this.validMs += dt;

    if (!feat.ok) {
      this.lostFrames++;
    } else {
      const blinking =
        (Number.isFinite(feat.blinkScore) && feat.blinkScore > 0.45) ||
        (this.samples.ear.length > 15 && feat.ear < median(this.samples.ear) * 0.75);
      if (!blinking) {
        if (Number.isFinite(feat.ear)) this.samples.ear.push(feat.ear);
        if (Number.isFinite(feat.mar)) this.samples.mar.push(feat.mar);
        if (Number.isFinite(feat.scale)) this.samples.scale.push(feat.scale);
        if (Number.isFinite(feat.blinkScore)) this.samples.blink.push(feat.blinkScore);
      }
      if (Number.isFinite(feat.pitch)) this.samples.pitch.push(feat.pitch);
      if (Number.isFinite(feat.yaw)) this.samples.yaw.push(feat.yaw);
      if (Number.isFinite(feat.roll)) this.samples.roll.push(feat.roll);
    }

    if (this.validMs >= this.durationMs) {
      this._finish();
      return true;
    }
    const waitCapMs = this.durationMs + CONFIG.calibration.maxWaitSec * 1000;
    if (now - this.startTs >= waitCapMs) {
      this._finish();
      return true;
    }
    return false;
  }

  _finish() {
    const c = CONFIG.calibration;
    const ear = this.samples.ear;

    if (ear.length < c.minSamples) {
      this.state = CalibState.FAILED;
      this.result = {
        ok: false,
        reason: `有效样本不足（${ear.length}/${c.minSamples}）`,
        ...this._fallback(),
      };
      return;
    }

    const earBase = median(ear);
    const minEar = CONFIG.calibration.minEarBaseline;
    if (!(earBase >= minEar)) {
      this.state = CalibState.FAILED;
      this.result = {
        ok: false,
        reason: `睁眼基线异常（${earBase.toFixed(3)} < ${minEar}），标定期间请保持自然睁眼、正视镜头`,
        ...this._fallback(),
      };
      return;
    }

    const earSd = stdev(ear, mean(ear));
    const marBase = this.samples.mar.length ? median(this.samples.mar) : 0.08;

    // 稳定性评估：EAR 变异系数 + 人脸丢失率
    const cv = earBase > 1e-6 ? earSd / earBase : 1;
    const faceLostRatio = this.totalFrames ? this.lostFrames / this.totalFrames : 1;
    const quality = Math.max(0, Math.min(1, 1 - cv * 3 - faceLostRatio * 1.5));

    this.state = CalibState.DONE;
    this.result = {
      ok: true,
      quality,
      qualityLabel: quality > 0.75 ? '优' : quality > 0.5 ? '良' : quality > 0.3 ? '中' : '差',
      sampleCount: ear.length,
      faceLostRatio,
      earBaseline: earBase,
      earStdev: earSd,
      earCloseThresh: earBase * c.earCloseRatio,
      earOpenThresh: earBase * c.earOpenRatio,
      marBaseline: marBase,
      marOpenThresh: marBase + c.marOpenDelta,
      pitch0: this.samples.pitch.length ? median(this.samples.pitch) : 0,
      yaw0: this.samples.yaw.length ? median(this.samples.yaw) : 0,
      roll0: this.samples.roll.length ? median(this.samples.roll) : 0,
      scaleBaseline: this.samples.scale.length ? median(this.samples.scale) : 0,
      blinkScoreBaseline: this.samples.blink.length ? median(this.samples.blink) : 0.05,
      calibratedAt: new Date().toISOString(),
    };
  }

  /** 通用固定阈值回退 */
  _fallback() {
    const f = CONFIG.calibration.fallback;
    return {
      quality: 0,
      qualityLabel: '未校准',
      earBaseline: f.earClose / CONFIG.calibration.earCloseRatio,
      earCloseThresh: f.earClose,
      earOpenThresh: f.earOpen,
      marBaseline: 0.08,
      marOpenThresh: f.marOpen,
      pitch0: 0,
      yaw0: 0,
      roll0: 0,
      scaleBaseline: 0,
      blinkScoreBaseline: 0.05,
      calibratedAt: new Date().toISOString(),
    };
  }

  /** 跳过标定，直接用通用固定阈值 */
  useFallback() {
    this.state = CalibState.DONE;
    this.result = { ok: true, skipped: true, ...this._fallback() };
    return this.result;
  }

  reset() {
    this.state = CalibState.IDLE;
    this.result = null;
    for (const k of Object.keys(this.samples)) this.samples[k].length = 0;
  }
}
