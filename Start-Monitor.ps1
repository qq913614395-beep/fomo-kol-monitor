$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-SupportedNode([string]$Candidate) {
  if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { return $false }
  try {
    $rawVersion = (& $Candidate -p "process.versions.node" 2>$null)
    if ($LASTEXITCODE -ne 0) { return $false }
    $version = [version]$rawVersion
    return $version.Major -gt 22 -or ($version.Major -eq 22 -and $version.Minor -ge 13)
  } catch { return $false }
}

$candidates = [System.Collections.Generic.List[string]]::new()
if ($env:FOMO_NODE_PATH) { $candidates.Add($env:FOMO_NODE_PATH) }
$pathNode = Get-Command node -ErrorAction SilentlyContinue
if ($pathNode) { $candidates.Add($pathNode.Source) }
if ($env:USERPROFILE) {
  $candidates.Add((Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'))
}
$node = $candidates | Where-Object { Test-SupportedNode $_ } | Select-Object -First 1
if (-not $node) {
  throw 'FOMO Monitor requires Node.js 22.13 or newer. Install Node.js from https://nodejs.org/ or set FOMO_NODE_PATH to node.exe.'
}

if (-not (Test-Path -LiteralPath (Join-Path $projectDir '.env'))) {
  Copy-Item -LiteralPath (Join-Path $projectDir '.env.example') -Destination (Join-Path $projectDir '.env')
}

Set-Location -LiteralPath $projectDir
& $node (Join-Path $projectDir 'scripts\dev-all.mjs')
exit $LASTEXITCODE
