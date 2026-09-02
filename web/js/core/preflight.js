/**
 * preflight.js — 启动自检（E3）
 *
 * 目的：把"用到时才报错"变成"启动时就告诉你"。之前 WASM 缺文件、
 * 存储被禁用这类问题都要等用户点了"开始检测"才暴露，错误堆栈对
 * 非工程用户毫无意义。这里在应用启动后立即做一轮环境检查，结果
 * 挂在设置抽屉的"启动自检"小节里，答辩演示前也可以一眼确认。
 *
 * 分级口径（与处理策略对应，不是随意打分）：
 *   ok    环境能力具备
 *   warn  缺失后系统仍可工作（有明确降级路径），如无 WebGL2 会回退
 *         CPU 推理、无 AudioContext 只影响声音不影响闪屏报警
 *   fail  缺失后核心功能（本地推理）无法启动，如模型/WASM 资源缺失
 *
 * 依赖全部通过 env 注入：Node 回归测试（regression-test.mjs 第 18 节）
 * 传 mock 即可跑完整逻辑，浏览器端传默认 env。
 */

/** 检查项的状态 → 中文标签（UI 与测试共用同一映射） */
export const STATUS_LABEL = { ok: '正常', warn: '降级', fail: '异常' };

/** 浏览器默认环境（Node 下部分字段为 undefined，对应检查按 warn 处理） */
function defaultEnv() {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  return {
    /** 资源可达性探测：默认用 fetch HEAD，被 404/网络错误拒绝即不可达 */
    probeUrl: (url) =>
      fetch(url, { method: 'HEAD' }).then((r) => (r.ok ? null : `HTTP ${r.status}`)),
    /** localStorage 写读删探针；返回 null 表示可用，否则返回错误描述 */
    testStorage: () => {
      try {
        if (typeof localStorage === 'undefined') return 'localStorage 不存在';
        const k = '__pf_probe__';
        localStorage.setItem(k, '1');
        localStorage.removeItem(k);
        return null;
      } catch {
        return '存储被浏览器策略禁用';
      }
    },
    hasGetUserMedia: !!(nav && nav.mediaDevices && nav.mediaDevices.getUserMedia),
    hasAudioContext:
      typeof window !== 'undefined' &&
      !!(window.AudioContext || /** @type {any} */ (window).webkitAudioContext),
    hasWebGL2: (() => {
      try {
        const c = document.createElement('canvas');
        return !!c.getContext('webgl2');
      } catch {
        return false;
      }
    })(),
    isCrossOriginIsolated: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false,
  };
}

/**
 * 运行启动自检。
 * @param {Partial<ReturnType<typeof defaultEnv>>} [env] 覆盖默认环境的探针（测试注入用）
 * @returns {Promise<{items:Array<{id:string,label:string,status:'ok'|'warn'|'fail',detail:string}>,summary:'pass'|'degraded'|'fail'}>}
 */
export async function runPreflight(env = {}) {
  const e = { ...defaultEnv(), ...env };
  const items = [];

  /* ---- 1. 本地推理资源（关键项）：三个文件缺一即无法初始化引擎 ---- */
  const ASSETS = [
    ['vendor/tasks-vision/vision_bundle.mjs', '视觉任务库'],
    ['vendor/tasks-vision/wasm/vision_wasm_internal.wasm', 'WASM 内核'],
    ['vendor/models/face_landmarker.task', '面部地标模型'],
  ];
  const missing = [];
  for (const [url, label] of ASSETS) {
    const err = await e.probeUrl(url).catch((ex) => String(ex || '网络错误'));
    if (err) missing.push(`${label}(${err})`);
  }
  items.push({
    id: 'assets',
    label: '本地模型与推理内核',
    status: missing.length ? 'fail' : 'ok',
    detail: missing.length ? `缺失：${missing.join('、')}` : '三个资源文件均可达',
  });

  /* ---- 2. 配置持久化（降级项）：存不了只是记不住参数 ---- */
  const storageErr = e.testStorage();
  items.push({
    id: 'storage',
    label: '本地配置存储',
    status: storageErr ? 'warn' : 'ok',
    detail: storageErr ? `${storageErr}，参数修改仅本次会话生效` : '可写可读',
  });

  /* ---- 3. 摄像头能力（降级项）：无摄像头仍可用演示模式验证全链路 ---- */
  items.push({
    id: 'camera',
    label: '摄像头访问能力',
    status: e.hasGetUserMedia ? 'ok' : 'warn',
    detail: e.hasGetUserMedia ? 'getUserMedia 可用（权限在开始检测时申请）' : '未检测到 getUserMedia，实时模式不可用，演示模式不受影响',
  });

  /* ---- 4. 声音报警（降级项）：无声时视觉报警仍然完整 ---- */
  items.push({
    id: 'audio',
    label: '声音报警',
    status: e.hasAudioContext ? 'ok' : 'warn',
    detail: e.hasAudioContext ? 'Web Audio 可用' : '无 AudioContext，报警仅闪屏无提示音',
  });

  /* ---- 5. GPU 推理（降级项）：WebGL2 缺失时引擎自动回退 CPU ---- */
  items.push({
    id: 'webgl2',
    label: 'GPU 加速（WebGL2）',
    status: e.hasWebGL2 ? 'ok' : 'warn',
    detail: e.hasWebGL2 ? '可用，推理走 GPU 委托' : '不可用，推理将回退 CPU 委托（帧率降低）',
  });

  /* ---- 6. 跨源隔离（降级项）：只影响多线程 WASM，单线程推理不受影响 ---- */
  items.push({
    id: 'isolation',
    label: '跨源隔离（多线程推理）',
    status: e.isCrossOriginIsolated ? 'ok' : 'warn',
    detail: e.isCrossOriginIsolated ? 'COOP/COEP 生效，可用多线程 WASM' : '未隔离，WASM 以单线程运行（帧率略低）',
  });

  const summary = items.some((i) => i.status === 'fail')
    ? 'fail'
    : items.some((i) => i.status === 'warn')
      ? 'degraded'
      : 'pass';
  return { items, summary };
}

/** 汇总级别的中文结论（设置抽屉标题行用） */
export function preflightSummaryLabel(summary) {
  return { pass: '全部通过', degraded: '可用，部分降级', fail: '存在异常，无法本地推理' }[summary] || summary;
}
