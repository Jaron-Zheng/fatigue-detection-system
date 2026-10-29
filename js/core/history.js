/**
 * history.js — 会话历史（本地摘要）
 *
 * 只存每次会话的文字性摘要（结束时间、时长、最高等级、峰值/均分、覆盖率、
 * 等级时长构成、事件计数），存于 localStorage，最多保留 MAX_HISTORY 条。
 * 不含任何影像数据，也不含逐帧指标序列——完整数据由导出功能按需保存。
 * 存储不可用时静默降级为"无历史"，不影响主流程。
 */

const KEY = 'fatigue.history.v1';
export const MAX_HISTORY = 10;
export const HISTORY_KEY = KEY;

/**
 * 从 recorder.summary 提炼历史条目（显式挑字段，控制体积）。
 * @param summary recorder.summary() 的返回值
 * @returns 历史条目
 */
export function summaryToEntry(summary) {
  return {
    endedAt: summary.endedAt || new Date().toISOString(),
    durationMs: summary.durationMs || 0,
    worstLevel: summary.worstLevel || 'awake',
    worstLevelLabel: summary.worstLevelLabel || '清醒',
    finalLevelLabel: summary.finalLevelLabel || '清醒',
    avgScore: Math.round((summary.avgScore || 0) * 10) / 10,
    peakScore: Math.round((summary.peakScore || 0) * 10) / 10,
    coverage: Math.round((summary.coverage || 0) * 100) / 100,
    insufficient: !!summary.insufficient,
    measuredMs: summary.measuredMs || 0,
    unreliableMs: summary.unreliableMs || 0,
    levelDurations: summary.levelDurations || {},
    counts: summary.counts || {},
    simulated: !!(summary.engine && summary.engine.delegate === '模拟'),
  };
}

/** 读取全部历史（损坏时清空重建，返回数组） */
export function loadHistory(storage = globalThis.localStorage) {
  try {
    const raw = storage && storage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((e) => e && typeof e === 'object' && typeof e.endedAt === 'string');
  } catch {
    return [];
  }
}

/** 新会话摘要入列（最新的在最前），超出上限截断 */
export function pushHistory(entry, storage = globalThis.localStorage) {
  try {
    const list = loadHistory(storage);
    list.unshift(entry);
    const trimmed = list.slice(0, MAX_HISTORY);
    storage.setItem(KEY, JSON.stringify(trimmed));
    return trimmed;
  } catch {
    return loadHistory(storage);
  }
}

/** 清空全部历史 */
export function clearHistory(storage = globalThis.localStorage) {
  try {
    storage.removeItem(KEY);
  } catch {
    /* noop */
  }
}
