# Starts the local Live Camera demo: go2rtc restreaming a road video, and the camera service.
# The stream comes from a file, so the page labels it REPLAY. Safe to run again.
# Run from anywhere: pwsh -File camera_service/start_demo.ps1
# Needs, in camera_service/runtime (ignored by git): tools/go2rtc.exe, tools/ffmpeg.exe, media/road960.mp4 (H.264 road video).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $PSScriptRoot 'runtime'
$logs = Join-Path $runtime 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
foreach ($file in 'tools\go2rtc.exe', 'tools\ffmpeg.exe', 'media\road960.mp4') {
    if (-not (Test-Path -LiteralPath (Join-Path $runtime $file))) { throw "Missing camera_service\runtime\$file" }
}

# Stop an earlier run, and be certain of it: a new service cannot bind a port the old one still holds.
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*camera_service.api:app*' -or $_.ExecutablePath -eq (Join-Path $runtime 'tools\go2rtc.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue }
foreach ($port in 8091, 1984, 8554) {
    foreach ($try in 1..20) {
        $holders = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if (-not $holders) { break }
        $holders | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 500
        if ($try -eq 20) { throw "Port $port is still in use. Close the program using it and try again." }
    }
}
Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | Where-Object { $_.CommandLine -like '*road960.mp4*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue }

# go2rtc splits its exec source on spaces, so paths are relative to the runtime folder, where it runs.
$ffmpeg = 'tools/ffmpeg.exe'
$video = 'media/road960.mp4'
$config = @{
    api = @{ listen = '127.0.0.1:1984' }; rtsp = @{ listen = '127.0.0.1:8554' }; webrtc = @{ listen = '' }; log = @{ level = 'warn' }
    streams = @{ road = "exec:$ffmpeg -hide_banner -re -stream_loop -1 -i $video -c copy -an -rtsp_transport tcp -f rtsp {output}" }
} | ConvertTo-Json -Depth 4
$configPath = Join-Path $runtime 'go2rtc.yaml'
[IO.File]::WriteAllText($configPath, $config)
Start-Process -FilePath (Join-Path $runtime 'tools\go2rtc.exe') -ArgumentList '-config', "`"$configPath`"" -WorkingDirectory $runtime -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs 'go2rtc.log') -RedirectStandardError (Join-Path $logs 'go2rtc.err.log')
Start-Process -FilePath (Join-Path $root '.venv\Scripts\python.exe') -ArgumentList '-m', 'uvicorn', 'camera_service.api:app', '--host', '127.0.0.1', '--port', '8091', '--log-level', 'warning' -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs 'service.log') -RedirectStandardError (Join-Path $logs 'service.err.log')

$api = 'http://127.0.0.1:8091/api/camera'
$headers = @{ 'X-TSI-Role' = 'admin' }
if ($env:TSI_GATEWAY_SECRET) { $headers['X-TSI-Gateway-Secret'] = $env:TSI_GATEWAY_SECRET }
$post = { param($path, $body) Invoke-RestMethod -Uri "$api/$path" -Method Post -Headers $headers -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 8) }
foreach ($try in 1..60) {
    try { Invoke-RestMethod -Uri "$api/health" -TimeoutSec 2 | Out-Null; break } catch { if ($try -eq 60) { throw 'The camera service did not start. See camera_service\runtime\logs.' }; Start-Sleep -Seconds 1 }
}
& $post 'infra/go2rtc' @{ url = 'http://127.0.0.1:1984'; rtsp_url = 'rtsp://127.0.0.1:8554' } | Out-Null
$cameras = Invoke-RestMethod -Uri "$api/cameras" -Headers $headers
if (-not ($cameras | Where-Object { $_.id -eq 'CAM_01' })) {
    & $post 'cameras' @{
        id = 'CAM_01'; camera_name = 'Highway overpass'; location = 'Sample road video'; source_type = 'go2rtc'; source = 'road'; intersection_id = 'JUNCTION_01'; data_class = 'REPLAY'
        zones = @{ approaches = @{
            north = @{ polygon = @(@(0.0, 1.0), @(0.33, 0.2), @(0.46, 0.2), @(0.46, 1.0)); stop_line = @(@(0.0, 0.98), @(0.46, 0.98)) }
            east  = @{ polygon = @(@(0.46, 0.2), @(0.52, 0.2), @(1.0, 0.8), @(1.0, 1.0), @(0.5, 1.0)) }
        } }
    } | Out-Null
}
Write-Output 'Live Camera demo is running: http://localhost:3000/live-camera'
