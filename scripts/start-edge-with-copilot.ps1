param(
  [string]$BossUrl = "https://www.zhipin.com/web/geek/jobs",
  [string]$SystemUrl = "http://127.0.0.1:8083"
)

$ErrorActionPreference = "Stop"

# 功能目的：统一 PowerShell 输出编码；实现原因：中文启动日志必须按 UTF-8 显示。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$extensionPath = Join-Path $projectRoot "extension"
$manifestPath = Join-Path $extensionPath "manifest.json"
$edgePathCandidates = @(
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe")
)
$edgePath = $edgePathCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$edgeProfilePath = ""
if ([string]::IsNullOrWhiteSpace($env:BOSS_EDGE_PROFILE_DIR)) {
  $edgeProfilePath = Join-Path $env:LOCALAPPDATA "BossJobCopilot\EdgeProfile"
} else {
  $edgeProfilePath = $env:BOSS_EDGE_PROFILE_DIR
}
$legacyEdgeProfilePath = Join-Path $projectRoot ".edge-copilot-profile"

if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "Extension manifest not found: $manifestPath"
}

if ([string]::IsNullOrWhiteSpace($edgePath) -or -not (Test-Path -LiteralPath $edgePath)) {
  throw "Edge executable not found. Checked: $($edgePathCandidates -join ', ')"
}

# 功能目的：迁移旧专用配置目录；实现原因：更新后不应要求用户重新扫码登录 BOSS。
$edgeProfileExists = Test-Path -LiteralPath $edgeProfilePath
$legacyEdgeProfileExists = Test-Path -LiteralPath $legacyEdgeProfilePath
if (-not $edgeProfileExists -and $legacyEdgeProfileExists) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $edgeProfilePath) | Out-Null
  Copy-Item -LiteralPath $legacyEdgeProfilePath -Destination $edgeProfilePath -Recurse -Force -ErrorAction SilentlyContinue
}

# 功能目的：使用固定专用配置目录加载扩展；实现原因：保留 BOSS 登录态，同时避免污染用户默认浏览器。
New-Item -ItemType Directory -Force -Path $edgeProfilePath | Out-Null

function Test-CopilotDebugPort {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:9223/json/version" -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-CopilotEdgeRunning {
  $edgeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue)
  foreach ($edgeProcess in $edgeProcesses) {
    $commandLine = [string]$edgeProcess.CommandLine
    if ($commandLine -like "*$edgeProfilePath*" -or $commandLine -like "*$extensionPath*") {
      return $true
    }
  }
  return $false
}

function Wait-ForCopilotEdgeStartup {
  param(
    [int]$RetryCount = 30,
    [int]$DelayMilliseconds = 300
  )

  for ($index = 0; $index -lt $RetryCount; $index++) {
    if (Test-CopilotEdgeRunning -and (Test-CopilotDebugPort)) {
      return $true
    }
    Start-Sleep -Milliseconds $DelayMilliseconds
  }
  return $false
}

function Stop-CopilotEdgeProcesses {
  $edgeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue)
  foreach ($edgeProcess in $edgeProcesses) {
    $commandLine = [string]$edgeProcess.CommandLine
    if ($commandLine -like "*$edgeProfilePath*" -or $commandLine -like "*$extensionPath*") {
      Stop-Process -Id $edgeProcess.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Start-CopilotEdgeWindow {
  $arguments = @(
    "--disable-features=msStartupBoost",
    "--disable-session-crashed-bubble",
    "--no-first-run",
    "--remote-debugging-port=9223",
    "--new-window",
    ('--user-data-dir="{0}"' -f $edgeProfilePath),
    ('--disable-extensions-except="{0}"' -f $extensionPath),
    ('--load-extension="{0}"' -f $extensionPath),
    ('"{0}"' -f $SystemUrl),
    ('"{0}"' -f $BossUrl)
  ) -join " "

  Start-Process -FilePath $edgePath -ArgumentList $arguments
}

# 功能目的：复用已经运行的专用 Edge；实现原因：重复启动会不断新增系统页和 BOSS 职位页。
if ((Test-CopilotEdgeRunning) -and (Test-CopilotDebugPort)) {
  Write-Host "Edge Copilot window is already running. Reusing the current window."
  exit 0
}

Start-CopilotEdgeWindow
if (Wait-ForCopilotEdgeStartup) {
  Write-Host "Edge Copilot window started. Extension path: $extensionPath"
  exit 0
}

# 功能目的：自动修复启动参数被普通 Edge 吞掉的问题；实现原因：用户不应手动关闭浏览器后再重试。
Write-Host "Regular Edge session swallowed the launch arguments. Restarting dedicated window..."
Stop-CopilotEdgeProcesses
Start-CopilotEdgeWindow

if (-not (Wait-ForCopilotEdgeStartup)) {
  throw "Dedicated Edge window failed to start. Check whether Edge is blocked by security software."
}

Write-Host "Edge Copilot window restarted and extension reloaded: $extensionPath"
