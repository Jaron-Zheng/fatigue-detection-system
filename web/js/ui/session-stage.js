/**
 * session-stage.js — 视频舞台上的阶段遮罩（待机/启动/校准/暂停/错误）
 *
 * 第三轮角色二从 app.js 拆出：app.js 原先把每个阶段的标题、说明文案、
 * 操作按钮的 DOM 拼装混在生命周期方法里。本类只负责"当前处于哪个阶段，
 * 舞台遮罩就显示什么"，阶段推进由调用方驱动。
 */

import { $, setText } from '../util/dom.js';
import { CONFIG } from '../config.js';

/** 校准动作指令文案：时长取自 CONFIG.calibration.durationSec，
 *  用户在设置面板改「标定时长」后文案随之更新，不写死数字。 */
function calibInstructionText() {
  return `请正视摄像头，保持自然睁眼（约 ${CONFIG.calibration.durationSec} 秒）。系统正在记录你平时睁眼的样子，作为判断闭眼的个人标准。`;
}

/** 校准完成反馈的停留时长（毫秒） */
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

  _frame(title, text, { ring = false } = {}) {
    // 任何新阶段接管遮罩时，撤销"校准完成"反馈的挂起状态与定时器
    this._cancelCalibFlash();
    this.overlay.hidden = false;
    this.ring.hidden = !ring;
    setText(this.title, title);
    setText(this.text, text);
    this.actions.innerHTML = '';
  }

  _button({ className, text, id, title, onClick }) {
    const btn = document.createElement('button');
    btn.className = className;
    btn.type = 'button';
    if (id) btn.id = id;
    if (title) btn.title = title;
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    this.actions.appendChild(btn);
    return btn;
  }

  showIdle(onStart) {
    this._frame(
      '准备好开始了吗？',
      '开启摄像头后，系统会先了解你的自然睁眼状态，再开始持续监测。'
    );
    this._button({ className: 'btn btn-primary', text: '开始检测', onClick: onStart });
  }

  showBoot() {
    this._frame(
      '正在准备视觉引擎',
      '模型和摄像头均在本机启动，不会上传任何影像数据。'
    );
  }

  showCalibrating(onSkip) {
    this._frame('正在认识你的眼睛', calibInstructionText(), { ring: true });

    /* 「直接开始」入口：
     * 首屏不再摆这个按钮（普通用户没有理由主动跳过校准），
     * 但功能必须保留——「有个人基准 vs 用通用固定阈值」是论文里的对照实验，
     * 少了它就没法量化个性化标定带来的提升。所以收在校准遮罩内做次要链接。 */
    this._button({
      className: 'btn btn-ghost btn-sm',
      id: 'btnSkipCalib',
      text: '跳过，直接开始',
      title: '使用通用固定阈值。个体眼型差异可能带来误判，仅在做对照实验时使用',
      onClick: onSkip,
    });
  }

  /**
   * 校准进度刷新。倒计时按有效时长走，人脸不在画面时会停住，
   * 所以文案必须说清楚"为什么不动"，否则用户只会觉得卡住了。
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
   * 校准完成反馈：在遮罩上短暂显示「校准完成，开始监测」，800ms 后自动收起。
   * app 侧校准完成后会立刻调用 hide() 进入监测——反馈期内 hide 被挂起，
   * 收起由这里的定时器负责；期间若有新阶段（如暂停）接管遮罩则立即让位。
   */
  showCalibrated() {
    this._frame('校准完成', '开始监测');
    this._calibFlashOn = true;
    clearTimeout(this._calibFlashTimer);
    this._calibFlashTimer = setTimeout(() => {
      this._calibFlashOn = false;
      this._calibFlashTimer = null;
      this.overlay.hidden = true;
      this.ring.hidden = true;
    }, CALIB_DONE_MS);
  }

  /** 撤销校准完成反馈的挂起状态（新阶段接管时调用） */
  _cancelCalibFlash() {
    this._calibFlashOn = false;
    if (this._calibFlashTimer) {
      clearTimeout(this._calibFlashTimer);
      this._calibFlashTimer = null;
    }
  }

  showPaused() {
    this._frame(
      '检测已暂停',
      '按空格键或点击「继续」按钮恢复检测。暂停期间不计入统计。'
    );
  }

  showError(message, { onRetry, onSimulate }) {
    this._frame('无法开始检测', message);
    this._button({ className: 'btn btn-primary', text: '重试', onClick: onRetry });
    this._button({ className: 'btn btn-secondary', text: '改用演示模式', onClick: onSimulate });
  }

  hide() {
    // "校准完成"反馈期内不接受外部 hide（app 完成校准后立即 hide 舞台进入监测），
    // 遮罩由 showCalibrated 的定时器在 800ms 后真正收起
    if (this._calibFlashOn) return;
    this.overlay.hidden = true;
    this.ring.hidden = true;
  }
}
