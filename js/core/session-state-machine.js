/**
 * session-state-machine.js — 会话状态机（纯逻辑，零 DOM 依赖）
 *
 * 第二轮之前，状态流转判断分散在 app.js 的 `_beginCalibration`、
 * `_finishCalibration`、`_beginRunning`、`stop`、`_cancelStart` 等十几个方法里，
 * 没有集中的合法迁移定义，只能靠代码审查确认"某个状态下能不能做某件事"。
 * 本模块把状态集合、合法迁移表、迁移前置条件（guard）与副作用钩子显式化：
 *
 *   - 任何未登记在迁移表里的 (state, event) 组合一律被拒绝；
 *   - guard 失败同样拒绝迁移（如"未校准不得进入 RUNNING"）；
 *   - 迁移成功才触发 onChange 钩子，副作用由调用方在钩子里执行。
 *
 * 不依赖 DOM，因此可以被 tools/regression-test.mjs 直接单元测试。
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
  START: 'start',                       // 开始检测（含报告页/错误页的重新开始）
  BEGIN_CALIBRATION: 'beginCalibration',// 引擎就绪，进入个人校准
  BEGIN_RUNNING: 'beginRunning',        // 跳过校准直接进入运行（演示模式/通用阈值）
  CALIBRATION_DONE: 'calibrationDone',  // 校准完成进入运行
  PAUSE: 'pause',
  RESUME: 'resume',
  FINISH: 'finish',                     // 正常结束 → 报告页
  CANCEL: 'cancel',                     // 启动/校准期间取消
  FAIL: 'fail',                         // 启动失败（摄像头/模型异常）
  RECALIBRATE: 'recalibrate',           // 运行中重新校准
  SIM_ENTER: 'simEnter',                // 会话中途切入演示模式
  SIM_EXIT: 'simExit',                  // 会话中途退出演示模式
});

/**
 * 合法迁移表：state → { event → nextState }。
 * 与第二轮 app.js 的实际行为逐条对齐（见第三轮重构说明），
 * 表外的一律视为非法迁移，send() 返回 false 且不改变状态。
 */
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
    [SessionEvent.BEGIN_RUNNING]: SessionState.RUNNING, // 跳过校准
    [SessionEvent.CANCEL]: SessionState.IDLE,
    [SessionEvent.FAIL]: SessionState.ERROR,
    [SessionEvent.SIM_ENTER]: SessionState.RUNNING,
    [SessionEvent.SIM_EXIT]: SessionState.IDLE,
  },
  [SessionState.RUNNING]: {
    [SessionEvent.PAUSE]: SessionState.PAUSED,
    [SessionEvent.FINISH]: SessionState.REPORT,
    [SessionEvent.RECALIBRATE]: SessionState.CALIBRATING,
    [SessionEvent.SIM_ENTER]: SessionState.RUNNING, // 自迁移：换数据源后重启会话
    [SessionEvent.SIM_EXIT]: SessionState.IDLE,
    [SessionEvent.FAIL]: SessionState.ERROR,
  },
  [SessionState.PAUSED]: {
    [SessionEvent.RESUME]: SessionState.RUNNING,
    [SessionEvent.FINISH]: SessionState.REPORT,
    [SessionEvent.RECALIBRATE]: SessionState.CALIBRATING,
    [SessionEvent.SIM_ENTER]: SessionState.RUNNING,
    [SessionEvent.SIM_EXIT]: SessionState.IDLE,
    [SessionEvent.FAIL]: SessionState.ERROR, // 暂停期间摄像头被拔出/权限被撤销
  },
  [SessionState.REPORT]: {
    [SessionEvent.START]: SessionState.BOOTING,
  },
  [SessionState.ERROR]: {
    [SessionEvent.START]: SessionState.BOOTING,
  },
});

/**
 * 默认 guard："进入 RUNNING 必须先有校准结果"。
 * 覆盖两条路径——校准完成（calibration）与跳过校准/演示模式（simulated）。
 * 两个都没有就拒绝迁移，避免"未校准直接 RUNNING"这类历史隐患。
 */
const DEFAULT_GUARDS = Object.freeze({
  [`${SessionState.CALIBRATING}->${SessionState.RUNNING}`]: (payload) =>
    Boolean(payload && (payload.calibration || payload.simulated)),
  [`${SessionState.BOOTING}->${SessionState.RUNNING}`]: (payload) =>
    Boolean(payload && (payload.calibration || payload.simulated)),
});

export class SessionStateMachine {
  /**
   * @param {object} [options]
   * @param {string} [options.initial] 初始状态，默认 IDLE
   * @param {Record<string, (payload:any)=>boolean>} [options.guards]
   *        追加或覆盖 guard，键格式 `${from}->${to}`
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

  /**
   * 尝试一次状态迁移。
   * @returns {boolean} 是否迁移成功；非法迁移或 guard 拒绝时返回 false 且状态不变
   */
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
    // 监听器隔离：一个钩子抛错不能让后续钩子被跳过（状态已变更，跳过会让 UI 与状态机脱节）。
    // 错误不吞掉：全部执行完后把第一个错误重新抛给调用方。
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

  /** 只读快照：完整合法迁移表（供文档与测试引用） */
  static get transitions() {
    return TRANSITIONS;
  }
}
