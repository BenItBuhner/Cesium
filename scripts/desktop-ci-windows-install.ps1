param(
  [Parameter(Mandatory = $true)]
  [string]$SetupPath,
  [Parameter(Mandatory = $true)]
  [string]$ScreenshotDir
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $ScreenshotDir | Out-Null

$setup = (Resolve-Path -LiteralPath $SetupPath).Path
$capture = Join-Path $PSScriptRoot "desktop-ci-capture-screen.ps1"
$oneClickShot = Join-Path $ScreenshotDir "windows_oneclick_installer.png"
$afterShot = Join-Path $ScreenshotDir "windows_desktop_after_install.png"

function Find-InstalledCesium {
  $roots = @(
    (Join-Path $env:LOCALAPPDATA "Programs"),
    (Join-Path $env:LOCALAPPDATA "Cesium Desktop"),
    (Join-Path $env:LOCALAPPDATA "Cesium")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  foreach ($root in $roots) {
    $hit = Get-ChildItem -LiteralPath $root -Filter "Cesium.exe" -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($hit) {
      return $hit.FullName
    }
  }
  return $null
}

Write-Host "Starting one-click installer via Start-Process: $setup"
$gui = Start-Process -FilePath $setup -PassThru
Start-Sleep -Seconds 6
& $capture -Path $oneClickShot
if (-not $gui.HasExited) {
  Write-Host "Waiting for installer PID $($gui.Id)"
  $null = $gui.WaitForExit(180000)
}
if (-not $gui.HasExited) {
  Write-Host "Installer still running after 180s"
}

$installed = Find-InstalledCesium
if (-not $installed) {
  Write-Host "GUI install did not produce Cesium.exe; running silent /S"
  $silent = Start-Process -FilePath $setup -ArgumentList "/S" -PassThru
  $null = $silent.WaitForExit(180000)
  for ($i = 0; $i -lt 30; $i++) {
    $installed = Find-InstalledCesium
    if ($installed) { break }
    Start-Sleep -Seconds 2
  }
}

if (-not $installed) {
  Write-Host "LOCALAPPDATA=$env:LOCALAPPDATA"
  Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA "Programs") -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host $_.FullName }
  throw "Cesium.exe was not installed under %LOCALAPPDATA%"
}

if ($installed -match '\\Program Files( \(x86\))?\\') {
  throw "Unexpected machine-wide install: $installed"
}

if ($installed -match '\\@cesiumdesktop\\') {
  throw "Leftover scoped install path from #214: $installed (expected %LOCALAPPDATA%\Programs\Cesium)"
}
$expectedDir = Join-Path $env:LOCALAPPDATA "Programs\Cesium"
if ($installed -notlike "$expectedDir*") {
  Write-Host "Warning: installed outside Programs\Cesium: $installed"
}

Write-Host "Installed executable: $installed"
"INSTALLED_EXE=$installed" | Add-Content -Path $env:GITHUB_ENV
& $capture -Path $afterShot

Get-Process -Name "Cesium","Cesium Desktop" -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue
