/**
 * features.js — 特征层：从关键点提取原始面部特征
 *
 * 本系统采用「几何通道 + 语义通道」双通道特征：
 *
 *  ┌ 几何通道（可解释、可写公式，论文主线）
 *  │   EAR  眼纵横比  → 眼睛开合程度
 *  │   MAR  嘴纵横比  → 张口程度
 *  │   Euler 头部欧拉角 → 姿态（点头/摇头/侧倾）
 *  └ 语义通道（模型直接回归的表情系数，抗遮挡与极端角度更强）
 *      eyeBlinkL/R、jawOpen、browDown …
 *
 * 两通道互补融合：几何量在大角度侧脸时会因投影压缩而失真，
 * 此时语义通道的 eyeBlink 系数仍然可靠；反之语义通道对轻微眯眼不敏感，
 * 由 EAR 补足。融合后显著降低误报率——这是本设计的核心创新点之一。
 */

import { dist2, matrixToEuler, normalizeAngle, MedianFilter, clamp } from '../util/math.js';

/**
 * FaceLandmarker.detectForVideo 的返回值形状（本地声明，不引入 vendor 类型）。
 * @typedef {object} FaceEngineResult
 * @property {Array<Array<{x:number,y:number,z:number}>>} [faceLandmarks]
 * @property {Array<{data:ArrayLike<number>}>} [facialTransformationMatrixes]
 * @property {Array<Array<{categoryName:string,score:number}>>} [faceBlendshapes]
 */

/**
 * 特征层单帧输出，指标层/质量门控/融合层的共同输入。
 * 无人脸时只返回 { ok:false, ts }，故数值字段均标注为可选。
 * @typedef {object} FeatureSample
 * @property {number} ts 时间戳（毫秒）
 * @property {boolean} ok 是否检测到人脸
 * @property {number} [ear] 眼纵横比（滤波后）
 * @property {number} [earL] 左眼 EAR
 * @property {number} [earR] 右眼 EAR
 * @property {{l:number,r:number}} [earRaw] 未滤波的左右眼 EAR
 * @property {number} [mar] 嘴纵横比
 * @property {number} [pitch] 俯仰角（度）
 * @property {number} [yaw] 偏航角（度）
 * @property {number} [roll] 侧倾角（度）
 * @property {number} [pitchVel] 俯仰角速度（度/秒）
 * @property {string} [poseSource] 姿态解算来源
 * @property {number} [scale] 人脸尺度
 * @property {{h:number,v:number}} [gaze] 视线偏移（水平/垂直）
 * @property {Record<string, number>} [blend] blendshape 全量
 * @property {number} [blinkScore] 语义闭合度（blendshape 均值）
 * @property {number} [squintScore] 眯眼系数
 * @property {number} [browDown] 皱眉系数
 * @property {number} [jawOpen] 张口系数
 * @property {Array<{x:number,y:number,z?:number}>|null} [landmarks] 归一化关键点
 */

import {
  EAR_LEFT,
  EAR_RIGHT,
  MAR_VERTICAL,
  MAR_HORIZONTAL,
  FACE_SCALE_PAIR,
  IRIS_LEFT_CENTER,
  IRIS_RIGHT_CENTER,
  NOSE_TIP,
  CHIN,
  FOREHEAD,
} from './landmarks.js';

/**
 * 计算单眼 EAR。
 *
 *            ‖p2−p6‖ + ‖p3−p5‖
 *   EAR  =  ─────────────────────
 *                2·‖p1−p4‖
 *
 * 分子是上下眼睑的两组竖直距离，分母是眼角水平距离（做尺度归一化）。
 * 睁眼时约 0.25~0.35，闭眼时趋近 0.05~0.10。
 */
export function eyeAspectRatio(lm, idx, aspect) {
  const p1 = lm[idx[0]], p2 = lm[idx[1]], p3 = lm[idx[2]];
  const p4 = lm[idx[3]], p5 = lm[idx[4]], p6 = lm[idx[5]];
  const horizontal = dist2(p1, p4, aspect);
  if (horizontal < 1e-6) return NaN;
  return (dist2(p2, p6, aspect) + dist2(p3, p5, aspect)) / (2 * horizontal);
}

/**
 * 计算 MAR（嘴纵横比）：三组竖直距离均值 / 嘴角水平距离。
 * 闭口约 0.02~0.10，说话 0.15~0.45，哈欠通常 > 0.6 且持续 1s 以上。
 */
export function mouthAspectRatio(lm, aspect) {
  const horizontal = dist2(lm[MAR_HORIZONTAL[0]], lm[MAR_HORIZONTAL[1]], aspect);
  if (horizontal < 1e-6) return NaN;
  let v = 0;
  for (const [a, b] of MAR_VERTICAL) v += dist2(lm[a], lm[b], aspect);
  return v / (MAR_VERTICAL.length * horizontal);
}

/** 面部尺度：两外眼角距离，用于把像素级位移换算成相对量 */
export function faceScale(lm, aspect) {
  return dist2(lm[FACE_SCALE_PAIR[0]], lm[FACE_SCALE_PAIR[1]], aspect);
}

/**
 * 头部姿态。优先用模型输出的 4×4 面部变换矩阵（精度高），
 * 若该输出不可用，则退化为基于鼻-颏-额三点的几何近似（保证功能不中断）。
 */
export function headPose(matrixes, lm, aspect) {
  if (matrixes && matrixes.length && matrixes[0] && matrixes[0].data) {
    const e = matrixToEuler(matrixes[0].data);
    return {
      pitch: normalizeAngle(e.pitch),
      yaw: normalizeAngle(e.yaw),
      roll: normalizeAngle(e.roll),
      source: 'matrix',
    };
  }
  // 几何兜底：用面部三点的相对位置粗估
  const nose = lm[NOSE_TIP], chin = lm[CHIN], fore = lm[FOREHEAD];
  const faceH = dist2(fore, chin, aspect) || 1e-6;
  const midX = (lm[FACE_SCALE_PAIR[0]].x + lm[FACE_SCALE_PAIR[1]].x) / 2;
  const midY = (fore.y + chin.y) / 2;
  const yaw = clamp(((nose.x - midX) * aspect) / faceH, -1, 1) * 90;
  const pitch = clamp((nose.y - midY) / faceH, -1, 1) * 90;
  const dx = (lm[FACE_SCALE_PAIR[1]].x - lm[FACE_SCALE_PAIR[0]].x) * aspect;
  const dy = lm[FACE_SCALE_PAIR[1]].y - lm[FACE_SCALE_PAIR[0]].y;
  const roll = (Math.atan2(dy, dx) * 180) / Math.PI;
  return { pitch, yaw, roll, source: 'geometry' };
}

/** 从 blendshape 数组抽取需要的语义系数（0~1） */
export function readBlendshapes(blendshapes) {
  const out = {
    eyeBlinkLeft: NaN,
    eyeBlinkRight: NaN,
    eyeSquintLeft: NaN,
    eyeSquintRight: NaN,
    jawOpen: NaN,
    mouthPucker: NaN,
    browDownLeft: NaN,
    browDownRight: NaN,
    browInnerUp: NaN,
  };
  if (!blendshapes || !blendshapes.length || !blendshapes[0].categories) return out;
  for (const c of blendshapes[0].categories) {
    if (c.categoryName in out) out[c.categoryName] = c.score;
  }
  return out;
}

/**
 * 视线水平偏移：虹膜中心相对眼眶中心的归一化位移。
 * 用于辅助判断"眼睛虽睁着但视线离开前方"的分心状态。
 */
export function gazeOffset(lm, aspect) {
  if (lm.length <= IRIS_LEFT_CENTER) return { h: NaN, v: NaN };
  const rIris = lm[IRIS_RIGHT_CENTER], lIris = lm[IRIS_LEFT_CENTER];
  const rOuter = lm[33], rInner = lm[133];
  const lInner = lm[362], lOuter = lm[263];
  const rw = dist2(rOuter, rInner, aspect) || 1e-6;
  const lw = dist2(lInner, lOuter, aspect) || 1e-6;
  const rCx = (rOuter.x + rInner.x) / 2, rCy = (rOuter.y + rInner.y) / 2;
  const lCx = (lInner.x + lOuter.x) / 2, lCy = (lInner.y + lOuter.y) / 2;
  const h = (((rIris.x - rCx) * aspect) / rw + ((lIris.x - lCx) * aspect) / lw) / 2;
  const v = ((rIris.y - rCy) / rw + (lIris.y - lCy) / lw) / 2;
  return { h, v };
}

/**
 * FeatureExtractor —— 带滤波与状态的特征提取器。
 *
 * 关键点存在 1~2 像素的固有抖动，直接求导（点头角速度）会被噪声淹没，
 * 因此对 EAR / MAR / 角度均施加短窗中值滤波，再计算差分。
 */
export class FeatureExtractor {
  constructor() {
    this.fEarL = new MedianFilter(5);
    this.fEarR = new MedianFilter(5);
    this.fMar = new MedianFilter(5);
    this.fPitch = new MedianFilter(5);
    this.fYaw = new MedianFilter(5);
    this.fRoll = new MedianFilter(5);
    this.prevPitch = null;
    this.prevTs = null;
  }

  reset() {
    [this.fEarL, this.fEarR, this.fMar, this.fPitch, this.fYaw, this.fRoll].forEach((f) => f.reset());
    this.prevPitch = null;
    this.prevTs = null;
  }

  /**
   * @param {FaceEngineResult|null} result MediaPipe FaceLandmarker 的 detectForVideo 返回值
   * @param {number} ts     时间戳（毫秒，performance.now 基准）
   * @param {number} aspect 画面宽高比（width / height），用于修正归一化坐标的各向异性
   * @returns {FeatureSample}
   */
  extract(result, ts, aspect) {
    const faces = result && result.faceLandmarks;
    if (!faces || !faces.length || !faces[0] || faces[0].length < 468) {
      this.prevPitch = null;
      this.prevTs = ts;
      return { ok: false, ts };
    }
    const lm = faces[0];

    // —— 几何通道 ——
    const earRRaw = eyeAspectRatio(lm, EAR_RIGHT, aspect);
    const earLRaw = eyeAspectRatio(lm, EAR_LEFT, aspect);
    const earR = this.fEarR.push(earRRaw);
    const earL = this.fEarL.push(earLRaw);
    // 双眼取均值：单眼可能被侧脸遮挡或被眼镜反光干扰
    const ear = Number.isFinite(earL) && Number.isFinite(earR) ? (earL + earR) / 2
      : Number.isFinite(earL) ? earL : earR;

    const mar = this.fMar.push(mouthAspectRatio(lm, aspect));

    const pose = headPose(result.facialTransformationMatrixes, lm, aspect);
    const pitch = this.fPitch.push(pose.pitch);
    const yaw = this.fYaw.push(pose.yaw);
    const roll = this.fRoll.push(pose.roll);

    // 俯仰角速度（度/秒）：点头（打盹时头部下沉再猛然抬起）的判据
    let pitchVel = 0;
    if (this.prevPitch !== null && this.prevTs !== null && ts > this.prevTs) {
      pitchVel = ((pitch - this.prevPitch) * 1000) / (ts - this.prevTs);
    }
    this.prevPitch = pitch;
    this.prevTs = ts;

    // —— 语义通道 ——
    const bs = readBlendshapes(result.faceBlendshapes);
    const blinkScore = Number.isFinite(bs.eyeBlinkLeft) && Number.isFinite(bs.eyeBlinkRight)
      ? (bs.eyeBlinkLeft + bs.eyeBlinkRight) / 2
      : NaN;
    const squintScore = Number.isFinite(bs.eyeSquintLeft) && Number.isFinite(bs.eyeSquintRight)
      ? (bs.eyeSquintLeft + bs.eyeSquintRight) / 2
      : NaN;
    const browDown = Number.isFinite(bs.browDownLeft) && Number.isFinite(bs.browDownRight)
      ? (bs.browDownLeft + bs.browDownRight) / 2
      : NaN;

    return {
      ok: true,
      ts,
      landmarks: lm,
      ear,
      earL,
      earR,
      earRaw: { l: earLRaw, r: earRRaw },
      mar,
      pitch,
      yaw,
      roll,
      pitchVel,
      poseSource: pose.source,
      scale: faceScale(lm, aspect),
      gaze: gazeOffset(lm, aspect),
      blend: bs,
      blinkScore,
      squintScore,
      browDown,
      jawOpen: bs.jawOpen,
    };
  }
}
