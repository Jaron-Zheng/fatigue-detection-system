# vendor 资源去重说明（第三轮角色十一）

本目录（`original/system/web/vendor/`）的大文件（MediaPipe WASM 运行时与
人脸关键点模型，合计约 25MB）已按第三轮交付改造**移除**，仅保留
`inventory.json` 清单。原因：

1. `web/vendor` 资源自始至终没有变化（MediaPipe Tasks-Vision v1.0.0 锁定版本），
   在 `original/system`、`final/system` 与工作区 `web/vendor` 三处重复打包
   纯属浪费——这是 git 存在意义的典型场景；
2. 完整副本保留在 `final/system/web/vendor/`（可直接运行的一份）；
3. git 仓库的 `v2.0.0-audited` 基线 tag 里保存着本副本删除前的完整历史，
   需要原样历史快照时 `git checkout v2.0.0-audited` 即可。

## 如需让本副本重新可运行

联网状态下在本目录（`original/system/`）执行：

```powershell
node tools/fetch-vendor.js
```

脚本会按锁定版本从 jsdelivr CDN 与 MediaPipe 官方存储重新下载全部 7 个文件
并重写 `inventory.json`（与工作区 `web/vendor` 内容一致）。
