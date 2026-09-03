/**
 * compat.js — 浏览器兼容性硬门槛（在 app.js 之前执行的经典脚本）
 *
 * 仅在浏览器完全无法运行本系统时（无 WebAssembly，即"浏览器太老"）
 * 才整页替换为友好提示。
 *
 * 摄像头 API（getUserMedia）与 WebGL2 的缺失**不做硬阻断**：
 *   · 无 getUserMedia：实时模式不可用，演示模式不受影响（preflight 已有该降级提示）；
 *   · 无 WebGL2：推理自动回退 CPU 委托（preflight 已有该降级提示）。
 * 上述场景由 core/preflight.js 在启动检测时给出"人话"提示与演示模式出路。
 *
 * 历史说明：本检测原先内联在 index.html 且对三项都硬阻断——本地 CSP
 * 拦截内联脚本使其从未生效；抽为外部脚本首次真正执行后，发现硬阻断
 * 会误杀无 getUserMedia 的环境（如无头 WebKit）中的演示模式。
 */
(function () {
  if (!window.WebAssembly) {
    document.body.innerHTML = '<div style="font:400 17px/1.5 -apple-system,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f5f5f7;color:#1d1d1f;text-align:center;padding:20px"><div><h1 style="font-size:28px;font-weight:600;margin:0 0 12px">浏览器兼容性不足</h1><p>当前浏览器不支持 WebAssembly，无法运行本系统。<br>请使用最新版 <a href="https://www.google.com/chrome/" style="color:#0066cc">Chrome</a> 或 <a href="https://www.microsoft.com/edge" style="color:#0066cc">Edge</a> 浏览器。</p></div></div>';
  }
})();
