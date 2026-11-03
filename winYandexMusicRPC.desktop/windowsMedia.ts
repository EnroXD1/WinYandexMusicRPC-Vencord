/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Windows PowerShell 5.1 provides the .NET Framework WinRT projection without extra packages.
export const WINDOWS_MEDIA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Send-Json($value) {
    [Console]::WriteLine((ConvertTo-Json -InputObject $value -Compress -Depth 5))
    [Console]::Out.Flush()
}

try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
    $propertiesType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1'
    } | Select-Object -First 1

    function Await-WinRT($operation, [Type]$resultType) {
        $task = $asTask.MakeGenericMethod(@($resultType)).Invoke($null, @($operation))
        if (-not $task.Wait(5000)) { throw 'Windows media request timed out.' }
        return $task.Result
    }

    $manager = Await-WinRT ($managerType::RequestAsync()) $managerType
    while ($true) {
        try { $null = [Diagnostics.Process]::GetProcessById(__PARENT_PID__) } catch { break }
        $current = $manager.GetCurrentSession()
        $sessions = @()
        foreach ($session in $manager.GetSessions()) {
            $info = $session.GetPlaybackInfo()
            $status = $info.PlaybackStatus.ToString().ToLowerInvariant()
            if ($status -ne 'playing' -and $status -ne 'paused') { continue }
            $properties = Await-WinRT ($session.TryGetMediaPropertiesAsync()) $propertiesType
            if (-not $properties.Title) { continue }
            $timeline = $session.GetTimelineProperties()
            $duration = [Math]::Max(0, ($timeline.EndTime - $timeline.StartTime).TotalSeconds)
            $position = [Math]::Max(0, ($timeline.Position - $timeline.StartTime).TotalSeconds)
            $rate = 1.0
            if ($null -ne $info.PlaybackRate) { $rate = [double]$info.PlaybackRate }
            $now = [DateTimeOffset]::UtcNow
            $elapsed = ($now - $timeline.LastUpdatedTime).TotalSeconds
            if ($status -eq 'playing' -and $elapsed -gt 0 -and $elapsed -lt 86400) {
                $position += $elapsed * $rate
            }
            if ($duration -gt 0) { $position = [Math]::Min($position, $duration) }
            $sessions += @{
                source = [string]$session.SourceAppUserModelId
                title = ([string]$properties.Title).Trim()
                artist = ([string]$properties.Artist).Trim()
                album = ([string]$properties.AlbumTitle).Trim()
                status = $status
                position = $position
                duration = $duration
                rate = $rate
                observedAt = $now.ToUnixTimeMilliseconds()
                current = ($null -ne $current -and $session -eq $current)
            }
        }
        Send-Json @{ sessions = @($sessions) }
        Start-Sleep -Milliseconds 1500
    }
} catch {
    Send-Json @{ error = $_.Exception.Message }
    exit 1
}
`;
