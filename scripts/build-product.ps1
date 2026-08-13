param(
  [string]$Version = "0.3.9"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$distDirectory = Join-Path $projectRoot "dist"
$buildDirectory = Join-Path $distDirectory ".product-build"
$stageDirectory = Join-Path $buildDirectory "payload"
$payloadArchive = Join-Path $buildDirectory "payload.zip"
$embedArchive = Join-Path $projectRoot "cmd\product-installer\payload.zip"
$outputExecutable = Join-Path $distDirectory ("BossJobCopilot-Setup-{0}.exe" -f $Version)

$fullProjectRoot = [System.IO.Path]::GetFullPath($projectRoot)
$fullBuildDirectory = [System.IO.Path]::GetFullPath($buildDirectory)
if (-not $fullBuildDirectory.StartsWith($fullProjectRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "构建目录不在项目目录内，拒绝清理：$fullBuildDirectory"
}

if (Test-Path -LiteralPath $buildDirectory) {
  Remove-Item -LiteralPath $buildDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $stageDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $distDirectory -Force | Out-Null

Push-Location $projectRoot
try {
  $testOutput = & go test ./internal/product 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ($testOutput -join [Environment]::NewLine)
  }

  & go build -trimpath -ldflags "-s -w" -o (Join-Path $stageDirectory "BossJobService.exe") .\cmd\server
  if ($LASTEXITCODE -ne 0) {
    throw "构建本地服务失败"
  }

  Copy-Item -LiteralPath (Join-Path $projectRoot "web") -Destination $stageDirectory -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $projectRoot "extension") -Destination $stageDirectory -Recurse -Force
  New-Item -ItemType Directory -Path (Join-Path $stageDirectory "scripts") -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $projectRoot "scripts\start-edge-with-copilot.ps1") -Destination (Join-Path $stageDirectory "scripts\start-edge-with-copilot.ps1") -Force
  Get-ChildItem -LiteralPath (Join-Path $stageDirectory "extension") -File -Filter "*.test.js" | Remove-Item -Force
  Copy-Item -LiteralPath (Join-Path $projectRoot "PRODUCT_README.md") -Destination (Join-Path $stageDirectory "使用说明.md") -Force

  Compress-Archive -Path (Join-Path $stageDirectory "*") -DestinationPath $payloadArchive -CompressionLevel Optimal -Force
  Copy-Item -LiteralPath $payloadArchive -Destination $embedArchive -Force

  $linkerFlags = "-s -w -H=windowsgui -X main.productVersion=$Version"
  & go build -tags product_installer -trimpath -ldflags $linkerFlags -o $outputExecutable .\cmd\product-installer
  if ($LASTEXITCODE -ne 0) {
    throw "构建单文件安装启动器失败"
  }

  $fileHash = Get-FileHash -LiteralPath $outputExecutable -Algorithm SHA256
  $hashFile = $outputExecutable + ".sha256.txt"
  ($fileHash.Hash.ToLowerInvariant() + "  " + [System.IO.Path]::GetFileName($outputExecutable)) | Set-Content -LiteralPath $hashFile -Encoding UTF8

  [PSCustomObject]@{
    Product = $outputExecutable
    SHA256 = $fileHash.Hash.ToLowerInvariant()
    SizeMB = [Math]::Round((Get-Item -LiteralPath $outputExecutable).Length / 1MB, 2)
    Tests = ($testOutput -join " ")
  }
} finally {
  Pop-Location
  if (Test-Path -LiteralPath $embedArchive) {
    Remove-Item -LiteralPath $embedArchive -Force
  }
  if (Test-Path -LiteralPath $buildDirectory) {
    Remove-Item -LiteralPath $buildDirectory -Recurse -Force
  }
}
