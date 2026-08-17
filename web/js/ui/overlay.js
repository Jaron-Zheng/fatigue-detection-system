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
import { DEG2RAD, clamp } from '../util/math.js';

/** #rrggbb + alpha → rgba() 字符串（示意脸的状态色需要不同透明度分层） */
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(255,255,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

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
      /* E4 批量绘制：156 个网格点原先逐点 beginPath/arc/fill（156 次
       * 绘制调用）；改为单个 Path2D 收拢全部圆弧后一次 fill。每个圆弧
       * 前先 moveTo 到圆心右侧（x+r, y），避免上一段弧的终点与下一段
       * 弧的起点之间被补出连线。点还是那些点，肉眼完全等价。 */
      ctx.fillStyle = c.mesh;
      const dots = new Path2D();
      for (const i of MESH_SPARSE) {
        const p = map(lm[i]);
        dots.moveTo(p.x + 1.15, p.y);
        dots.arc(p.x, p.y, 1.15, 0, Math.PI * 2);
      }
      ctx.fill(dots);
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
      /* E4：shadowBlur 只在闭眼（异常告警）时开启——常态睁眼每帧
       * 给两条眼轮廓开 5px 高斯模糊是纯开销（GPU 按像素扩散），
       * 且睁眼本就绿色细线、无需强调；闭眼时的 12px 红色发光是
       * 告警视觉强调，语义保留。 */
      const eyeColor = state && state.closed ? c.eyeClosed : c.eye;
      ctx.strokeStyle = eyeColor;
      ctx.lineWidth = state && state.closed ? 2.6 : 1.9;
      ctx.shadowColor = eyeColor;
      ctx.shadowBlur = state && state.closed ? 12 : 0;
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
   * 模拟模式下的示意脸绘制（v2 重设计）。
   *
   * 模拟模式没有真实视频与关键点，但答辩演示时需要让观众"看到"发生了什么，
   * 所以这里用 EAR / MAR / 头部角度直接驱动一张矢量示意脸：
   *   · 眼睛是上下两条眼睑曲线围成的杏仁形，闭眼 = 上眼睑真实下落盖住眼睛，
   *     而不是把椭圆压扁——观众能看懂"眼皮在合上"这个动作本身；
   *   · 嘴的张开走下颌旋转语义：下唇与下巴随 jawOpen 下垂，哈欠时呈圆形开口；
   *   · 头/颈/肩三层结构给出驾驶坐姿语境，随 pitch/yaw/roll 一起运动；
   *   · 疲劳语义细节：眉毛下沉内倾（困倦眉）、中重度出现眼袋弧线；
   *   · 头周一圈等级色状态环 + 极淡光晕，替代 v1 的大面积光斑。
   * 它同时也是很好的算法教学演示——观众能直观看到特征量与面部状态的对应关系。
   */
  drawSynthetic(feat, state) {
    if (!this.w) this.resize();
    const ctx = this.ctx;
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);
    if (!feat) return;

    const cx = w / 2;
    const cy = h * 0.46;
    const R = Math.min(w, h) * 0.26;

    const yaw = (feat.yaw || 0) * DEG2RAD;
    const roll = (feat.roll || 0) * DEG2RAD;
    const pitch = (feat.pitch || 0) * DEG2RAD;

    /* ---- 派生量 ----
     * EAR 0.30=全睁 0.055=全闭 → 归一化开合度；哈欠用 jawOpen（0..1）。
     * breathing：3.8s 周期的轻微起伏，让静息状态也不是一张死脸。 */
    const openRatio = clamp((feat.ear - 0.055) / (0.3 - 0.055), 0, 1);
    const jaw = clamp(feat.jawOpen ?? clamp((feat.mar - 0.06) / (0.85 - 0.06), 0, 1), 0, 1);
    const level = (state && state.level) || 'awake';
    const LV = {
      awake: '#30d158',
      mild: '#ffd60a',
      moderate: '#ff9f0a',
      severe: '#ff453a',
    };
    const lvColor = LV[level] || LV.awake;
    const fatigueK = level === 'severe' ? 1 : level === 'moderate' ? 0.6 : level === 'mild' ? 0.3 : 0;
    const breath = Math.sin((feat.ts || 0) / 1900) * R * 0.012;

    /* 头部整体变换：yaw 平移 + roll 旋转 + pitch 下沉 + 呼吸 */
    ctx.save();
    ctx.translate(cx + Math.sin(yaw) * R * 0.55, cy + Math.sin(pitch) * R * 0.38 + breath);
    ctx.rotate(roll);
    const persp = Math.cos(yaw); // 侧转时脸宽轻微压缩（透视暗示）

    /* ---- 肩部与颈部（坐姿语境，画在头后面） ---- */
    this._synShoulders(ctx, R);
    this._synNeck(ctx, R, persp);

    /* ---- 状态环 + 光晕 ---- */
    const glow = ctx.createRadialGradient(0, 0, R * 0.6, 0, 0, R * 1.42);
    glow.addColorStop(0, hexA(lvColor, 0.10 + fatigueK * 0.14));
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = hexA(lvColor, 0.62);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([R * 0.12, R * 0.1]);
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.32, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    /* ---- 头（蛋形 + 发际 + 耳） ---- */
    this._synHead(ctx, R, persp);

    /* ---- 面部器官（眼/眉/鼻/嘴，画在头变换内） ---- */
    this._synFace(ctx, R, persp, openRatio, jaw, fatigueK, state, Math.sin(yaw));

    ctx.restore();

    /* ---- 底部说明：阶段胶囊 + 副标题（不随头动） ---- */
    const phase = feat.phase || '--';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const pillW = Math.max(150, ctx.measureText(`演示模式 · ${phase}`).width + 64);
    const pillH = 28;
    const pillY = h - 52;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.strokeStyle = hexA(lvColor, 0.55);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(w / 2 - pillW / 2, pillY, pillW, pillH, pillH / 2);
    ctx.fill();
    ctx.stroke();
    // 指示点
    ctx.fillStyle = lvColor;
    ctx.beginPath();
    ctx.arc(w / 2 - pillW / 2 + 16, pillY + pillH / 2, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '600 13px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(`演示模式 · ${phase}`, w / 2 + 8, pillY + pillH / 2 + 0.5);
    ctx.font = '400 11px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.textBaseline = 'alphabetic';
    // 专业模式下说明信号来源；简洁模式只说这是模拟的，避免抛术语
    const sub = document.body.classList.contains('pro-mode')
      ? '示意脸由 EAR / MAR / 头部角度直接驱动，用于演示与自动化测试'
      : '这是模拟出来的脸，不使用摄像头';
    ctx.fillText(sub, w / 2, h - 14);
  }

  /* ============ 示意脸 v3 的分部件绘制（坐标以头部中心为原点、R 为半径） ============ */

  /** 肩部：一条大弧线给出"人坐在方向盘后"的剪影暗示（v3 抬高肩线，缩短颈部） */
  _synShoulders(ctx, R) {
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = R * 0.13;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-R * 1.62, R * 1.86);
    ctx.quadraticCurveTo(-R * 1.5, R * 1.16, 0, R * 1.1);
    ctx.quadraticCurveTo(R * 1.5, R * 1.16, R * 1.62, R * 1.86);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  /** 颈部：从下颌延伸到肩线的两笔 */
  _synNeck(ctx, R, persp) {
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = R * 0.09;
    ctx.beginPath();
    ctx.moveTo(-R * 0.26 * persp, R * 0.82);
    ctx.lineTo(-R * 0.30 * persp, R * 1.18);
    ctx.moveTo(R * 0.26 * persp, R * 0.82);
    ctx.lineTo(R * 0.30 * persp, R * 1.18);
    ctx.stroke();
  }

  /** 头（v3）：鹅蛋形 + 暖调柔和填充 + 平涂"发型帽" + 双耳 */
  _synHead(ctx, R, persp) {
    const hw = R * 0.72 * Math.max(0.72, persp); // 半宽
    const hh = R * 1.02; // 半高
    // 鹅蛋轮廓：颅顶圆 → 颞部 → 颊部收窄 → 圆下巴
    ctx.beginPath();
    ctx.moveTo(0, -hh);
    ctx.bezierCurveTo(hw * 0.82, -hh, hw, -hh * 0.55, hw * 0.98, -hh * 0.08);
    ctx.bezierCurveTo(hw * 0.96, hh * 0.4, hw * 0.5, hh * 0.9, 0, hh * 0.98);
    ctx.bezierCurveTo(-hw * 0.5, hh * 0.9, -hw * 0.96, hh * 0.4, -hw * 0.98, -hh * 0.08);
    ctx.bezierCurveTo(-hw, -hh * 0.55, -hw * 0.82, -hh, 0, -hh);
    ctx.closePath();
    // 皮肤：带一点暖调的柔和体量感（替代 v2 的冷白）
    const skin = ctx.createLinearGradient(0, -hh, 0, hh);
    skin.addColorStop(0, 'rgba(255,244,232,0.17)');
    skin.addColorStop(0.7, 'rgba(255,248,240,0.09)');
    skin.addColorStop(1, 'rgba(255,255,255,0.04)');
    ctx.fillStyle = skin;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1.7;
    ctx.stroke();

    // 发型帽：一瓣干净的平涂剪影（暖棕发色，近黑舞台上仍有体量）
    ctx.beginPath();
    ctx.moveTo(-hw * 0.88, -hh * 0.26);
    ctx.quadraticCurveTo(-hw * 0.9, -hh * 0.97, 0, -hh * 0.955);
    ctx.quadraticCurveTo(hw * 0.9, -hh * 0.97, hw * 0.88, -hh * 0.26);
    // 下缘：中间略高的中分弧
    ctx.quadraticCurveTo(hw * 0.52, -hh * 0.4, 0, -hh * 0.38);
    ctx.quadraticCurveTo(-hw * 0.52, -hh * 0.4, -hw * 0.88, -hh * 0.26);
    ctx.closePath();
    const hair = ctx.createLinearGradient(0, -hh, 0, -hh * 0.3);
    hair.addColorStop(0, 'rgba(178,146,112,0.30)');
    hair.addColorStop(1, 'rgba(150,122,92,0.18)');
    ctx.fillStyle = hair;
    ctx.fill();

    // 耳：与眼睛齐平的小椭圆，1/3 突出于脸廓外（v3 眼位在头部中点）
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(s * hw * 1.03, 0, R * 0.078, R * 0.108, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }
  }

  /** 面部器官（v3）：杏仁眼+视线 / 干净拱形眉 / 极简鼻 / 下颌嘴 / 疲劳细节 */
  _synFace(ctx, R, persp, openRatio, jaw, fatigueK, state, gaze = 0) {
    const closed = state && state.closed;
    const mouthOpen = state && state.mouthOpen;

    /* ---- 疲劳红晕：轻度末段两颊渐起，疲劳越深越红 ---- */
    if (fatigueK >= 0.3) {
      for (const s of [-1, 1]) {
        const g2 = ctx.createRadialGradient(s * R * 0.42, R * 0.12, 0, s * R * 0.42, R * 0.12, R * 0.2);
        g2.addColorStop(0, `rgba(255,132,120,${0.08 + fatigueK * 0.12})`);
        g2.addColorStop(1, 'rgba(255,132,120,0)');
        ctx.fillStyle = g2;
        ctx.beginPath();
        ctx.arc(s * R * 0.42, R * 0.12, R * 0.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    /* ---- 眼睛：位于头部纵向中点，间距约 1 眼宽（面部比例基准） ----
     * 杏仁形 = 内外眼角之间上、下两条眼睑曲线。
     * 上眼睑弧高随 openRatio 从全开落到 0，且随疲劳基线下垂 —— 闭眼与疲劳都可见。
     * 虹膜随视线（yaw）同向偏移并被开口裁剪；睁眼带瞳孔与高光。 */
    const eyeY = -R * 0.02;
    const eyeDX = R * 0.33 * Math.max(0.78, persp);
    const eyeW2 = R * 0.17; // 半宽
    const lidH = R * 0.115 * (0.06 + 0.94 * openRatio) * (1 - fatigueK * 0.32); // 上眼睑弧高（含疲劳下垂）
    const lowH = R * 0.068; // 下眼睑弧高（基本不动）
    const eyeColor = closed ? this.colors.eyeClosed : this.colors.eye;

    for (const s of [-1, 1]) {
      const ex = s * eyeDX;

      /* 眉毛：干净的拱形（暖灰，白眉在深色舞台像发光条），疲劳时下沉并内倾 */
      const droop = fatigueK * R * 0.055 + (1 - openRatio) * R * 0.018;
      const browY = eyeY - R * 0.15 - droop;
      ctx.strokeStyle = 'rgba(205,192,174,0.66)';
      ctx.lineWidth = R * 0.026;
      ctx.lineCap = 'round';
      ctx.beginPath();
      // 内侧端点比外侧低 → 内倾（困）
      const inner = ex - s * eyeW2 * 1.0;
      const outer = ex + s * eyeW2 * 1.18;
      ctx.moveTo(inner, browY + R * 0.012 + fatigueK * R * 0.026);
      ctx.quadraticCurveTo(ex, browY - R * 0.05, outer, browY + R * 0.014);
      ctx.stroke();
      ctx.lineCap = 'butt';

      if (lidH > R * 0.012) {
        /* 睁眼：眼睑透镜形 + 虹膜 + 瞳孔 + 高光 */
        const lens = () => {
          ctx.beginPath();
          ctx.moveTo(ex - eyeW2, eyeY);
          ctx.quadraticCurveTo(ex, eyeY - lidH * 2.0, ex + eyeW2, eyeY);
          ctx.quadraticCurveTo(ex, eyeY + lowH * 2.0, ex - eyeW2, eyeY);
          ctx.closePath();
        };
        lens();
        ctx.fillStyle = 'rgba(8,12,17,0.88)';
        ctx.fill();
        ctx.save();
        lens();
        ctx.clip();
        const irisR = R * 0.062;
        const irisX = ex + gaze * R * 0.035;
        const irisY = eyeY - lidH * 0.22 + lowH * 0.2; // 虹膜上移：上眼睑自然盖住虹膜上缘
        ctx.fillStyle = hexA(this.colors.iris, 0.92);
        ctx.beginPath();
        ctx.arc(irisX, irisY, irisR, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(4,8,12,0.75)';
        ctx.beginPath();
        ctx.arc(irisX, irisY, irisR * 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(irisX - irisR * 0.32, irisY - irisR * 0.36, irisR * 0.24, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        // 眼睑描边：上缘清晰、下缘轻
        ctx.strokeStyle = eyeColor;
        ctx.lineWidth = 1.9;
        ctx.shadowColor = eyeColor;
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.moveTo(ex - eyeW2, eyeY);
        ctx.quadraticCurveTo(ex, eyeY - lidH * 2.0, ex + eyeW2, eyeY);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(ex - eyeW2, eyeY);
        ctx.quadraticCurveTo(ex, eyeY + lowH * 2.0, ex + eyeW2, eyeY);
        ctx.stroke();
      } else {
        /* 闭眼：一条干净的下弯线（v3 去掉小尺寸下易显脏的睫毛撇） */
        ctx.strokeStyle = closed ? this.colors.eyeClosed : 'rgba(255,255,255,0.62)';
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        ctx.shadowColor = closed ? this.colors.eyeClosed : 'transparent';
        ctx.shadowBlur = closed ? 14 : 0;
        ctx.beginPath();
        ctx.moveTo(ex - eyeW2, eyeY - R * 0.012);
        ctx.quadraticCurveTo(ex, eyeY + R * 0.05, ex + eyeW2, eyeY - R * 0.012);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.lineCap = 'butt';
      }

      /* ---- 眼袋：轻度末段起出现，疲劳越深越明显 ---- */
      if (fatigueK >= 0.3) {
        ctx.strokeStyle = `rgba(130,152,182,${0.16 + fatigueK * 0.2})`;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(ex - eyeW2 * 0.82, eyeY + R * 0.1);
        ctx.quadraticCurveTo(ex, eyeY + R * 0.15, ex + eyeW2 * 0.82, eyeY + R * 0.1);
        ctx.stroke();
      }
    }

    /* ---- 鼻（v3）：鼻根起于两眼内眦连线，极简一笔 + 对称鼻翼 ---- */
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(gaze * R * 0.02, R * 0.02);
    ctx.quadraticCurveTo(gaze * R * 0.045, R * 0.16, gaze * R * 0.015, R * 0.225);
    ctx.stroke();
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(s * R * 0.048 + gaze * R * 0.015, R * 0.24, R * 0.026, Math.PI * 0.05, Math.PI * 0.95);
      ctx.stroke();
    }

    /* ---- 嘴：下颌旋转语义，唇形更收敛 ----
     * 上唇基本不动（哈欠时略抬），下唇随 jaw 下垂；
     * 开口内部填充深色，哈欠 (jaw>0.5) 时接近正圆。 */
    const mw = R * 0.2 * Math.max(0.8, persp);
    const my = R * 0.5;
    const lipTop = my - R * 0.026 - jaw * R * 0.05;
    const lipBot = my + R * 0.028 + jaw * R * 0.34;
    const round = clamp((jaw - 0.35) / 0.65, 0, 1); // 圆口插值
    ctx.beginPath();
    ctx.moveTo(-mw, my - R * 0.006);
    ctx.quadraticCurveTo(-mw * 0.5, lipTop, 0, lipTop);
    ctx.quadraticCurveTo(mw * 0.5, lipTop, mw, my - R * 0.006);
    // 下唇：从圆口的弧到闭合时的浅弧插值
    const botCtrl = my + (lipBot - my) * (1 - round * 0.45);
    ctx.quadraticCurveTo(mw * (1 - round * 0.15), botCtrl, 0, lipBot - round * R * 0.02);
    ctx.quadraticCurveTo(-mw * (1 - round * 0.15), botCtrl, -mw, my - R * 0.006);
    ctx.closePath();
    ctx.fillStyle = jaw > 0.06 ? 'rgba(10,7,11,0.92)' : 'rgba(255,255,255,0.05)';
    ctx.fill();
    ctx.strokeStyle = mouthOpen ? this.colors.mouth : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = mouthOpen ? 2.1 : 1.6;
    if (mouthOpen) {
      ctx.shadowColor = this.colors.mouth;
      ctx.shadowBlur = 9;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
    // 下唇反光弧：闭合时的立体感（替代 v2 唇峰细线）
    if (jaw <= 0.06) {
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-mw * 0.55, my + R * 0.045);
      ctx.quadraticCurveTo(0, my + R * 0.062, mw * 0.55, my + R * 0.045);
      ctx.stroke();
    }

    /* ---- 下巴阴影：张口时随下颌下移 ---- */
    const chinY = R * 0.79 + jaw * R * 0.1;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-R * 0.09, chinY);
    ctx.quadraticCurveTo(0, chinY + R * 0.032, R * 0.09, chinY);
    ctx.stroke();
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
