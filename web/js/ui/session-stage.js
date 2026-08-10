/**
 * session-stage.js — 视频舞台上的阶段遮罩（待机/启动/校准/暂停/错误）
 *
 * 第三轮角色二从 app.js 拆出：app.js 原先把每个阶段的标题、说明文案、
 * 操作按钮的 DOM 拼装混在生命周期方法里。本类只负责"当前处于哪个阶段，
 * 舞台遮罩就显示什么"，阶段推进由调用方驱动。
 */

import { $, setText } from '../util/dom.js';
import { CONFIG } from '../config.js';

export class SessionStage {
  constructor() {
    this.overlay = $('#stageOverlay');
    this.ring = $('#calibRing');
    this.bar = $('#calibBar');
    this.num = $('#calibNum');
    this.title = $('#overlayTitle');
    this.text = $('#overlayText');
    this.actions = $('#overlayActions');
  }

  _frame(title, text, { ring = false } = {}) {
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
    this._frame(
      '正在认识你的眼睛',
      '请正视摄像头，自然睁眼、放松表情。系统在记录你平时睁眼的样子，作为判断闭眼的个人标准。',
      { ring: true }
    );

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
        ? '请正视摄像头，自然睁眼、放松表情。系统在记录你平时睁眼的样子，作为判断闭眼的个人标准。'
        : '还没看到你的脸，倒计时已暂停。请让面部完整进入画面，光线不要太暗。'
    );
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
    this.overlay.hidden = true;
    this.ring.hidden = true;
  }
}
