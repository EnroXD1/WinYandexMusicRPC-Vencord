Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-ChildPath([string]$Root, [string]$Relative) {
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $path = [IO.Path]::GetFullPath((Join-Path $base $Relative))
    if (-not $path.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Путь выходит за пределы папки назначения: $path"
    }
    return $path
}

function Assert-NormalDirectory([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Нужна обычная папка без перенаправлений: $Path"
    }
}

function Get-RuntimeFiles([string]$Directory) {
    Assert-NormalDirectory $Directory
    $base = [IO.Path]::GetFullPath($Directory).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($Directory)
    while ($pending.Count -gt 0) {
        $folder = $pending.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $folder -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "В сборке найдено перенаправление: $($item.FullName)" }
            if ($item.PSIsContainer) { $pending.Push($item.FullName); continue }
            [pscustomobject]@{
                path = $item.FullName.Substring($base.Length).Replace('\', '/')
                size = $item.Length
                sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
    }
}

function Assert-DesktopRuntime([string]$Directory) {
    Assert-NormalDirectory $Directory
    foreach ($name in @('patcher.js', 'preload.js', 'renderer.js', 'renderer.css')) {
        $file = Get-Item -LiteralPath (Get-ChildPath $Directory $name) -Force
        if ($file.PSIsContainer -or $file.Length -eq 0 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Сборка Vencord неполна: $name"
        }
    }
}

function Assert-RuntimeFiles([string]$Directory, [object[]]$Files) {
    if ($Files.Count -eq 0) { throw 'Список файлов сборки пуст.' }
    $expected = @{}
    foreach ($file in $Files) {
        if ($file.path -notmatch '^[a-zA-Z0-9._/-]+$' -or $file.path.Split('/') -contains '..' -or $file.path.StartsWith('/')) { throw 'Недопустимый путь в списке файлов.' }
        $null = Get-ChildPath $Directory $file.path
        if ($expected.ContainsKey($file.path) -or $file.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Некорректный список контрольных сумм.' }
        $expected[$file.path] = $file
    }
    $actual = @(Get-RuntimeFiles $Directory)
    if ($actual.Count -ne $Files.Count) { throw 'Количество файлов не совпадает с описанием сборки.' }
    foreach ($file in $actual) {
        $match = $expected[$file.path]
        if ($null -eq $match -or $match.size -ne $file.size -or $match.sha256 -ne $file.sha256) { throw "Файл повреждён или изменён: $($file.path)" }
    }
    Assert-DesktopRuntime $Directory
}

function Test-RuntimeFiles([string]$Directory, [object[]]$Files) {
    try { Assert-RuntimeFiles $Directory $Files; return $true } catch { return $false }
}

function Get-InstallerPackage([string]$PackageRoot) {
    $manifest = Get-Content -LiteralPath (Get-ChildPath $PackageRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.format -ne 1 -or $manifest.name -ne 'WinYandexMusicRPC') { throw 'Неверный формат установочного пакета.' }
    $dist = Get-ChildPath $PackageRoot 'dist'
    Assert-RuntimeFiles $dist @($manifest.files)
    $patcher = [IO.File]::ReadAllText((Join-Path $dist 'patcher.js'))
    $renderer = [IO.File]::ReadAllText((Join-Path $dist 'renderer.js'))
    if (-not $patcher.Contains('Standalone: true') -or -not $patcher.Contains('Updater Disabled: true') -or -not $renderer.Contains('WinYandexMusicRPC') -or -not $patcher.Contains('WinYandexMusicRPC')) {
        throw 'В пакете отсутствует готовая автономная сборка музыкального плагина.'
    }
    return $manifest
}

function Test-DiscordTarget([string]$AppAsar, [string]$VencordRoot) {
    if (-not (Test-Path -LiteralPath $AppAsar -PathType Leaf)) { return $false }
    $item = Get-Item -LiteralPath $AppAsar -Force
    if ($item.Length -gt 1MB -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
    $expected = Get-ChildPath $VencordRoot 'dist/patcher.js'
    $quoted = '"' + $expected.Replace('\', '\\') + '"'
    $text = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($AppAsar))
    return [regex]::IsMatch($text, 'require\s*\(\s*' + [regex]::Escape($quoted) + '\s*\)', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

function Get-DiscordClients([string]$LocalRoot, [string]$VencordRoot) {
    foreach ($channel in @('Discord', 'DiscordCanary', 'DiscordPTB', 'DiscordDevelopment')) {
        $root = Get-ChildPath $LocalRoot $channel
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        Assert-NormalDirectory $root
        $versions = @(foreach ($folder in Get-ChildItem -LiteralPath $root -Directory -Filter 'app-*') {
            $version = $null
            if ([version]::TryParse($folder.Name.Substring(4), [ref]$version)) { [pscustomobject]@{ Version = $version; Folder = $folder.FullName } }
        })
        if ($versions.Count -eq 0) { continue }
        $latest = $versions | Sort-Object Version -Descending | Select-Object -First 1
        $updater = Get-ChildPath $root 'Update.exe'
        [pscustomobject]@{
            Name = $channel
            Root = $root
            Updater = $updater
            Patched = ((Test-Path -LiteralPath $updater -PathType Leaf) -and (Test-DiscordTarget (Join-Path $latest.Folder 'resources/app.asar') $VencordRoot))
        }
    }
}

function Move-RuntimeDirectory([string]$Root, [string]$Source, [string]$Destination) {
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $prefix = $base + [IO.Path]::DirectorySeparatorChar
    $sourcePath = [IO.Path]::GetFullPath($Source)
    $destinationPath = [IO.Path]::GetFullPath($Destination)
    if (-not $sourcePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or -not $destinationPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Перемещение вне папки Vencord запрещено.' }
    Assert-NormalDirectory $base
    Assert-NormalDirectory (Split-Path -Parent $destinationPath)
    $null = @(Get-RuntimeFiles $sourcePath)
    if (Test-Path -LiteralPath $destinationPath) { throw "Папка назначения уже существует: $destinationPath" }
    Move-Item -LiteralPath $sourcePath -Destination $destinationPath
}

function Remove-StagingDirectory([string]$Root, [string]$Stage) {
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $path = [IO.Path]::GetFullPath($Stage)
    if ((Split-Path -Parent $path) -ne $base -or (Split-Path -Leaf $path) -notmatch '^dist\.wymrpc-stage-[a-f0-9]{32}$') { throw 'Неверный путь временной папки.' }
    if (Test-Path -LiteralPath $path) {
        $null = @(Get-RuntimeFiles $path)
        Remove-Item -LiteralPath $path -Recurse -Force
    }
}

function Invoke-RuntimeSwap {
    param(
        [string]$VencordRoot,
        [string]$SourceDist,
        [object[]]$Files,
        [ValidateSet('install', 'restore')][string]$Kind = 'install',
        [scriptblock]$AfterSwap
    )
    $root = [IO.Path]::GetFullPath($VencordRoot)
    Assert-NormalDirectory $root
    $live = Get-ChildPath $root 'dist'
    Assert-DesktopRuntime $live
    Assert-RuntimeFiles $SourceDist $Files
    if (Test-RuntimeFiles $live $Files) { return [pscustomobject]@{ Changed = $false; Backup = $null } }
    $id = [guid]::NewGuid().ToString('N')
    $stage = Get-ChildPath $root ('dist.wymrpc-stage-' + $id)
    $backupParent = Get-ChildPath $root 'wymrpc-backups'
    if (Test-Path -LiteralPath $backupParent) { Assert-NormalDirectory $backupParent }
    $backup = Get-ChildPath $root ('wymrpc-backups/' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff') + '-' + $id)
    $oldMoved = $false
    $oldFiles = @(Get-RuntimeFiles $live)
    try {
        New-Item -ItemType Directory -Path $stage | Out-Null
        foreach ($file in $Files) {
            $target = Get-ChildPath $stage $file.path
            $parent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            Copy-Item -LiteralPath (Get-ChildPath $SourceDist $file.path) -Destination $target
        }
        Assert-RuntimeFiles $stage $Files
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        $record = [ordered]@{ format = 1; kind = $Kind; createdUtc = [DateTime]::UtcNow.ToString('o'); files = $oldFiles }
        [IO.File]::WriteAllText((Join-Path $backup 'backup.json'), ($record | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
        Move-RuntimeDirectory $root $live (Join-Path $backup 'dist')
        $oldMoved = $true
        Move-RuntimeDirectory $root $stage $live
        if ($AfterSwap) { & $AfterSwap $live }
        Assert-RuntimeFiles $live $Files
        return [pscustomobject]@{ Changed = $true; Backup = $backup }
    } catch {
        $problem = $_.Exception.Message
        if ($oldMoved) {
            try {
                if (Test-Path -LiteralPath $live) { Move-RuntimeDirectory $root $live (Join-Path $backup 'failed-new-dist') }
                Move-RuntimeDirectory $root (Join-Path $backup 'dist') $live
                Assert-RuntimeFiles $live $oldFiles
            } catch {
                throw "Откат не завершён. Оставьте Discord закрытым. Резервная копия: $backup. Причина: $($_.Exception.Message)"
            }
            throw "Установка не завершена; предыдущая сборка восстановлена. Причина: $problem"
        }
        throw $problem
    } finally {
        if (Test-Path -LiteralPath $stage) { Remove-StagingDirectory $root $stage }
    }
}

function Get-LatestRestorePoint([string]$VencordRoot) {
    $parent = Get-ChildPath $VencordRoot 'wymrpc-backups'
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Нет резервной копии, созданной этим установщиком.' }
    Assert-NormalDirectory $parent
    foreach ($folder in Get-ChildItem -LiteralPath $parent -Directory | Sort-Object Name -Descending) {
        Assert-NormalDirectory $folder.FullName
        $recordPath = Get-ChildPath $folder.FullName 'backup.json'
        if (-not (Test-Path -LiteralPath $recordPath -PathType Leaf)) { continue }
        $record = Get-Content -LiteralPath $recordPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $dist = Get-ChildPath $folder.FullName 'dist'
        if ($record.format -eq 1 -and $record.kind -eq 'install' -and (Test-Path -LiteralPath $dist)) {
            Assert-RuntimeFiles $dist @($record.files)
            return [pscustomobject]@{ Directory = $dist; Files = @($record.files) }
        }
    }
    throw 'Не найдена целая резервная копия предыдущей установки.'
}

Export-ModuleMember -Function Get-ChildPath, Get-RuntimeFiles, Assert-DesktopRuntime, Assert-RuntimeFiles, Test-RuntimeFiles, Get-InstallerPackage, Test-DiscordTarget, Get-DiscordClients, Invoke-RuntimeSwap, Get-LatestRestorePoint
