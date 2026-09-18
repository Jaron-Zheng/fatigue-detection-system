/**
 * compat.js — 浏览器兼容性硬门槛
 *
 * 在 app.js 之前执行。仅在浏览器不支持 WebAssembly 时整页替换为友好提示。
 * getUserMedia 与 WebGL2 的缺失不做硬阻断，由 preflight.js 给出降级提示。
 */
(function () {
  if (!window.WebAssembly) {
    document.body.innerHTML = '<div style="font:400 14px/1.5 Inter,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f4f4f4;color:#171a20;text-align:center;padding:20px"><div><h1 style="font-size:24px;font-weight:500;margin:0 0 12px">浏览器兼容性不足</h1><p>当前浏览器不支持 WebAssembly，无法运行本系统。<br>请使用最新版 <a href="https://www.google.com/chrome/" style="color:#3e6ae1">Chrome</a> 或 <a href="https://www.microsoft.com/edge" style="color:#3e6ae1">Edge</a> 浏览器。</p></div></div>';
  }
})();
