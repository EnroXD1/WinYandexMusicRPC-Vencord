param(
    [ValidateSet('Install', 'Restore', 'Check')][string]$Action = 'Install',
    [switch]$NoPrompt
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Import-Module (Join-Path $PSScriptRoot 'InstallerCore.psm1') -Force -DisableNameChecking

$vencordRoot = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Vencord'
$localRoot = [Environment]::GetFolderPath('LocalApplicationData')
$clients = @()
$restart = @()
$lock = $null
$closed = $false
$reopenAllowed = $true

function Get-ClientProcessState {
    param([object[]]$Clients)
    $result = @()
    foreach ($name in @('Discord', 'DiscordCanary', 'DiscordPTB', 'DiscordDevelopment', 'DiscordSystemHelper')) {
        foreach ($process in Get-Process -Name $name -ErrorAction SilentlyContinue) {
            $path = $null
            try { $path = $process.Path } catch {}
            $owner = $null
            foreach ($client in $Clients) {
                $prefix = $client.Root.TrimEnd('\') + '\'
                if ($path -and $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { $owner = $client; break }
            }
            if ($null -eq $owner -or -not $owner.Patched) { throw "Закройте $name вручную: он использует другую установку Discord или Vencord." }
            $result += [pscustomobject]@{ Process = $process; Client = $owner }
        }
    }
    return $result
}

function Assert-NoDiscordUpdate {
    param([object[]]$Clients)
    foreach ($process in Get-Process -Name Update -ErrorAction SilentlyContinue) {
        $path = $null
        try { $path = $process.Path } catch {}
        foreach ($client in $Clients) {
            if ($path -and $path.Equals($client.Updater, [StringComparison]::OrdinalIgnoreCase)) { throw 'Discord сейчас обновляется. Дождитесь завершения обновления и повторите установку.' }
        }
    }
}

function Stop-SelectedClients {
    param([object[]]$State)
    foreach ($entry in $State) {
        if (-not $entry.Process.HasExited) { $null = $entry.Process.CloseMainWindow() }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(2)
    do {
        $remaining = @($State | Where-Object { -not $_.Process.HasExited })
        if ($remaining.Count -eq 0) { break }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    foreach ($entry in $State) {
        if (-not $entry.Process.HasExited) {
            Stop-Process -Id $entry.Process.Id -Force
            if (-not $entry.Process.WaitForExit(10000)) { throw 'Discord не завершился. Закройте его вручную.' }
        }
    }
}

function Restart-SelectedClients {
    param([object[]]$Clients)
    foreach ($client in $Clients) {
        try {
            if (-not (Test-Path -LiteralPath $client.Updater -PathType Leaf)) { throw 'Update.exe не найден' }
            Start-Process -FilePath $client.Updater -ArgumentList @('--processStart', ($client.Name + '.exe')) -WindowStyle Hidden | Out-Null
        } catch { Write-Host "Откройте $($client.Name) вручную: $($_.Exception.Message)" -ForegroundColor Yellow }
    }
}

try {
    Write-Host ''
    Write-Host '  WinYandexMusicRPC — установка плагина Vencord' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '[1/4] Проверка файлов и установленного Vencord...'
    $package = $null
    if ($Action -ne 'Restore') { $package = Get-InstallerPackage $PSScriptRoot }
    if (-not (Test-Path -LiteralPath $vencordRoot -PathType Container)) { throw 'Сначала установите обычный Vencord: https://vencord.dev/download . Затем повторно запустите INSTALL.cmd.' }
    Assert-DesktopRuntime (Join-Path $vencordRoot 'dist')
    $clients = @(Get-DiscordClients $localRoot $vencordRoot)
    $patched = @($clients | Where-Object { $_.Patched })
    if ($patched.Count -eq 0) { throw 'Не найден Discord, подключённый к этой папке Vencord. Выполните Install/Repair в официальном установщике Vencord, затем повторите.' }

    $sourceDist = $null
    $files = @()
    if ($Action -eq 'Restore') {
        $restorePoint = Get-LatestRestorePoint $vencordRoot
        $sourceDist = $restorePoint.Directory
        $files = @($restorePoint.Files)
    } else {
        $sourceDist = Join-Path $PSScriptRoot 'dist'
        $files = @($package.files)
    }
    Write-Host ('Vencord: ' + $vencordRoot)
    Write-Host ('Клиенты: ' + (($patched | ForEach-Object { $_.Name }) -join ', '))
    if ($Action -eq 'Check') { Write-Host 'Проверка завершена. Система не изменялась.' -ForegroundColor Green; exit 0 }
    if (Test-RuntimeFiles (Join-Path $vencordRoot 'dist') $files) { Write-Host 'Эта сборка уже установлена. Изменения не нужны.' -ForegroundColor Green; exit 0 }

    Write-Host ''
    if ($Action -eq 'Install') {
        Write-Host 'Будет установлена готовая сборка Vencord с музыкальным плагином.'
        Write-Host 'Другие сторонние плагины текущей сборки будут заменены.' -ForegroundColor Yellow
    } else { Write-Host 'Будет восстановлена сборка, сохранённая перед последней установкой.' }
    Write-Host 'Текущая сборка сохранится в резервной копии. Настройки и токены сохраняются.'
    Write-Host 'Discord закроется на время установки и затем откроется снова.'
    if (-not $NoPrompt) { $null = Read-Host 'Нажмите Enter для продолжения или Ctrl+C для отмены' }

    $lock = [IO.File]::Open((Join-Path $vencordRoot 'wymrpc-installer.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    Assert-NoDiscordUpdate $clients
    $state = @(Get-ClientProcessState $clients)
    $restart = @($state | ForEach-Object { $_.Client } | Sort-Object Name -Unique)
    if ($restart.Count -eq 0 -and $patched.Count -eq 1) { $restart = @($patched[0]) }
    Write-Host '[2/4] Завершение Discord...'
    $closed = $true
    Stop-SelectedClients $state
    Assert-NoDiscordUpdate $clients
    if (@(Get-ClientProcessState $clients).Count -ne 0) { throw 'Discord запустился повторно. Закройте его и повторите установку.' }

    Write-Host '[3/4] Резервная копия и установка файлов...'
    $kind = if ($Action -eq 'Restore') { 'restore' } else { 'install' }
    $result = Invoke-RuntimeSwap -VencordRoot $vencordRoot -SourceDist $sourceDist -Files $files -Kind $kind
    if ($result.Backup) { Write-Host ('Резервная копия: ' + $result.Backup) }
    Write-Host '[4/4] Проверка завершена. Открытие Discord...'
    Restart-SelectedClients $restart
    $closed = $false
    Write-Host ''
    if ($Action -eq 'Install') {
        Write-Host 'Готово! В Discord откройте:' -ForegroundColor Green
        Write-Host '  Настройки → Vencord → Plugins → WinYandexMusicRPC → Включить'
        Write-Host '  Для телефона добавьте OAuth-токен в настройках плагина.'
    } else { Write-Host 'Предыдущая сборка восстановлена.' -ForegroundColor Green }
    exit 0
} catch {
    $message = $_.Exception.Message
    if ($message -like 'Откат не завершён*') { $reopenAllowed = $false }
    Write-Host ''
    Write-Host ('Ошибка: ' + $message) -ForegroundColor Red
    if ($closed -and $reopenAllowed) { Restart-SelectedClients $restart }
    exit 1
} finally {
    if ($null -ne $lock) { $lock.Dispose() }
}
