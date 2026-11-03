param(
    [Parameter(Mandatory = $true)]
    [string]$VencordPath
)

$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath $VencordPath).Path
$taskManifest = Join-Path $taskRoot 'package.json'
if (-not (Test-Path -LiteralPath $taskManifest)) { throw 'В этой папке нет исходников Vencord (package.json).' }
$taskPackage = Get-Content -LiteralPath $taskManifest -Raw | ConvertFrom-Json
if ($taskPackage.name -ne 'vencord' -or -not (Test-Path -LiteralPath (Join-Path $taskRoot 'src/utils/types.ts'))) {
    throw 'Укажите корневую папку исходников Vencord.'
}
$taskSource = Join-Path (Split-Path -Parent $PSScriptRoot) 'winYandexMusicRPC.desktop'
$taskPlugins = Join-Path $taskRoot 'src/userplugins'
$taskDestination = Join-Path $taskPlugins 'winYandexMusicRPC.desktop'
if (Test-Path -LiteralPath $taskDestination) { throw "Плагин уже существует: $taskDestination. Сохраните старую версию перед заменой." }
New-Item -ItemType Directory -Force -Path $taskPlugins | Out-Null
Copy-Item -LiteralPath $taskSource -Destination $taskPlugins -Recurse
Write-Output "Плагин скопирован: $taskDestination"
Write-Output 'В корне Vencord выполните команды из README: добавление ws, сборка, затем pnpm inject.'
