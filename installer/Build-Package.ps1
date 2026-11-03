param(
    [Parameter(Mandatory = $true)][string]$VencordPath,
    [Parameter(Mandatory = $true)][string]$PluginPath,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [ValidatePattern('^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$')][string]$Version = '1.0.1'
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'InstallerCore.psm1') -Force -DisableNameChecking
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sourceRoot = (Resolve-Path -LiteralPath $VencordPath).Path
$pluginRoot = (Resolve-Path -LiteralPath $PluginPath).Path
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Выберите новую папку для установочного пакета.' }
$zipPath = $output + '.zip'
if (Test-Path -LiteralPath $zipPath) { throw 'Архив с таким именем уже существует.' }
$package = Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json
if ($package.name -ne 'vencord') { throw 'Нужен каталог исходников Vencord.' }
$commit = (& git -c ('safe.directory=' + $sourceRoot.Replace('\', '/')) -C $sourceRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Не удалось определить коммит Vencord.' }

New-Item -ItemType Directory -Path $output | Out-Null
$dist = Join-Path $output 'dist'
New-Item -ItemType Directory -Path $dist | Out-Null
foreach ($file in Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'dist') -File) {
    Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $dist $file.Name)
}
[IO.File]::WriteAllText((Join-Path $dist 'package.json'), '{}', (New-Object Text.UTF8Encoding($false)))
$utf8 = New-Object Text.UTF8Encoding($true)
foreach ($name in @('Setup.ps1', 'InstallerCore.psm1', 'Test-Installer.ps1', 'Build-Package.ps1')) {
    [IO.File]::WriteAllText((Join-Path $output $name), [IO.File]::ReadAllText((Join-Path $PSScriptRoot $name)), $utf8)
}
foreach ($name in @('INSTALL.cmd', 'RESTORE.cmd', 'CHECK.cmd')) {
    $text = [IO.File]::ReadAllText((Join-Path $PSScriptRoot $name)) -replace '\r?\n', "`r`n"
    [IO.File]::WriteAllText((Join-Path $output $name), $text, [Text.Encoding]::ASCII)
}
[IO.File]::WriteAllText((Join-Path $output 'README.txt'), [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'README.txt')), $utf8)

$licenses = Join-Path $output 'licenses'
New-Item -ItemType Directory -Path $licenses | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'LICENSE') -Destination (Join-Path $licenses 'LICENSE-Vencord.txt')
Copy-Item -LiteralPath (Join-Path $sourceRoot 'node_modules/ws/LICENSE') -Destination (Join-Path $licenses 'LICENSE-ws.txt')
foreach ($name in @('LICENSE', 'LICENSE-WinYandexMusicRPC', 'LICENSE-yandex-music-api', 'NOTICE.md')) {
    Copy-Item -LiteralPath (Join-Path $pluginRoot $name) -Destination (Join-Path $licenses ('plugin-' + $name))
}
$buildInfo = [ordered]@{
    name = 'WinYandexMusicRPC'
    packageVersion = $Version
    packagedUtc = [DateTime]::UtcNow.ToString('o')
    vencordVersion = $package.version
    vencordCommit = $commit
    buildCommand = 'pnpm build --dev --standalone --disable-updater'
    wsVersion = '8.22.1'
    customPlugins = @('WinYandexMusicRPC')
    liveDiscordInstallationTested = $false
}
[IO.File]::WriteAllText((Join-Path $output 'BUILD-INFO.json'), ($buildInfo | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
$manifest = [ordered]@{ format = 1; name = 'WinYandexMusicRPC'; version = $Version; files = @(Get-RuntimeFiles $dist | Sort-Object path) }
[IO.File]::WriteAllText((Join-Path $output 'manifest.json'), ($manifest | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
$null = Get-InstallerPackage $output

function Add-SourceFile($Archive, [string]$FilePath, [string]$EntryName) {
    $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Archive, $FilePath, $EntryName.Replace('\', '/'), [IO.Compression.CompressionLevel]::Optimal)
}

$sourceZip = [IO.Compression.ZipFile]::Open((Join-Path $output 'SOURCE.zip'), [IO.Compression.ZipArchiveMode]::Create)
try {
    $tracked = @(& git -c ('safe.directory=' + $sourceRoot.Replace('\', '/')) -C $sourceRoot ls-files)
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось перечислить исходники.' }
    foreach ($relative in $tracked) {
        $file = Get-ChildPath $sourceRoot $relative
        Add-SourceFile $sourceZip $file ('Vencord/' + $relative)
    }
    foreach ($file in Get-ChildItem -LiteralPath $pluginRoot -Recurse -File) {
        $relative = $file.FullName.Substring($pluginRoot.TrimEnd('\').Length + 1)
        Add-SourceFile $sourceZip $file.FullName ('Vencord/src/userplugins/winYandexMusicRPC.desktop/' + $relative)
    }
    $wsRoot = Join-Path $sourceRoot 'node_modules/ws'
    foreach ($file in Get-ChildItem -LiteralPath $wsRoot -Recurse -File) {
        $relative = $file.FullName.Substring($wsRoot.TrimEnd('\').Length + 1)
        Add-SourceFile $sourceZip $file.FullName ('third-party/ws/' + $relative)
    }
    foreach ($file in Get-ChildItem -LiteralPath $PSScriptRoot -File) { Add-SourceFile $sourceZip $file.FullName ('installer/' + $file.Name) }
    $instructions = @"
Source for Vencord $($package.version), commit $commit, with WinYandexMusicRPC.

To rebuild the desktop runtime from this archive, open PowerShell in Vencord/:
  pnpm install --frozen-lockfile
  `$env:VENCORD_HASH = '$($commit.Substring(0,8))'
  `$env:VENCORD_REMOTE = 'Vendicated/Vencord'
  pnpm build --dev --standalone --disable-updater

To rebuild the installer package from a Git checkout at that commit:
  powershell -File installer/Build-Package.ps1 -VencordPath PATH_TO_VENCORD -PluginPath PATH_TO_PLUGIN -OutputDirectory NEW_OUTPUT_FOLDER

Runtime tests for the plugin are in src/userplugins/winYandexMusicRPC.desktop/tests.
Installer transaction tests: installer/Test-Installer.ps1 -FixtureRoot NEW_EMPTY_TEST_FOLDER
The end user installing the prebuilt package does not need these developer tools.
"@
    $entry = $sourceZip.CreateEntry('REBUILD.txt')
    $writer = New-Object IO.StreamWriter($entry.Open(), (New-Object Text.UTF8Encoding($false)))
    try { $writer.Write($instructions) } finally { $writer.Dispose() }
} finally { $sourceZip.Dispose() }

$releaseZip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
try {
    $prefix = Split-Path -Leaf $output
    foreach ($file in Get-ChildItem -LiteralPath $output -Recurse -File) {
        $relative = $file.FullName.Substring($output.TrimEnd('\').Length + 1)
        Add-SourceFile $releaseZip $file.FullName ($prefix + '/' + $relative)
    }
} finally { $releaseZip.Dispose() }
Write-Output $zipPath
