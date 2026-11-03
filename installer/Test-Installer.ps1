param([string]$FixtureRoot)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'InstallerCore.psm1') -Force -DisableNameChecking

function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Write-Fixture([string]$Directory, [string]$Label) {
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    foreach ($name in @('patcher.js', 'preload.js', 'renderer.js', 'renderer.css')) {
        [IO.File]::WriteAllText((Join-Path $Directory $name), ($Label + ' ' + $name), (New-Object Text.UTF8Encoding($false)))
    }
}
function Assert-Throws([scriptblock]$Code, [string]$Message) {
    $threw = $false
    try { & $Code | Out-Null } catch { $threw = $true }
    Assert $threw $Message
}

if (-not $FixtureRoot) { throw 'Укажите отдельную папку для тестовых файлов.' }
if (Test-Path -LiteralPath $FixtureRoot) { throw 'Тестовая папка уже существует. Выберите новую пустую папку.' }
$fixture = [IO.Path]::GetFullPath($FixtureRoot)
New-Item -ItemType Directory -Path $fixture | Out-Null
$root = Join-Path $fixture 'Тест с пробелами/Vencord'
$old = Join-Path $root 'dist'
$payload = Join-Path $fixture 'package/dist'
Write-Fixture $old 'original'
Write-Fixture $payload 'new'
$files = @(Get-RuntimeFiles $payload)
$oldFiles = @(Get-RuntimeFiles $old)
New-Item -ItemType Directory -Force -Path (Join-Path $root 'settings') | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'settings/settings.json'), '{"keep":"settings"}')
$settingsHash = (Get-FileHash -LiteralPath (Join-Path $root 'settings/settings.json')).Hash

$installed = Invoke-RuntimeSwap -VencordRoot $root -SourceDist $payload -Files $files
Assert $installed.Changed 'Install must replace the runtime'
Assert-RuntimeFiles (Join-Path $root 'dist') $files
Assert-RuntimeFiles (Join-Path $installed.Backup 'dist') $oldFiles
Assert ((Get-FileHash -LiteralPath (Join-Path $root 'settings/settings.json')).Hash -eq $settingsHash) 'Settings changed'
Write-Host 'PASS: install, full backup, Unicode/spaces and settings preservation'

$again = Invoke-RuntimeSwap -VencordRoot $root -SourceDist $payload -Files $files
Assert (-not $again.Changed) 'Same build should be a no-op'
Write-Host 'PASS: repeated install does not overwrite the backup'

$point = Get-LatestRestorePoint $root
$restored = Invoke-RuntimeSwap -VencordRoot $root -SourceDist $point.Directory -Files $point.Files -Kind restore
Assert $restored.Changed 'Restore did not run'
Assert-RuntimeFiles (Join-Path $root 'dist') $oldFiles
Assert ((Get-FileHash -LiteralPath (Join-Path $root 'settings/settings.json')).Hash -eq $settingsHash) 'Restore changed settings'
Write-Host 'PASS: restore recovers the exact previous runtime'

Assert-Throws { Invoke-RuntimeSwap -VencordRoot $root -SourceDist $payload -Files $files -AfterSwap { param($live) [IO.File]::WriteAllText((Join-Path $live 'renderer.js'), 'simulated antivirus/copy corruption') } } 'Post-install corruption must fail'
Assert-RuntimeFiles (Join-Path $root 'dist') $oldFiles
Write-Host 'PASS: a failed integrity check rolls back automatically'

[IO.File]::WriteAllText((Join-Path $payload 'renderer.js'), 'changed in transit')
Assert-Throws { Invoke-RuntimeSwap -VencordRoot $root -SourceDist $payload -Files $files } 'Corrupt payload must fail before replacing the runtime'
Assert-RuntimeFiles (Join-Path $root 'dist') $oldFiles
Write-Host 'PASS: corrupt package leaves the old installation intact'

Assert-Throws { Get-ChildPath $root '../outside' } 'Traversal must be rejected'
Assert-Throws { Assert-RuntimeFiles $old @([pscustomobject]@{ path='../outside'; size=1; sha256=('a' * 64) }) } 'Manifest traversal must be rejected'
Write-Host 'PASS: path traversal is rejected'

$local = Join-Path $fixture 'Local'
$client = Join-Path $local 'Discord'
$resources = Join-Path $client 'app-1.0.100/resources'
New-Item -ItemType Directory -Force -Path $resources | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $client 'app-1.0.99/resources') | Out-Null
[IO.File]::WriteAllText((Join-Path $client 'Update.exe'), 'test fixture, never executed')
$quote = '"' + ([IO.Path]::GetFullPath((Join-Path $root 'dist/patcher.js'))).Replace('\', '\\') + '"'
$asar = Join-Path $resources 'app.asar'
[IO.File]::WriteAllText($asar, ('require(' + $quote + ')'))
Assert (Test-DiscordTarget $asar $root) 'Correct patched target not recognized'
$clients = @(Get-DiscordClients $local $root)
Assert ($clients.Count -eq 1 -and $clients[0].Patched) 'Latest version must be chosen numerically'
Assert (-not (Test-DiscordTarget $asar ($root + '-other'))) 'Other checkout must be rejected'
[IO.File]::WriteAllText($asar, ('var readme=' + $quote + ';'))
Assert (-not (Test-DiscordTarget $asar $root)) 'Mentioning a path outside require() must not count'
Write-Host 'PASS: precise Discord target matching and numeric version selection'

$root2 = Join-Path $fixture 'second/Vencord'
$old2 = Join-Path $root2 'dist'
$payload2 = Join-Path $fixture 'second/package/dist'
Write-Fixture $old2 'older'
Write-Fixture $payload2 'latest'
$installed2 = Invoke-RuntimeSwap -VencordRoot $root2 -SourceDist $payload2 -Files @(Get-RuntimeFiles $payload2)
[IO.File]::WriteAllText((Join-Path $installed2.Backup 'dist/patcher.js'), 'corrupted backup')
Assert-Throws { Get-LatestRestorePoint $root2 } 'Corrupt backup must not be restored'
Assert-RuntimeFiles (Join-Path $root2 'dist') @(Get-RuntimeFiles $payload2)
Write-Host 'PASS: corrupt recovery copy is rejected without changing the live runtime'

try {
    $link = Join-Path $fixture 'linked'
    New-Item -ItemType Junction -Path $link -Target (Join-Path $root2 'dist') | Out-Null
    Assert-Throws { Get-RuntimeFiles $link } 'Junction must be rejected'
    Write-Host 'PASS: directory junctions are rejected'
} catch {
    if ($_.Exception.Message -eq 'Junction must be rejected') { throw }
    Write-Host ('SKIP: could not create test junction: ' + $_.Exception.Message)
}
Write-Host 'All installer tests passed.' -ForegroundColor Green
