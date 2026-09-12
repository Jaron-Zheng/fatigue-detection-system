/**
 * session-state-machine.js — 会话状态机（纯逻辑，零 DOM 依赖）
 *
 * 把状态集合、合法迁移表、迁移前置条件（guard）与副作用钩子显式化：
 *   - 任何未登记在迁移表里的 (state, event) 组合一律被拒绝；
 *   - guard 失败同样拒绝迁移（如"未校准不得进入 RUNNING"）；
 *   - 迁移成功才触发 onChange 钩子，副作用由调用方在钩子里执行。
 */

export const SessionState = Object.freeze({
  IDLE: 'idle',
  BOOTING: 'booting',
  CALIBRATING: 'calibrating',
  RUNNING: 'running',
  PAUSED: 'paused',
  REPORT: 'report',
  ERROR: 'error',
});

export const SessionEvent = Object.freeze({
  START: 'start',
  BEGIN_CALIBRATION: 'beginCalibration',
  BEGIN_RUNNING: 'beginRunning',
  CALIBRATION_DONE: 'calibrationDone',
  PAUSE: 'pause',
  RESUME: 'resume',
  FINISH: 'finish',
  CANCEL: 'cancel',
  FAIL: 'fail',
  RECALIBRATE: 'recalibrate',
  SIM_ENTER: 'simEnter',
  SIM_EXIT: 'simExit',
});

/** 合法迁移表：state → { event → nextState } */
const TRANSITIONS = Object.freeze({
  [SessionState.IDLE]: {
    [SessionEvent.START]: SessionState.BOOTING,
  },
  [SessionState.BOOTING]: {
    [SessionEvent.BEGIN_CALIBRATION]: SessionState.CALIBRATING,
    [SessionEvent.BEGIN_RUNNING]: SessionState.RUNNING,
    [SessionEvent.CANCEL]: SessionState.IDLE,
    [SessionEvent.FAIL]: SessionState.ERROR,
  },
  [SessionState.CALIBRATING]: {
    [SessionEvent.CALIBRATION_DONE]: SessionState.RUNNING,
    [SessionEvent.BEGIN_RUNNING]: SessionState.RUNNING,
    [SessionEvent.CANCEL]: SessionState.IDLE,
    [SessionEvent.FAIL]: SessionState.ERROR,
    [SessionEvent.SIM_ENTER]: SessionState.RUNNING,
    [SessionEvent.SIM_EXIT]: SessionState.IDLE,
  },
  [SessionState.RUNNING]: {
    [SessionEvent.PAUSE]: SessionState.PAUSED,
    [SessionEvent.FINISH]: SessionState.REPORT,
    [SessionEvent.RECALIBRATE]: SessionState.CALIBRATING,
    [SessionEvent.SIM_ENTER]: SessionState.RUNNING,
    [SessionEvent.SIM_EXIT]: SessionState.IDLE,
    [SessionEvent.FAIL]: SessionState.ERROR,
  },
  [SessionState.PAUSED]: {
    [SessionEvent.RESUME]: SessionState.RUNNING,
    [SessionEvent.FINISH]: SessionState.REPORT,
    [SessionEvent.RECALIBRATE]: SessionState.CALIBRATING,
    [SessionEvent.SIM_ENTER]: SessionState.RUNNING,
    [SessionEvent.SIM_EXIT]: SessionState.IDLE,
    [SessionEvent.FAIL]: SessionState.ERROR,
  },
  [SessionState.REPORT]: {
    [SessionEvent.START]: SessionState.BOOTING,
  },
  [SessionState.ERROR]: {
    [SessionEvent.START]: SessionState.BOOTING,
  },
});

/** 默认 guard：进入 RUNNING 必须先有校准结果或演示模式 */
const DEFAULT_GUARDS = Object.freeze({
  [`${SessionState.CALIBRATING}->${SessionState.RUNNING}`]: (payload) =>
    Boolean(payload && (payload.calibration || payload.simulated)),
  [`${SessionState.BOOTING}->${SessionState.RUNNING}`]: (payload) =>
    Boolean(payload && (payload.calibration || payload.simulated)),
});

export class SessionStateMachine {
  /**
   * @param options.initial 初始状态，默认 IDLE
   * @param options.guards 追加或覆盖 guard，键格式 `${from}->${to}`
   */
  constructor({ initial = SessionState.IDLE, guards = {} } = {}) {
    if (!TRANSITIONS[initial]) throw new Error(`未知初始状态: ${initial}`);
    this._state = initial;
    this._guards = { ...DEFAULT_GUARDS, ...guards };
    this._listeners = [];
    this._history = [];
  }

  get state() {
    return this._state;
  }

  /** 迁移历史（最近 64 条），用于调试与测试取证 */
  get history() {
    return this._history.slice();
  }

  is(...states) {
    return states.includes(this._state);
  }

  /** 当前状态下某事件是否允许（存在迁移且 guard 通过） */
  can(event, payload) {
    const table = TRANSITIONS[this._state];
    if (!table || !(event in table)) return false;
    const guard = this._guards[`${this._state}->${table[event]}`];
    return guard ? guard(payload) : true;
  }

  /** 尝试一次状态迁移，返回是否成功 */
  send(event, payload) {
    const table = TRANSITIONS[this._state];
    const next = table ? table[event] : undefined;
    if (next === undefined) return false;
    const guard = this._guards[`${this._state}->${next}`];
    if (guard && !guard(payload)) return false;
    const prev = this._state;
    this._state = next;
    this._history.push({ from: prev, event, to: next });
    if (this._history.length > 64) this._history.shift();
    // 监听器隔离：一个钩子抛错不让后续被跳过
    let firstErr = null;
    for (const listener of this._listeners.slice()) {
      try {
        listener(prev, next, event, payload);
      } catch (err) {
        if (firstErr === null) firstErr = err;
        console.error('[SessionStateMachine] onChange 钩子异常：', err);
      }
    }
    if (firstErr !== null) throw firstErr;
    return true;
  }

  /** 订阅迁移副作用钩子，返回取消订阅函数 */
  onChange(listener) {
    this._listeners.push(listener);
    return () => {
      const i = this._listeners.indexOf(listener);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }

  /** 只读快照：完整合法迁移表 */
  static get transitions() {
    return TRANSITIONS;
  }
}
