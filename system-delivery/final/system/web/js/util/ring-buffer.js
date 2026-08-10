/**
 * ring-buffer.js — 时间窗口环形缓冲
 *
 * PERCLOS、眨眼频率等指标都需要「最近 N 秒」的滑动统计。
 * 直接用数组 shift() 在高帧率下会造成 O(n) 拷贝与 GC 压力，
 * 因此使用定长 Float64Array 环形缓冲：入队 O(1)，遍历零分配。
 */

export class TimeWindow {
  /**
   * @param {number} windowMs 窗口时长（毫秒）
   * @param {number} maxHz    预估最大写入频率，用于分配容量
   */
  constructor(windowMs, maxHz = 60) {
    this.windowMs = windowMs;
    this.capacity = Math.max(64, Math.ceil((windowMs / 1000) * maxHz) + 32);
    this.ts = new Float64Array(this.capacity);
    this.val = new Float64Array(this.capacity);
    this.head = 0; // 下一个写入位置
    this.size = 0;
  }

  setWindow(windowMs, maxHz = 60) {
    if (windowMs === this.windowMs) return;
    const needed = Math.max(64, Math.ceil((windowMs / 1000) * maxHz) + 32);
    this.windowMs = windowMs;
    if (needed > this.capacity) {
      const ts = new Float64Array(needed);
      const val = new Float64Array(needed);
      let i = 0;
      this.forEach((t, v) => {
        ts[i] = t;
        val[i] = v;
        i++;
      });
      this.ts = ts;
      this.val = val;
      this.capacity = needed;
      this.head = i % needed;
      this.size = i;
    }
    // 窗口缩短时立即驱逐超出新范围的旧数据，
    // 否则调用 mean()/ratio() 时会包含过期样本
    if (this.size > 0) {
      const latestIdx = (this.head - 1 + this.capacity) % this.capacity;
      this._evict(this.ts[latestIdx]);
    }
  }

  push(ts, val) {
    this.ts[this.head] = ts;
    this.val[this.head] = val;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
    this._evict(ts);
  }

  /** 丢弃超出时间窗的旧样本（逻辑上通过收缩 size 实现） */
  _evict(now) {
    const cutoff = now - this.windowMs;
    while (this.size > 0) {
      const oldestIdx = (this.head - this.size + this.capacity) % this.capacity;
      if (this.ts[oldestIdx] < cutoff) this.size--;
      else break;
    }
  }

  /** 按时间升序遍历，回调 (ts, val, index) */
  forEach(fn) {
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head - this.size + i + this.capacity) % this.capacity;
      fn(this.ts[idx], this.val[idx], i);
    }
  }

  /** 窗口内数值的算术平均 */
  mean() {
    if (!this.size) return NaN;
    let s = 0;
    this.forEach((_, v) => (s += v));
    return s / this.size;
  }

  /** 满足条件的样本占比（PERCLOS 的核心运算） */
  ratio(predicate) {
    if (!this.size) return NaN;
    let c = 0;
    this.forEach((t, v) => {
      if (predicate(v, t)) c++;
    });
    return c / this.size;
  }

  /** 时间跨度（毫秒） */
  span() {
    if (this.size < 2) return 0;
    const first = (this.head - this.size + this.capacity) % this.capacity;
    const last = (this.head - 1 + this.capacity) % this.capacity;
    return this.ts[last] - this.ts[first];
  }

  /** 导出为普通数组（仅用于绘图，调用频率低） */
  toArray() {
    const out = new Array(this.size);
    this.forEach((t, v, i) => (out[i] = { t, v }));
    return out;
  }

  latest() {
    if (!this.size) return null;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return { t: this.ts[idx], v: this.val[idx] };
  }

  clear() {
    this.head = 0;
    this.size = 0;
  }
}

/**
 * 事件计数窗口：只存时间戳，用于「最近 N 秒发生了几次」这类频率统计。
 */
export class EventWindow {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.items = [];
  }
  setWindow(ms) {
    this.windowMs = ms;
  }
  push(ts, payload = null) {
    this.items.push({ ts, payload });
    this._evict(ts);
  }
  _evict(now) {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.items.length && this.items[i].ts < cutoff) i++;
    if (i > 0) this.items.splice(0, i);
  }
  count(now = performance.now()) {
    this._evict(now);
    return this.items.length;
  }
  /** 换算为「每分钟次数」，并按实际观测时长做归一（开局不足一分钟时避免低估） */
  ratePerMinute(now, observedMs) {
    const n = this.count(now);
    const effective = Math.min(this.windowMs, Math.max(1, observedMs));
    return (n * 60000) / effective;
  }
  meanPayload(now = performance.now()) {
    this._evict(now);
    const nums = this.items.map((i) => i.payload).filter((v) => Number.isFinite(v));
    if (!nums.length) return NaN;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  }
  clear() {
    this.items.length = 0;
  }
}

/**
 * TimeWeightedWindow — 按真实时间加权的状态占比窗口
 *
 * 【为什么需要它：PERCLOS 的定义是"时间占比"，不是"帧占比"】
 *
 * 早期实现用「命中帧数 ÷ 总帧数」近似 PERCLOS，这隐含假设每帧间隔相同。
 * 实际运行中帧间隔会波动（推理耗时抖动、GPU 调度、页面负载），
 * 例如一段序列里睁眼帧平均间隔 40ms、闭眼帧平均间隔 80ms 时，
 * 按帧计数会把闭眼的真实时间占比低估近一半。
 *
 * 本类改为把每个采样视为「到下一次观测之间的时间区间」并按时长累加：
 *
 *              Σ 处于目标状态的区间时长
 *   ratio  =  ─────────────────────────
 *                Σ 全部有效区间时长
 *
 * 【间断处理】
 * 人脸丢失、数据质量不合格、页面暂停都会造成观测间断。
 * 间断期间的状态是未知的，绝不能假设"上一个状态一直持续"——
 * 否则驾驶员闭眼时人脸丢失 5 秒，会凭空产生 5 秒的闭眼时间。
 * 因此调用 interrupt() 会丢弃未闭合的区间；
 * 采样间隔超过 maxGapMs 时同样视为间断。
 */
export class TimeWeightedWindow {
  /**
   * @param {number} windowMs 统计窗口时长
   * @param {number} maxGapMs 允许的最大采样间隔，超过则视为观测间断
   */
  constructor(windowMs, maxGapMs = 400) {
    this.windowMs = windowMs;
    this.maxGapMs = maxGapMs;
    /** @type {{start:number,end:number,state:boolean}[]} */
    this.intervals = [];
    this.lastTs = null;
    this.lastState = false;
    this.validSampleCount = 0;
    this.validSampleTimes = [];
  }

  setWindow(windowMs) {
    this.windowMs = windowMs;
  }

  /**
   * 送入一个有效采样。
   * @param {number} ts    时间戳（毫秒，单调递增）
   * @param {boolean} state 该时刻是否处于目标状态（如"闭眼"）
   */
  push(ts, state) {
    if (this.lastTs !== null) {
      const gap = ts - this.lastTs;
      if (gap > this.maxGapMs) {
        // 间隔过大：中间发生了什么无从得知，丢弃这段而不是硬连起来
        this.lastTs = null;
      } else if (gap > 0) {
        this.intervals.push({ start: this.lastTs, end: ts, state: this.lastState });
      }
    }
    this.lastTs = ts;
    this.lastState = state;
    this.validSampleTimes.push(ts);
    this._trim(ts);
  }

  /** 观测中断（人脸丢失 / 数据无效 / 暂停）：结束当前未闭合区间 */
  interrupt() {
    this.lastTs = null;
  }

  _trim(now) {
    const cutoff = now - this.windowMs;
    // 完全落在窗口外的区间可以丢弃；跨边界的区间保留，取交集部分参与计算
    let i = 0;
    while (i < this.intervals.length && this.intervals[i].end <= cutoff) i++;
    if (i > 0) this.intervals.splice(0, i);
    let j = 0;
    while (j < this.validSampleTimes.length && this.validSampleTimes[j] < cutoff) j++;
    if (j > 0) this.validSampleTimes.splice(0, j);
  }

  /** 目标状态的时间占比；无有效观测时返回 0 */
  ratio(now = this.lastTs) {
    const cutoff = (now ?? 0) - this.windowMs;
    let total = 0;
    let hit = 0;
    for (const iv of this.intervals) {
      const start = Math.max(iv.start, cutoff);
      const d = Math.max(0, iv.end - start);
      total += d;
      if (iv.state) hit += d;
    }
    return total > 0 ? hit / total : 0;
  }

  /** 窗口内累计的有效观测时长（毫秒） */
  observedMs(now = this.lastTs) {
    const cutoff = (now ?? 0) - this.windowMs;
    let total = 0;
    for (const iv of this.intervals) {
      total += Math.max(0, iv.end - Math.max(iv.start, cutoff));
    }
    return total;
  }

  get sampleCount() {
    return this.validSampleTimes.length;
  }

  clear() {
    this.intervals.length = 0;
    this.validSampleTimes.length = 0;
    this.lastTs = null;
    this.lastState = false;
  }
}
