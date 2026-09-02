; ==============================================================================
; 驾驶员疲劳检测系统 — Inno Setup 安装脚本（完整版，含 Node.js 运行时）
; ==============================================================================
; 用法：先构建 SEA launcher（node tools/build-sea.cjs），再用 ISCC 编译：
;   "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" packager\fatigue-detection.iss
;
; 生成的安装包输出到项目根目录：疲劳检测系统_Setup_v1.0.0.exe
;
; 特点：安装包内嵌 Node.js 22 portable + SEA launcher，
;       用户安装后无需单独安装 Node.js 即可直接运行。
; ==============================================================================

#define MyAppName "驾驶员疲劳检测系统"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "本科毕业设计"
#define MyAppURL "https://github.com/fatigue-detection"
#define MyAppExeName "launcher.exe"

; 项目根目录（.iss 文件位于 packager/ 下，所以 ../ 就是项目根）
#define ProjectRoot ".."
; 打包临时产物目录（SEA launcher 等）
#define PackDir "..\_pack"

[Setup]
; 基本信息
AppId={{B7F3E2A1-4D5C-6E7F-8A9B-0C1D2E3F4A5B}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} v{#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
LicenseFile={#ProjectRoot}\docs\安装许可协议.txt
OutputDir={#ProjectRoot}
OutputBaseFilename=疲劳检测系统_Setup_v{#MyAppVersion}
SetupIconFile={#ProjectRoot}\app-icon.ico
UninstallDisplayIcon={app}\app-icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x86compatible
ArchitecturesInstallIn64BitMode=x86compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ShowLanguageDialog=no
LanguageDetectionMethod=none

; 使用中文语言（Inno Setup 自带 ChineseSimplified.isl）
[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; ---------- SEA Launcher（内嵌 Node.js 的独立启动器）----------
Source: "{#PackDir}\launcher.exe"; DestDir: "{app}"; Flags: ignoreversion

; ---------- Node.js 22 Portable（launcher.exe 运行时需要）----------
; 只打包 node.exe（launcher.exe 通过 spawn 调用它运行 server.js）
Source: "{#PackDir}\node\node.exe"; DestDir: "{app}\node"; Flags: ignoreversion

; ---------- 保留 .bat 启动方式（兼容已有 Node.js 的用户）----------
Source: "{#ProjectRoot}\一键启动.bat"; DestDir: "{app}"; Flags: ignoreversion

; ---------- 图标 ----------
Source: "{#ProjectRoot}\app-icon.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectRoot}\app-icon.png"; DestDir: "{app}"; Flags: ignoreversion

; ---------- 服务器 ----------
Source: "{#ProjectRoot}\server\server.js"; DestDir: "{app}\server"; Flags: ignoreversion

; ---------- Web 前端（含 vendor 模型与 WASM）----------
Source: "{#ProjectRoot}\web\index.html"; DestDir: "{app}\web"; Flags: ignoreversion
Source: "{#ProjectRoot}\web\favicon.svg"; DestDir: "{app}\web"; Flags: ignoreversion
Source: "{#ProjectRoot}\web\manifest.json"; DestDir: "{app}\web"; Flags: ignoreversion
Source: "{#ProjectRoot}\web\sw.js"; DestDir: "{app}\web"; Flags: ignoreversion

; CSS
Source: "{#ProjectRoot}\web\css\*"; DestDir: "{app}\web\css"; Flags: ignoreversion recursesubdirs createallsubdirs

; JS（递归包含 core/ ui/ util/ 子目录）
Source: "{#ProjectRoot}\web\js\*"; DestDir: "{app}\web\js"; Flags: ignoreversion recursesubdirs createallsubdirs

; Vendor（模型 + WASM，约 37MB）
Source: "{#ProjectRoot}\web\vendor\*"; DestDir: "{app}\web\vendor"; Flags: ignoreversion recursesubdirs createallsubdirs

; ---------- 工具脚本（仅打包运行时必需的）----------
Source: "{#ProjectRoot}\tools\fetch-vendor.js"; DestDir: "{app}\tools"; Flags: ignoreversion

; ---------- package.json（用于版本信息）----------
Source: "{#ProjectRoot}\package.json"; DestDir: "{app}"; Flags: ignoreversion

; ---------- 文档（可选）----------
Source: "{#ProjectRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ProjectRoot}\docs\安装许可协议.txt"; DestDir: "{app}\docs"; Flags: ignoreversion
Source: "{#ProjectRoot}\docs\技术文档.md"; DestDir: "{app}\docs"; Flags: ignoreversion
Source: "{#ProjectRoot}\docs\启动故障排查.md"; DestDir: "{app}\docs"; Flags: ignoreversion

[Icons]
; 开始菜单快捷方式 — 指向 launcher.exe
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\app-icon.ico"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
; 桌面快捷方式（可选）
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\app-icon.ico"; Tasks: desktopicon

[Run]
; 安装完成后可选启动
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent; WorkingDir: "{app}"

[UninstallRun]
; 卸载前尝试停止 launcher 和 Node 进程
Filename: "{cmd}"; Parameters: "/c taskkill /f /im launcher.exe 2>nul"; Flags: runhidden; RunOnceId: "KillLauncher"
Filename: "{cmd}"; Parameters: "/c taskkill /f /im node.exe 2>nul"; Flags: runhidden; RunOnceId: "KillNode"

[UninstallDelete]
; 卸载时清理整个安装目录（包括运行时生成的临时文件）
Type: filesandordirs; Name: "{app}"

[Code]
function InitializeSetup(): Boolean;
begin
  Result := True;
end;
