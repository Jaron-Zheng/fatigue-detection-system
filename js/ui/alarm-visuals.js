/**
 * alarm-visuals.js — 报警视觉通道（红闪遮罩 + 通知卡片）
 *
 * 声音与语音提示在 core/alarm.js 中实现，本文件只负责"报警发生时
 * 画面如何提醒用户"。两者通过 AlarmSystem.onVisualAlarm 回调桥接。
 *
 * 通知样式与全站 toast 统一：疲劳报警不使用独立横幅，而是复用
 * toast 通知家族（与"专业模式已开启"同款卡片），等级区分由
 * toast.js 的 toastAlarm 实现（图标章 + 左缘色条 + 停留时长，
 * 轻度黄 / 中度橙 / 重度红）。
 */

import { $, setAttr } from '../util/dom.js';
import { toastAlarm, toastOk } from './toast.js';
import { CONFIG } from '../config.js';

/* 报警通知文案，按 [标题, 说明] 结构拆分，与 config.js 的语音播报文本同义 */
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

  /* 红闪遮罩：按等级决定持续时长，等级越高闪越久 */
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

  /**
   * 报警通知卡片。走统一 toast 家族，等级驱动配色与停留时长。
   * - fusion 可选：传入时在说明句后追加 Top3 贡献归因（可解释性）。
   * - ev 可选：alarm.update 返回的事件对象——
   *   B1 计数：说明句前插"第 N 次"（同级多次提醒的频率感知）；
   *   B3 升级：escalating 为 true 时标题后缀"疲劳在加重"。
   */
  notify(level, fusion = null, ev = null) {
    const [title, msg] = COPY[level] || COPY.mild;
    let head = title;
    if (ev && ev.escalating) head = `${title}，疲劳在加重`;
    let detail = msg;
    if (ev && ev.count > 1) detail = `第 ${ev.count} 次提醒 · ${msg}`;
    if (fusion && Array.isArray(fusion.topFactors) && fusion.topFactors.length) {
      const parts = fusion.topFactors
        .slice(0, 3)
        .map((f) => `${f.label} ${f.points.toFixed(1)} 分`);
      detail = `${detail}。主要贡献：${parts.join('、')}`;
    }
    toastAlarm(level, head, detail);
  }

  /**
   * 恢复通知：报警段闭环收尾——"已恢复 + 本段持续多久"。
   * 走 ok 语义的常规 toast（绿色对勾章，非报警家族），
   * 与报警形成"发生→持续→恢复"的完整叙事。
   */
  notifyRecovery(ev) {
    toastOk('已恢复清醒', `本次疲劳段持续约 ${(ev.durationMs / 1000).toFixed(1)} 秒，检测继续进行`, 4200);
  }
}
