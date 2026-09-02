/**
 * quality.js — 数据质量门控
 *
 * 【为什么必须做质量门控】
 * 疲劳指标建立在关键点精度之上。当人脸太远、偏出画面、侧转过大或光照恶劣时，
 * 关键点定位误差会显著放大，此时算出的 EAR 不再可信。
 * 如果照旧把这些帧计入 PERCLOS，系统会给出一个"看起来正常"但实际无意义的结论——
 * 对安全相关功能来说，明确说"现在测不准"远好于给出虚假的安全感。
 *
 * 【一个关键取舍：低头不作为门控条件】
 * 俯仰角向下会让眼部区域被透视压缩，从"数据质量"角度确实该丢弃。
 * 但低头恰恰是打盹最典型的表现——把它当作坏数据丢掉，等于系统在最需要
 * 报警的时刻选择沉默。因此本系统只把「侧转(yaw)」和「侧倾(roll)」作为门控，
 * 俯仰(pitch)只测量与记录，不影响帧的有效性。
 */

import { CONFIG } from '../config.js';
import { clamp } from '../util/math.js';

/**
 * 评估人脸取景质量。
 * @param {Array<{x:number,y:number}>|null} lm 归一化关键点
 * @param {number} aspect 画面宽高比
 * @param {import('./features.js').FeatureSample} feat 已提取的特征（用于取角度）
 * @param {import('./calibration.js').CalibrationResult|null} calib 标定结果（角度以标定零点为基准）
 * @returns {{valid:boolean, reasons:string[], label:string, faceWidthRatio?:number, centerOffset?:number, yawDev?:number, rollDev?:number}}
 */
export function evaluateFaceQuality(lm, aspect, feat, calib) {
  const g = CONFIG.quality;
  if (!g.enabled) return { valid: true, reasons: [], label: '未启用门控' };
  if (!lm || !lm.length) return { valid: false, reasons: ['未检测到人脸'], label: '无人脸' };

  // 单次遍历求包围盒（每帧 478 点，避免多次 map/spread 分配）
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < lm.length; i++) {
    const p = lm[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const faceW = maxX - minX;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const reasons = [];
  // 人脸在画面中的占比：过小意味着距离过远，关键点像素精度不足
  if (faceW < g.minFaceWidthRatio) reasons.push('面部距离过远，请靠近摄像头');
  if (faceW > g.maxFaceWidthRatio) reasons.push('面部距离过近，请稍微后退');
  // 偏离画面中心过多：边缘畸变大
  const offset = Math.hypot((cx - 0.5) * aspect, cy - 0.5);
  if (offset > g.maxCenterOffset) reasons.push('请将面部移到画面中央');

  // 侧转与侧倾（相对标定零点）。注意：不检查 pitch（低头是疲劳信号，见文件头注释）
  const dYaw = Math.abs((feat.yaw || 0) - (calib ? calib.yaw0 : 0));
  const dRoll = Math.abs((feat.roll || 0) - (calib ? calib.roll0 : 0));
  if (dYaw > g.maxYawDeg) reasons.push('头部侧转过大，请正对摄像头');
  if (dRoll > g.maxRollDeg) reasons.push('头部侧倾过大，请扶正头部');

  return {
    valid: reasons.length === 0,
    reasons,
    label: reasons.length ? '质量不足' : '良好',
    faceWidthRatio: clamp(faceW, 0, 1),
    centerOffset: offset,
    yawDev: dYaw,
    rollDev: dRoll,
  };
}

/**
 * LightingMonitor — 光照质量评估
 *
 * 把视频帧降采样到 64×36 后统计亮度分布，识别过暗、过曝与低对比度（背光）。
 * 复用同一张离屏画布，避免每次评估都新建 canvas 造成 GC 压力；
 * 评估频率也做了限制（默认每秒 2 次），因为光照不会逐帧剧变。
 */
export class LightingMonitor {
  constructor() {
    this.W = 64;
    this.H = 36;
    this.ctx = null;
    this.lastAt = 0;
    this.result = { valid: true, label: '光照良好', average: 0, contrast: 0, darkRatio: 0, brightRatio: 0 };
  }

  _surface() {
    if (this.ctx) return this.ctx;
    let canvas;
    if (typeof OffscreenCanvas === 'function') {
      canvas = new OffscreenCanvas(this.W, this.H);
    } else {
      canvas = document.createElement('canvas');
      canvas.width = this.W;
      canvas.height = this.H;
    }
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    return this.ctx;
  }

  /**
   * @param {HTMLVideoElement} video
   * @param {number} now
   * @returns {object} 最近一次评估结果（未到评估间隔时返回缓存值）
   */
  evaluate(video, now) {
    const g = CONFIG.quality;
    if (!g.lightingEnabled) return this.result;
    if (now - this.lastAt < g.lightingIntervalMs) return this.result;
    if (!video || video.readyState < 2 || !video.videoWidth) return this.result;
    this.lastAt = now;

    try {
      const ctx = this._surface();
      ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, 0, this.W, this.H);
      const data = ctx.getImageData(0, 0, this.W, this.H).data;
      let sum = 0, sumSq = 0, dark = 0, bright = 0;
      const n = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        // Rec.709 亮度权重
        const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        sum += y;
        sumSq += y * y;
        if (y < 45) dark++;
        if (y > 235) bright++;
      }
      const average = sum / n;
      const contrast = Math.sqrt(Math.max(0, sumSq / n - average * average));
      const darkRatio = dark / n;
      const brightRatio = bright / n;

      let label = '光照良好';
      if (darkRatio > 0.5 || average < 55) label = '光线偏暗，建议增加正面照明';
      else if (brightRatio > 0.35) label = '画面过曝，请避开强光直射';
      else if (contrast < 18) label = '对比度不足，可能存在背光';

      this.result = { valid: label === '光照良好', label, average, contrast, darkRatio, brightRatio };
    } catch {
      // 跨域视频等情况下 getImageData 会抛错，此时不阻断检测；
      // valid 设为 null 表示"未评估"，区别于 true（合格）和 false（不合格）
      this.result = { valid: null, label: '光照未知', average: 0, contrast: 0, darkRatio: 0, brightRatio: 0 };
    }
    return this.result;
  }

  reset() {
    this.lastAt = 0;
    this.result = { valid: true, label: '光照良好', average: 0, contrast: 0, darkRatio: 0, brightRatio: 0 };
  }
}
