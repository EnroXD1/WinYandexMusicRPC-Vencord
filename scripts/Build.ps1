param(
    [string]$VencordPath,
    [switch]$Package,
    [switch]$SkipBuild,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$metadata = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$work = Join-Path $projectRoot 'work'
New-Item -ItemType Directory -Path $work -Force | Out-Null

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed: $Command (exit $LASTEXITCODE)" }
}

foreach ($command in @('git', 'node', 'pnpm')) { $null = Get-Command $command -ErrorAction Stop }
if ($Package -and $SkipBuild) { throw '-Package requires a runtime build.' }

if (-not $VencordPath) {
    $VencordPath = Join-Path $work 'Vencord'
    if (-not (Test-Path -LiteralPath $VencordPath)) {
        Invoke-Checked 'git' @('clone', '--depth', '1', $metadata.vencord.repository, $VencordPath)
    }
    $head = (& git -C $VencordPath rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the Vencord checkout.' }
    if ($head -ne $metadata.vencord.commit) {
        $changes = @(& git -C $VencordPath status --porcelain)
        if ($changes.Count -ne 0) { throw 'The working checkout has local changes. Use a clean checkout or supply -VencordPath.' }
        Invoke-Checked 'git' @('-C', $VencordPath, 'fetch', '--depth', '1', 'origin', $metadata.vencord.commit)
        Invoke-Checked 'git' @('-C', $VencordPath, 'checkout', '--detach', $metadata.vencord.commit)
    }
}

$VencordPath = (Resolve-Path -LiteralPath $VencordPath).Path
$vencordPackage = Get-Content -LiteralPath (Join-Path $VencordPath 'package.json') -Raw | ConvertFrom-Json
if ($vencordPackage.name -ne 'vencord') { throw 'The selected directory is not a Vencord checkout.' }
$plugins = Join-Path $VencordPath 'src/userplugins'
New-Item -ItemType Directory -Path $plugins -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'winYandexMusicRPC.desktop') -Destination $plugins -Recurse -Force
if ($Package) {
    $others = @(Get-ChildItem -LiteralPath $plugins -Force | Where-Object { $_.Name -ne 'winYandexMusicRPC.desktop' })
    if ($others.Count -gt 0) { throw 'Release packaging requires a checkout with only this userplugin. Use the isolated work/Vencord checkout.' }
}

Push-Location $VencordPath
try {
    if (-not $SkipInstall) {
        Invoke-Checked 'pnpm' @('install', '--frozen-lockfile')
        Invoke-Checked 'pnpm' @('add', '-w', 'ws@8.22.1')
        Invoke-Checked 'pnpm' @('add', '-Dw', '@types/ws@8.18.2')
    }
    $testFiles = @(Get-ChildItem -LiteralPath 'src/userplugins/winYandexMusicRPC.desktop/tests' -Filter '*.test.ts' -File | ForEach-Object { 'src/userplugins/winYandexMusicRPC.desktop/tests/' + $_.Name })
    if ($testFiles.Count -eq 0) { throw 'No plugin tests were found.' }
    Invoke-Checked 'pnpm' (@('exec', 'tsx', '--test') + $testFiles)
    Invoke-Checked 'pnpm' @('test:ts')
    Invoke-Checked 'pnpm' @('exec', 'eslint', 'src/userplugins/winYandexMusicRPC.desktop')
    foreach ($name in @('renderer', 'ynison', 'token')) {
        Invoke-Checked 'node' @((Join-Path $projectRoot ('validation/' + $name + '.cjs')), $VencordPath)
    }
    if (-not $SkipBuild) { Invoke-Checked 'pnpm' @('build', '--dev', '--standalone', '--disable-updater') }
} finally { Pop-Location }

& (Join-Path $projectRoot 'installer/Test-Installer.ps1') -FixtureRoot (Join-Path $work ('installer-test-' + [guid]::NewGuid().ToString('N')))
if ($Package) {
    $output = Join-Path $projectRoot ('out/WinYandexMusicRPC-Installer-' + $metadata.version)
    & (Join-Path $projectRoot 'installer/Build-Package.ps1') -VencordPath $VencordPath -PluginPath (Join-Path $projectRoot 'winYandexMusicRPC.desktop') -OutputDirectory $output -Version $metadata.version
    $zip = $output + '.zip'
    $checksum = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + (Split-Path -Leaf $zip)
    [IO.File]::WriteAllText($zip + '.sha256', $checksum + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    Write-Host ('Installer ready: ' + $zip) -ForegroundColor Green
}
