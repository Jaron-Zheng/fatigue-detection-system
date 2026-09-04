/**
 * calibration.js — 个性化基线标定
 *
 * 【为什么必须做标定】
 * 固定 EAR 阈值（如文献常用 0.2）在实际中误判严重：
 *   · 单/双眼皮、内双、眼型窄的人天然 EAR 偏低，会被持续误判为闭眼；
 *   · 戴眼镜、镜头俯角不同都会整体缩放 EAR；
 *   · 头部相对相机的俯仰角会让眼睛在图像上被投影压缩。
 * 因此本系统在检测开始前采集数秒「自然睁眼 + 正视前方」样本，
 * 得到该驾驶员的个体基线，再按比例导出阈值，同时把头部姿态零点也校准到
 * 「正视方向」。这样同一套参数可跨个体、跨设备复用。
 *
 * 标定量：
 *   earOpenBaseline  = median(EAR)             睁眼基线（中位数抗离群）
 *   earCloseThresh   = baseline × 0.72         闭眼判定阈值
 *   earOpenThresh    = baseline × 0.80         睁眼恢复阈值（滞回，防抖）
 *   marBaseline      = median(MAR)             闭口基线
 *   marOpenThresh    = baseline + 0.35         张口阈值
 *   pitch0/yaw0/roll0= median(角度)            头部姿态零点
 *   blinkRateBaseline                          个体眨眼频率（融合时用相对偏移）
 */

import { CONFIG } from '../config.js';
import { median, stdev, mean } from '../util/math.js';

/** 睁眼 EAR 基线下限（见 _finish 说明）。TODO: 待 AppConfig 类型补齐后迁入 CONFIG.calibration */
const MIN_EAR_BASELINE = 0.12;

/**
 * 标定结果。失败/跳过时携带 reason 并回退通用阈值（fallback 字段）。
 * @typedef {object} CalibrationResult
 * @property {boolean} ok 是否成功
 * @property {boolean} [skipped] 是否跳过校准直接用通用阈值
 * @property {string} [reason] 失败原因
 * @property {number} [quality] 标定质量 0-1
 * @property {string} qualityLabel 质量文字标签
 * @property {number} [sampleCount] 有效样本数
 * @property {number} [faceLostRatio] 标定期间人脸丢失占比
 * @property {number} earBaseline 睁眼 EAR 基线
 * @property {number} [earStdev] 基线波动
 * @property {number} earCloseThresh 闭眼判定阈值
 * @property {number} earOpenThresh 睁眼恢复阈值
 * @property {number} marBaseline 闭口 MAR 基线
 * @property {number} marOpenThresh 张口阈值
 * @property {number} pitch0 姿态零点（俯仰）
 * @property {number} yaw0 姿态零点（偏航）
 * @property {number} roll0 姿态零点（侧倾）
 */

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

  /** 开始标定 */
  start(now = performance.now()) {
    this.state = CalibState.COLLECTING;
    this.startTs = now;
    for (const k of Object.keys(this.samples)) this.samples[k].length = 0;
    this.result = null;
    this.lostFrames = 0;
    this.totalFrames = 0;
    /**
     * validMs 只累计「画面里确实有人脸」的时长，人脸不在时倒计时暂停。
     *
     * 为什么不用墙上时间：点开始检测到人真正坐正、面部完整进画面，
     * 中间总有几秒。按墙上时间计时的话，这几秒会被算作标定时间，
     * 8 秒窗口里可能只有 2 秒有效帧，于是标定失败、回退通用阈值——
     * 而失败原因（"有效样本不足"）对用户来说完全看不出该怎么补救。
     * 倒计时暂停后，用户看到的就是「进度不走 → 我还没被看到 → 调整位置」。
     */
    this.validMs = 0;
    this.lastTs = null;
  }

  get durationMs() {
    return CONFIG.calibration.durationSec * 1000;
  }

  /** 标定进度 0~1（按累计有效时长，不是墙上时间） */
  progress() {
    if (this.state !== CalibState.COLLECTING) return this.state === CalibState.DONE ? 1 : 0;
    return Math.min(1, this.validMs / this.durationMs);
  }

  /**
   * 送入一帧特征。返回 true 表示标定已结束（成功或失败）。
   */
  feed(feat, now = performance.now()) {
    if (this.state !== CalibState.COLLECTING) return false;
    this.totalFrames++;

    // 帧间隔上限 500ms：卡顿或标签页切后台时不要一次记入几秒有效时长
    const dt = this.lastTs === null ? 0 : Math.min(Math.max(now - this.lastTs, 0), 500);
    this.lastTs = now;
    if (feat.ok) this.validMs += dt;

    if (!feat.ok) {
      this.lostFrames++;
    } else {
      // 剔除标定期间的眨眼帧：眨眼会把睁眼基线拉低。
      // 判据：语义通道 eyeBlink 系数偏高，或 EAR 明显低于当前样本中位数。
      const blinking =
        (Number.isFinite(feat.blinkScore) && feat.blinkScore > 0.45) ||
        (this.samples.ear.length > 15 && feat.ear < median(this.samples.ear) * 0.75);
      if (!blinking) {
        if (Number.isFinite(feat.ear)) this.samples.ear.push(feat.ear);
        if (Number.isFinite(feat.mar)) this.samples.mar.push(feat.mar);
        if (Number.isFinite(feat.scale)) this.samples.scale.push(feat.scale);
        // blinkScore 同样需要排除眨眼帧，否则眨眼时的高峰会拉高基线，
        // 导致 _semClosure 计算的语义闭合度系统性偏低
        if (Number.isFinite(feat.blinkScore)) this.samples.blink.push(feat.blinkScore);
      }
      // 姿态零点不受眨眼影响，全部帧都可用
      if (Number.isFinite(feat.pitch)) this.samples.pitch.push(feat.pitch);
      if (Number.isFinite(feat.yaw)) this.samples.yaw.push(feat.yaw);
      if (Number.isFinite(feat.roll)) this.samples.roll.push(feat.roll);
    }

    // 采集够了 → 正常结束
    if (this.validMs >= this.durationMs) {
      this._finish();
      return true;
    }
    // 一直等不到人脸也不能无限挂着：超时后照常走失败分支，回退通用阈值
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
    /* 基线合理性下限：标定期间一直闭眼/眯眼、或暗光下眼裂被算得极小时，睁眼基线会
     * 接近 0，派生的闭眼线（×0.72）更接近 0——之后整场会话永远判不出闭眼，且不会报失败。
     * 0.12 取自 EAR 生理下界（Soukupová & Čech 2016：闭眼态约 0.05~0.10；最窄眼型的
     * 睁眼态也高于 0.15）以下留裕量：低于此值的"睁眼样本"不可能是睁眼。 */
    if (!(earBase >= MIN_EAR_BASELINE)) {
      this.state = CalibState.FAILED;
      this.result = {
        ok: false,
        reason: `睁眼基线异常（${earBase.toFixed(3)} < ${MIN_EAR_BASELINE}），标定期间请保持自然睁眼、正视镜头`,
        ...this._fallback(),
      };
      return;
    }

    const earSd = stdev(ear, mean(ear));
    const marBase = this.samples.mar.length ? median(this.samples.mar) : 0.08;

    // 稳定性评估：标定期间 EAR 波动过大说明用户没保持自然睁眼或人脸不稳定
    const cv = earBase > 1e-6 ? earSd / earBase : 1; // 变异系数
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

  /** 跳过标定，直接用通用固定阈值（对照实验用：可展示"无标定"时的误判） */
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
