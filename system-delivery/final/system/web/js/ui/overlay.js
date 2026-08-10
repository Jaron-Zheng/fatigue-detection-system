/**
 * overlay.js — 关键点可视化叠加层
 *
 * 在视频上方用 Canvas 绘制：
 *   · 稀疏面部网格（科技感，同时证明模型确实在工作）
 *   · 眼部轮廓（睁眼绿 / 闭眼红，实时反映 EAR 判定结果）
 *   · 嘴部轮廓（张口时高亮，配合哈欠判定）
 *   · 脸部外轮廓与虹膜
 *   · 头部姿态坐标轴（直观展示 pitch/yaw/roll）
 *
 * 渲染性能：每帧只画约 250 个点 + 若干路径，
 * 在 1080p 下开销约 1~2ms，不会拖慢推理主循环。
 */

import { CONFIG } from '../config.js';
import { fitCanvas, cssVar } from '../util/dom.js';
import {
  MESH_SPARSE,
  CONTOUR_LEFT_EYE,
  CONTOUR_RIGHT_EYE,
  CONTOUR_LIPS_INNER,
  CONTOUR_LIPS_OUTER,
  CONTOUR_FACE_OVAL,
  CONTOUR_LEFT_BROW,
  CONTOUR_RIGHT_BROW,
  IRIS_LEFT,
  IRIS_RIGHT,
  IRIS_LEFT_CENTER,
  IRIS_RIGHT_CENTER,
  NOSE_TIP,
} from '../core/landmarks.js';
import { DEG2RAD } from '../util/math.js';

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.colors = this._readColors();
    this.w = 0;
    this.h = 0;
  }

  _readColors() {
    return {
      mesh: cssVar('--mesh', 'rgba(0,210,255,0.42)'),
      eye: cssVar('--mesh-eye', '#00e0a4'),
      eyeClosed: cssVar('--mesh-eye-closed', '#ff453a'),
      mouth: cssVar('--mesh-mouth', '#ffd60a'),
      oval: cssVar('--mesh-oval', 'rgba(255,255,255,0.55)'),
      iris: cssVar('--mesh-iris', '#64d2ff'),
    };
  }

  refreshTheme() {
    this.colors = this._readColors();
  }

  resize() {
    const r = fitCanvas(this.canvas);
    this.w = r.w;
    this.h = r.h;
    this.ctx = r.ctx;
  }

  clear() {
    if (!this.w) this.resize();
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  /**
   * 绘制一帧。
   * @param {object} feat FeatureExtractor 结果
   * @param {object} state { closed:boolean, mouthOpen:boolean, level:string }
   * @param {object} videoSize { vw, vh } 视频原始尺寸，用于 object-fit:cover 的坐标映射
   */
  draw(feat, state, videoSize) {
    if (!this.w) this.resize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!feat || !feat.ok || !feat.landmarks) return;

    const lm = feat.landmarks;
    const map = this._makeMapper(videoSize);
    const c = this.colors;
    const r = CONFIG.render;

    // ---- 稀疏网格 ----
    if (r.showMesh) {
      ctx.fillStyle = c.mesh;
      for (const i of MESH_SPARSE) {
        const p = map(lm[i]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.15, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---- 轮廓 ----
    if (r.showContours) {
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';

      // 脸廓
      this._path(ctx, lm, CONTOUR_FACE_OVAL, map, true);
      ctx.strokeStyle = c.oval;
      ctx.stroke();

      // 眉毛
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1.3;
      this._path(ctx, lm, CONTOUR_LEFT_BROW, map, false);
      ctx.stroke();
      this._path(ctx, lm, CONTOUR_RIGHT_BROW, map, false);
      ctx.stroke();

      // 眼睛：闭眼变红并加粗，配合发光提升可读性
      const eyeColor = state && state.closed ? c.eyeClosed : c.eye;
      ctx.strokeStyle = eyeColor;
      ctx.lineWidth = state && state.closed ? 2.6 : 1.9;
      ctx.shadowColor = eyeColor;
      ctx.shadowBlur = state && state.closed ? 12 : 5;
      this._path(ctx, lm, CONTOUR_LEFT_EYE, map, true);
      ctx.stroke();
      this._path(ctx, lm, CONTOUR_RIGHT_EYE, map, true);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 嘴：张口时高亮
      const mouthOpen = state && state.mouthOpen;
      ctx.strokeStyle = mouthOpen ? c.mouth : 'rgba(255,255,255,0.46)';
      ctx.lineWidth = mouthOpen ? 2.4 : 1.5;
      if (mouthOpen) {
        ctx.shadowColor = c.mouth;
        ctx.shadowBlur = 10;
      }
      this._path(ctx, lm, CONTOUR_LIPS_OUTER, map, true);
      ctx.stroke();
      this._path(ctx, lm, CONTOUR_LIPS_INNER, map, true);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // ---- 虹膜 ----
    if (r.showIris && lm.length > IRIS_LEFT_CENTER) {
      ctx.strokeStyle = c.iris;
      ctx.fillStyle = c.iris;
      ctx.lineWidth = 1.4;
      for (const ring of [IRIS_LEFT, IRIS_RIGHT]) {
        this._path(ctx, lm, ring, map, true);
        ctx.stroke();
      }
      for (const idx of [IRIS_LEFT_CENTER, IRIS_RIGHT_CENTER]) {
        const p = map(lm[idx]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---- 头部姿态坐标轴 ----
    this._drawPoseAxes(ctx, feat, map(lm[NOSE_TIP]), feat.scale);
  }

  /**
   * 模拟模式下的示意脸绘制。
   *
   * 模拟模式没有真实视频与关键点，但答辩演示时需要让观众"看到"发生了什么，
   * 所以这里用 EAR / MAR / 头部角度直接驱动一张矢量示意脸：
   * 眼睛开合高度 ∝ EAR，嘴部张开高度 ∝ MAR，整张脸随 yaw/roll 偏转。
   * 它同时也是很好的算法教学演示——观众能直观看到特征量与面部状态的对应关系。
   */
  drawSynthetic(feat, state) {
    if (!this.w) this.resize();
    const ctx = this.ctx;
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);
    if (!feat) return;

    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.30;

    const yaw = (feat.yaw || 0) * DEG2RAD;
    const roll = (feat.roll || 0) * DEG2RAD;
    const pitch = (feat.pitch || 0) * DEG2RAD;

    ctx.save();
    ctx.translate(cx + Math.sin(yaw) * R * 0.5, cy + Math.sin(pitch) * R * 0.4);
    ctx.rotate(roll);

    // 背景光晕：按等级着色，强化状态感知
    const levelColor =
      state && state.level === 'severe'
        ? 'rgba(255,69,58,0.30)'
        : state && state.level === 'moderate'
        ? 'rgba(255,159,10,0.24)'
        : state && state.level === 'mild'
        ? 'rgba(255,214,10,0.20)'
        : 'rgba(48,209,88,0.16)';
    const glow = ctx.createRadialGradient(0, 0, R * 0.5, 0, 0, R * 2.1);
    glow.addColorStop(0, levelColor);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, R * 2.1, 0, Math.PI * 2);
    ctx.fill();

    // 脸廓（椭圆随 yaw 压缩，模拟侧转的透视）
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, R * Math.cos(yaw) * 0.82, R * 1.12, 0, 0, Math.PI * 2);
    ctx.stroke();

    // 眼睛：高度由 EAR 决定
    const EAR_OPEN = 0.30;
    const openRatio = Math.max(0.03, Math.min(1, (feat.ear || 0) / EAR_OPEN));
    const eyeW = R * 0.30;
    const eyeH = R * 0.20 * openRatio;
    const eyeY = -R * 0.22;
    const closed = state && state.closed;
    const eyeColor = closed ? this.colors.eyeClosed : this.colors.eye;
    ctx.strokeStyle = eyeColor;
    ctx.fillStyle = closed ? 'rgba(255,69,58,0.18)' : 'rgba(0,224,164,0.14)';
    ctx.lineWidth = closed ? 3 : 2.2;
    ctx.shadowColor = eyeColor;
    ctx.shadowBlur = closed ? 14 : 6;
    for (const sx of [-R * 0.42, R * 0.42]) {
      ctx.beginPath();
      if (eyeH < R * 0.02) {
        ctx.moveTo(sx - eyeW / 2, eyeY);
        ctx.lineTo(sx + eyeW / 2, eyeY);
      } else {
        ctx.ellipse(sx, eyeY, eyeW / 2, eyeH, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.stroke();
      // 瞳孔
      if (eyeH > R * 0.05) {
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.fillStyle = this.colors.iris;
        ctx.beginPath();
        ctx.arc(sx, eyeY, Math.min(eyeH * 0.55, R * 0.055), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.shadowBlur = 0;

    // 眉毛
    ctx.strokeStyle = 'rgba(255,255,255,0.42)';
    ctx.lineWidth = 2.4;
    for (const sx of [-R * 0.42, R * 0.42]) {
      ctx.beginPath();
      ctx.moveTo(sx - eyeW * 0.55, eyeY - R * 0.16);
      ctx.quadraticCurveTo(sx, eyeY - R * 0.235, sx + eyeW * 0.55, eyeY - R * 0.16);
      ctx.stroke();
    }

    // 鼻
    ctx.strokeStyle = 'rgba(255,255,255,0.34)';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(0, eyeY + R * 0.1);
    ctx.lineTo(-R * 0.06, R * 0.16);
    ctx.lineTo(R * 0.05, R * 0.17);
    ctx.stroke();

    // 嘴：高度由 MAR 决定
    const mar = feat.mar || 0;
    const mouthOpen = state && state.mouthOpen;
    const mouthW = R * 0.56;
    const mouthH = Math.max(R * 0.035, Math.min(R * 0.62, mar * R * 0.95));
    const mouthY = R * 0.48;
    ctx.strokeStyle = mouthOpen ? this.colors.mouth : 'rgba(255,255,255,0.5)';
    ctx.fillStyle = mouthOpen ? 'rgba(255,214,10,0.20)' : 'rgba(255,255,255,0.06)';
    ctx.lineWidth = mouthOpen ? 3 : 2;
    if (mouthOpen) {
      ctx.shadowColor = this.colors.mouth;
      ctx.shadowBlur = 12;
    }
    ctx.beginPath();
    ctx.ellipse(0, mouthY, mouthW / 2, mouthH / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.restore();

    // 说明文字（控制条已移出视频，底部空间可用）
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '600 13px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`演示模式 · 当前阶段：${feat.phase || '--'}`, w / 2, h - 40);
    ctx.font = '400 11px -apple-system, "PingFang SC", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    // 专业模式下说明信号来源；简洁模式只说这是模拟的，避免抛术语
    const sub = document.body.classList.contains('pro-mode')
      ? '示意脸由 EAR / MAR / 头部角度直接驱动，用于演示与自动化测试'
      : '这是模拟出来的脸，不使用摄像头';
    ctx.fillText(sub, w / 2, h - 22);
  }

  /**
   * 生成归一化坐标 → 画布像素 的映射函数。
   * 视频用 object-fit: cover 填充，因此需要按较大缩放比裁切居中，
   * 否则关键点会与画面错位（这是实现叠加层最容易踩的坑）。
   */
  _makeMapper(videoSize) {
    const vw = (videoSize && videoSize.vw) || 4;
    const vh = (videoSize && videoSize.vh) || 3;
    const cw = this.w;
    const ch = this.h;
    const scale = Math.max(cw / vw, ch / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const ox = (cw - dw) / 2;
    const oy = (ch - dh) / 2;
    const mirror = CONFIG.render.mirror;
    return (p) => {
      const x = mirror ? 1 - p.x : p.x;
      return { x: ox + x * dw, y: oy + p.y * dh };
    };
  }

  _path(ctx, lm, idxs, map, close) {
    ctx.beginPath();
    for (let i = 0; i < idxs.length; i++) {
      const p = map(lm[idxs[i]]);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    if (close) ctx.closePath();
  }

  /** 以鼻尖为原点画三轴，长度随人脸尺度自适应 */
  _drawPoseAxes(ctx, feat, origin, faceScale) {
    if (!Number.isFinite(feat.pitch)) return;
    const L = Math.max(34, Math.min(78, (faceScale || 0.2) * this.w * 0.55));
    const mirror = CONFIG.render.mirror ? -1 : 1;
    const p = feat.pitch * DEG2RAD;
    const y = feat.yaw * DEG2RAD * mirror;
    const r = feat.roll * DEG2RAD * mirror;

    const cp = Math.cos(p), sp = Math.sin(p);
    const cy = Math.cos(y), sy = Math.sin(y);
    const cr = Math.cos(r), sr = Math.sin(r);

    // R = Rz(roll)·Ry(yaw)·Rx(pitch)，只取投影到屏幕的 x、y 分量
    const axes = [
      { v: [cr * cy, sr * cy], color: '#ff453a', label: 'X' },
      { v: [cr * sy * sp - sr * cp, sr * sy * sp + cr * cp], color: '#30d158', label: 'Y' },
      { v: [cr * sy * cp + sr * sp, sr * sy * cp - cr * sp], color: '#0a84ff', label: 'Z' },
    ];

    ctx.save();
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    for (const a of axes) {
      ctx.strokeStyle = a.color;
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(origin.x + a.v[0] * L, origin.y - a.v[1] * L);
      ctx.stroke();
    }
    ctx.restore();
  }
}
