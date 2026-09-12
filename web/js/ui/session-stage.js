/**
 * session-stage.js — 视频舞台上的阶段遮罩（待机/启动/校准/暂停/错误）
 *
 * 本类只负责"当前处于哪个阶段，舞台遮罩就显示什么"，
 * 阶段推进由调用方驱动。
 */

import { $, setText, svgIcon } from '../util/dom.js';
import { CONFIG } from '../config.js';

/* 校准动作指令文案：时长取自 CONFIG.calibration.durationSec */
function calibInstructionText() {
  return `请正视摄像头，保持自然睁眼（约 ${CONFIG.calibration.durationSec} 秒）。系统正在记录你平时睁眼的样子，作为判断闭眼的个人标准。`;
}

/* 校准完成反馈的停留时长（毫秒） */
const CALIB_DONE_MS = 800;

export class SessionStage {
  constructor() {
    this.overlay = $('#stageOverlay');
    this.ring = $('#calibRing');
    this.bar = $('#calibBar');
    this.num = $('#calibNum');
    this.title = $('#overlayTitle');
    this.text = $('#overlayText');
    this.actions = $('#overlayActions');
    this._calibFlashOn = false;
    this._calibFlashTimer = null;
  }

  /* 设置遮罩框架：标题、说明、遮罩类型 */
  _frame(title, text, { ring = false, translucent = false } = {}) {
    // 新阶段接管时撤销"校准完成"反馈的挂起状态
    this._cancelCalibFlash();
    this.overlay.hidden = false;
    // 启动/校准用半透明遮罩让用户看见摄像头画面，待机/暂停/错误用实色遮罩
    this.overlay.classList.toggle('is-translucent', translucent);
    this.ring.hidden = !ring;
    setText(this.title, title);
    setText(this.text, text);
    this.actions.innerHTML = '';
  }

  /* 创建一个按钮并附加到操作区 */
  _button({ className, text, id, title, onClick, icon }) {
    const btn = document.createElement('button');
    btn.className = className;
    btn.type = 'button';
    if (id) btn.id = id;
    if (title) btn.title = title;
    if (icon) {
      btn.appendChild(svgIcon(icon));
      btn.appendChild(document.createTextNode(text));
    } else {
      btn.textContent = text;
    }
    btn.addEventListener('click', onClick);
    this.actions.appendChild(btn);
    return btn;
  }

  /* 待机舞台 */
  showIdle(onStart) {
    this._frame(
      '准备好开始了吗？',
      '开启摄像头后，系统会先了解你的自然睁眼状态，再开始持续监测。'
    );
    this._button({ className: 'btn btn-secondary', text: '开始检测', icon: 'i-play', onClick: onStart });
  }

  /* 启动中舞台 */
  showBoot() {
    this._frame(
      '正在准备视觉引擎',
      '模型和摄像头均在本机启动，不会上传任何影像数据。',
      { translucent: true }
    );
  }

  /* 校准中舞台 */
  showCalibrating(onSkip) {
    this._frame('正在认识你的眼睛', calibInstructionText(), { ring: true, translucent: true });

    /* "直接开始"入口：收在校准遮罩内做次要链接，
     * 用于论文对照实验（有个人基准 vs 用通用固定阈值） */
    this._button({
      className: 'btn btn-secondary btn-sm',
      id: 'btnSkipCalib',
      text: '跳过，直接开始',
      icon: 'i-play',
      title: '使用通用固定阈值。个体眼型差异可能带来误判，仅在做对照实验时使用',
      onClick: onSkip,
    });
  }

  /**
   * 校准进度刷新。倒计时按有效时长走，人脸不在画面时会停住，
   * 文案必须说清楚"为什么不动"。
   */
  updateCalibProgress(progress, faceOk) {
    const CIRC = 2 * Math.PI * 52;
    this.bar.style.strokeDashoffset = String(CIRC * (1 - progress));
    const remain = Math.ceil(CONFIG.calibration.durationSec * (1 - progress));
    setText(this.num, String(Math.max(0, remain)));
    setText(
      this.text,
      faceOk
        ? calibInstructionText()
        : '还没看到你的脸，倒计时已暂停。请让面部完整进入画面，光线不要太暗。'
    );
  }

  /**
   * 校准完成反馈：短暂显示「校准完成，开始监测」，800ms 后自动收起。
   * 期间若有新阶段接管遮罩则立即让位。
   */
  showCalibrated() {
    this._frame('校准完成', '开始监测', { translucent: true });
    this._calibFlashOn = true;
    clearTimeout(this._calibFlashTimer);
    this._calibFlashTimer = setTimeout(() => {
      this._calibFlashOn = false;
      this._calibFlashTimer = null;
      this.overlay.hidden = true;
      this.ring.hidden = true;
    }, CALIB_DONE_MS);
  }

  /* 撤销校准完成反馈的挂起状态 */
  _cancelCalibFlash() {
    this._calibFlashOn = false;
    if (this._calibFlashTimer) {
      clearTimeout(this._calibFlashTimer);
      this._calibFlashTimer = null;
    }
  }

  /* 暂停舞台 */
  showPaused() {
    this._frame(
      '检测已暂停',
      '按空格键或点「继续」恢复检测。暂停期间不计入统计。'
    );
  }

  /* 错误舞台 */
  showError(message, { onRetry, onSimulate }) {
    this._frame('无法开始检测', message);
    this._button({ className: 'btn btn-secondary', text: '重试', icon: 'i-rotate-ccw', onClick: onRetry });
    this._button({ className: 'btn btn-secondary', text: '改用演示模式', icon: 'i-eye', onClick: onSimulate });
  }

  /* 隐藏遮罩（校准完成反馈期内不接受外部 hide） */
  hide() {
    if (this._calibFlashOn) return;
    this.overlay.hidden = true;
    this.ring.hidden = true;
  }
}
