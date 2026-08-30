/**
 * alarm-visuals.js — 报警的视觉通道（红闪幕布 + 报警通知）
 *
 * 第三轮角色二从 app.js 拆出。声音与语音在 core/alarm.js，
 * 这里只承担"报警发生时画面怎么提醒"，两者由 AlarmSystem.onVisualAlarm 桥接。
 *
 * 通知样式统一：疲劳报警不再使用独立的暗色横幅，改走全站唯一的
 * toast 通知家族（与"专业模式已开启"同款卡片），等级区分见 toast.js
 * 的 toastAlarm（图标章 + 左缘色条 + 停留时长，轻黄/中橙/重红）。
 */

import { $, setAttr } from '../util/dom.js';
import { toastAlarm } from './toast.js';
import { CONFIG } from '../config.js';

/* 报警通知文案（展示层术语）：与 config.js 的语音播报文本同义，
 * 按通知卡的「标题 + 说明」结构拆分。 */
const COPY = {
  mild: ['检测到轻度疲劳', '建议开窗通风，保持清醒'],
  moderate: ['检测到中度疲劳', '请尽快寻找服务区休息'],
  severe: ['检测到重度疲劳', '请立即停车休息'],
};

export class AlarmVisuals {
  constructor() {
    this.veil = $('#alarmVeil');
    this.veilTimer = null;
  }

  flash(level) {
    if (!CONFIG.alarm.flashEnabled) return;
    setAttr(this.veil, 'data-level', level);
    this.veil.classList.add('on');
    clearTimeout(this.veilTimer);
    const dur = level === 'severe' ? 3400 : level === 'moderate' ? 2200 : 1400;
    this.veilTimer = setTimeout(() => this.hideVeil(), dur);
  }

  hideVeil() {
    this.veil.classList.remove('on');
  }

  /** 报警通知：走统一 toast 家族，等级驱动配色与停留时长。
   * fusion 可选：传入时在说明句后追加 Top3 贡献归因（可解释性）。 */
  notify(level, fusion = null) {
    const [title, msg] = COPY[level] || COPY.mild;
    let detail = msg;
    if (fusion && Array.isArray(fusion.topFactors) && fusion.topFactors.length) {
      const parts = fusion.topFactors
        .slice(0, 3)
        .map((f) => `${f.label} ${f.points.toFixed(1)} 分`);
      detail = `${msg}。主要贡献：${parts.join('、')}`;
    }
    toastAlarm(level, title, detail);
  }
}
