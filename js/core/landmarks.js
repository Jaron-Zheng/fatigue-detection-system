/**
 * landmarks.js — MediaPipe Face Landmarker 关键点索引表
 *
 * 模型输出 478 个 3D 关键点：0~467 为面部网格（Face Mesh 拓扑），
 * 468~477 为两个虹膜各 5 点（Iris Refinement，用于视线粗估与绘制）。
 * EAR 六点方案与经典 Dlib 68 点方案一一对应。
 */

/** 右眼（画面左侧）EAR 六点 */
export const EAR_RIGHT = [33, 160, 158, 133, 153, 144];

/** 左眼（画面右侧）EAR 六点 */
export const EAR_LEFT = [362, 385, 387, 263, 373, 380];

/** 嘴部 MAR：三组垂直距离 + 一组水平基准 */
export const MAR_VERTICAL = [
  [13, 14],
  [82, 87],
  [312, 317],
];
export const MAR_HORIZONTAL = [78, 308];

/** 面部尺度基准：两外眼角距离 */
export const FACE_SCALE_PAIR = [33, 263];

/** 鼻尖 / 下巴 / 额头：用于头部姿态的几何兜底估计 */
export const NOSE_TIP = 1;
export const CHIN = 152;
export const FOREHEAD = 10;

/** 虹膜中心（Iris Refinement 输出） */
export const IRIS_RIGHT_CENTER = 468;
export const IRIS_LEFT_CENTER = 473;
export const IRIS_RIGHT = [469, 470, 471, 472];
export const IRIS_LEFT = [474, 475, 476, 477];

/** 绘制用轮廓（闭合环） */
export const CONTOUR_RIGHT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
export const CONTOUR_LEFT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
export const CONTOUR_LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
export const CONTOUR_LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
export const CONTOUR_FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];
export const CONTOUR_RIGHT_BROW = [46, 53, 52, 65, 55, 70, 63, 105, 66, 107];
export const CONTOUR_LEFT_BROW = [276, 283, 282, 295, 285, 300, 293, 334, 296, 336];

/** 稀疏网格采样点：每 3 点取 1，视觉上仍是完整"科技感"网格 */
export const MESH_SPARSE = (() => {
  const arr = [];
  for (let i = 0; i < 468; i += 3) arr.push(i);
  return arr;
})();

/** Blendshape 名称 → 语义通道映射 */
export const BLENDSHAPE_KEYS = {
  eyeBlinkLeft: 'eyeBlinkLeft',
  eyeBlinkRight: 'eyeBlinkRight',
  eyeSquintLeft: 'eyeSquintLeft',
  eyeSquintRight: 'eyeSquintRight',
  jawOpen: 'jawOpen',
  mouthPucker: 'mouthPucker',
  browDownLeft: 'browDownLeft',
  browDownRight: 'browDownRight',
  browInnerUp: 'browInnerUp',
};
