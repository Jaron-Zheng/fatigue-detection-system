[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$Port = 5180,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location -LiteralPath $root

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Node.js 18 or later is required. Install the LTS release from https://nodejs.org and run this script again.' -ForegroundColor Red
  exit 1
}

$version = (& $node.Source --version).Trim()
$major = [int](($version -replace '^v', '').Split('.')[0])
if ($major -lt 18) {
  Write-Host "Node.js 18 or later is required. Current version: $version" -ForegroundColor Red
  exit 1
}

$launchArgs = @('tools/launch.js', '--port', $Port)
if ($NoBrowser) { $launchArgs += '--no-open' }
& $node.Source @launchArgs
exit $LASTEXITCODE
