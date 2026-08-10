/**
 * csv-schema.js — CSV 列定义（导出与导入的唯一真相来源）
 *
 * 【为什么要单独抽出来】
 * 表头改成中文之后，「导出的 CSV」与「离线复现要读的 CSV」就出现了耦合：
 * 导出端写中文、导入端找英文，文件就再也导不回来了。
 * 把列定义集中在这里，导出取 zh 作表头、导入按 zh/en 双向匹配，
 * 于是既能让 Excel 直接看懂，也不会让之前已经导出、准备写进论文的旧文件失效。
 *
 * 每列三个字段：
 *   key —— 程序内部字段名（samples 对象上的属性）
 *   en  —— 旧版表头，保留用于兼容历史导出文件
 *   zh  —— 当前表头，带单位，给人看
 */

/** 会话指标时序（报告页「指标表格」导出、离线复现导入） */
export const SAMPLE_COLUMNS = [
  { key: 't', en: 't_ms', zh: '时间(毫秒)' },
  { key: 'score', en: 'score', zh: '疲劳指数' },
  { key: 'raw', en: 'raw_score', zh: '平滑前原始指数' },
  { key: 'level', en: 'level', zh: '疲劳等级' },
  { key: 'perclos', en: 'perclos', zh: '闭眼时间占比PERCLOS' },
  { key: 'perclosReady', en: 'perclos_ready', zh: '闭眼占比是否已就绪(1=是)' },
  { key: 'closure', en: 'closure', zh: '当前闭合程度(0-1)' },
  { key: 'maxClosureMs', en: 'max_closure_ms', zh: '窗口内最长闭眼(毫秒)' },
  { key: 'currentClosureMs', en: 'current_closure_ms', zh: '当前连续闭眼(毫秒)' },
  { key: 'blinkRate', en: 'blink_rate_per_min', zh: '眨眼频率(次每分)' },
  { key: 'avgBlinkMs', en: 'avg_blink_ms', zh: '平均眨眼时长(毫秒)' },
  { key: 'yawnRate', en: 'yawn_rate_per_min', zh: '哈欠频率(次每分)' },
  { key: 'nodRate', en: 'nod_rate_per_min', zh: '点头频率(次每分)' },
  { key: 'headDevRatio', en: 'head_dev_ratio', zh: '头部偏离前方占比' },
  { key: 'ear', en: 'ear', zh: '眼睛开合度EAR' },
  { key: 'mar', en: 'mar', zh: '嘴巴张开度MAR' },
  { key: 'pitch', en: 'pitch_deg', zh: '抬头低头角(度)' },
  { key: 'yaw', en: 'yaw_deg', zh: '左右转头角(度)' },
  { key: 'roll', en: 'roll_deg', zh: '头部倾斜角(度)' },
  { key: 'facePresent', en: 'face_present', zh: '是否检测到人脸(1=是)' },
  { key: 'dataValid', en: 'data_valid', zh: '数据是否有效(1=是)' },
];

/** 视频离线评测的逐点数据（多出人工标注与预测等级两列） */
export const EVAL_SAMPLE_COLUMNS = [
  { key: 'tSec', en: 't_sec', zh: '视频时间(秒)' },
  { key: 'truth', en: 'truth_label', zh: '人工标注' },
  { key: 'pred', en: 'pred_level', zh: '系统判定等级' },
  { key: 'score', en: 'score', zh: '疲劳指数' },
  { key: 'raw', en: 'raw_score', zh: '平滑前原始指数' },
  { key: 'perclos', en: 'perclos', zh: '闭眼时间占比PERCLOS' },
  { key: 'perclosReady', en: 'perclos_ready', zh: '闭眼占比是否已就绪(1=是)' },
  { key: 'maxClosureMs', en: 'max_closure_ms', zh: '窗口内最长闭眼(毫秒)' },
  { key: 'currentClosureMs', en: 'current_closure_ms', zh: '当前连续闭眼(毫秒)' },
  { key: 'blinkRate', en: 'blink_rate_per_min', zh: '眨眼频率(次每分)' },
  { key: 'avgBlinkMs', en: 'avg_blink_ms', zh: '平均眨眼时长(毫秒)' },
  { key: 'yawnRate', en: 'yawn_rate_per_min', zh: '哈欠频率(次每分)' },
  { key: 'nodRate', en: 'nod_rate_per_min', zh: '点头频率(次每分)' },
  { key: 'headDevRatio', en: 'head_dev_ratio', zh: '头部偏离前方占比' },
  { key: 'ear', en: 'ear', zh: '眼睛开合度EAR' },
  { key: 'mar', en: 'mar', zh: '嘴巴张开度MAR' },
  { key: 'pitch', en: 'pitch_deg', zh: '抬头低头角(度)' },
  { key: 'yaw', en: 'yaw_deg', zh: '左右转头角(度)' },
  { key: 'facePresent', en: 'face_present', zh: '是否检测到人脸(1=是)' },
  { key: 'dataValid', en: 'data_valid', zh: '数据是否有效(1=是)' },
];

/** 疲劳等级：内部键 ↔ 中文标签。CSV 里写中文，读回来时还原成键。 */
export const LEVEL_KEY_TO_ZH = {
  awake: '清醒',
  mild: '轻度疲劳',
  moderate: '中度疲劳',
  severe: '重度疲劳',
};

export const LEVEL_ZH_TO_KEY = Object.fromEntries(
  Object.entries(LEVEL_KEY_TO_ZH).map(([k, v]) => [v, k])
);

/** 人工标注标签：内部键 ↔ 中文标签 */
export const TRUTH_KEY_TO_ZH = {
  normal: '正常',
  fatigue: '疲劳',
  ignore: '忽略',
  unlabeled: '未标注',
};

/**
 * 在表头里定位某一列，中文名与旧英文名都认。
 * @param {string[]} header 已 trim 的表头数组
 * @param {object}   col    列定义 { zh, en }
 * @returns {number} 列下标，找不到返回 -1
 */
export function findColumn(header, col) {
  let i = header.indexOf(col.zh);
  if (i >= 0) return i;
  i = header.indexOf(col.en);
  return i;
}

/** 把等级单元格（中文或英文）还原成内部键 */
export function parseLevelCell(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'awake';
  if (LEVEL_ZH_TO_KEY[s]) return LEVEL_ZH_TO_KEY[s];
  if (LEVEL_KEY_TO_ZH[s]) return s;
  return 'awake';
}
