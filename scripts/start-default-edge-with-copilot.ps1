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
$edgeProfilePath = if ([string]::IsNullOrWhiteSpace($env:BOSS_EDGE_PROFILE_DIR)) {
  Join-Path $env:LOCALAPPDATA "BossJobCopilot\EdgeProfile"
} else {
  $env:BOSS_EDGE_PROFILE_DIR
}
$legacyEdgeProfilePath = Join-Path $projectRoot ".edge-copilot-profile"

if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "未找到扩展清单：$manifestPath"
}

if ([string]::IsNullOrWhiteSpace($edgePath) -or -not (Test-Path -LiteralPath $edgePath)) {
  throw "未找到 Edge，已检查：$($edgePathCandidates -join ', ')"
}

if ((-not (Test-Path -LiteralPath $edgeProfilePath)) -and (Test-Path -LiteralPath $legacyEdgeProfilePath)) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $edgeProfilePath) | Out-Null
  Copy-Item -LiteralPath $legacyEdgeProfilePath -Destination $edgeProfilePath -Recurse -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Force -Path $edgeProfilePath | Out-Null

# 功能目的：只关闭专用 Edge 进程；实现原因：保留普通 Edge 和 BOSS 登录态，避免用户反复扫码。
$edgeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'" -ErrorAction SilentlyContinue)
foreach ($edgeProcess in $edgeProcesses) {
  $commandLine = [string]$edgeProcess.CommandLine
  if ($commandLine -like "*$edgeProfilePath*" -or $commandLine -like "*$extensionPath*") {
    Stop-Process -Id $edgeProcess.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

$arguments = "--disable-features=msStartupBoost --disable-session-crashed-bubble --no-first-run --remote-debugging-port=9223 --user-data-dir=`"$edgeProfilePath`" --disable-extensions-except=`"$extensionPath`" --load-extension=`"$extensionPath`" --new-window `"$SystemUrl`" `"$BossUrl`""
Start-Process -FilePath $edgePath -ArgumentList $arguments

for ($index = 0; $index -lt 30; $index++) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:9223/json/version" -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      break
    }
  } catch {
    Start-Sleep -Milliseconds 300
  }
}

Write-Host "Edge loaded AI Job Copilot extension: $extensionPath"
