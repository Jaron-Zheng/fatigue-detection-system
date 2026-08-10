/**
 * alarm-visuals.js — 报警的视觉通道（红闪幕布 + 顶部横幅）
 *
 * 第三轮角色二从 app.js 拆出。声音与语音在 core/alarm.js，
 * 这里只承担"报警发生时画面怎么提醒"，两者由 AlarmSystem.onVisualAlarm 桥接。
 */

import { $, setText, setAttr } from '../util/dom.js';
import { CONFIG } from '../config.js';

export class AlarmVisuals {
  constructor() {
    this.veil = $('#alarmVeil');
    this.banner = $('#alarmBanner');
    this.veilTimer = null;
    this.bannerTimer = null;
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

  showBanner(level, text) {
    setAttr(this.banner, 'data-level', level);
    setText($('#alarmText'), text);
    this.banner.classList.add('show');
    this.banner.setAttribute('aria-hidden', 'false');
    // 横幅占据顶部时把 Toast 下移，避免两者叠在一起
    document.body.classList.add('has-alarm');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => this.hideBanner(), level === 'severe' ? 8000 : 5000);
  }

  hideBanner() {
    this.banner.classList.remove('show');
    this.banner.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('has-alarm');
  }
}
