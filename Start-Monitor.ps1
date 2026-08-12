$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundledNode = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node).Source }

if (-not (Test-Path -LiteralPath (Join-Path $projectDir '.env'))) {
  Copy-Item -LiteralPath (Join-Path $projectDir '.env.example') -Destination (Join-Path $projectDir '.env')
}

Set-Location -LiteralPath $projectDir
& $node (Join-Path $projectDir 'scripts\dev-all.mjs')

