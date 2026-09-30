param([switch]$Install)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$backendPath = Join-Path $projectRoot 'backend_node'
$frontendPath = Join-Path $projectRoot 'frontend'
$nodeVersion = & node -p 'Number(process.versions.node.split(".")[0])'
if ($LASTEXITCODE -ne 0 -or [int]$nodeVersion -lt 24) { throw 'Install Node.js 24 or newer first.' }
$envPath = Join-Path $backendPath '.env'
if (!(Test-Path $envPath)) {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $ownerAccessKey = [Convert]::ToBase64String($bytes)
    $template = [System.IO.File]::ReadAllText((Join-Path $backendPath '.env.example'))
    $template = $template.Replace('PORTAL_ADMIN_TOKEN=', 'PORTAL_ADMIN_TOKEN=' + $ownerAccessKey)
    [System.IO.File]::WriteAllText($envPath, $template)
    Write-Host 'Private configuration created. Copy the owner key from backend_node/.env into Connect workspace.'
}
if ($Install) {
    foreach ($directory in @($backendPath, $frontendPath)) {
        Push-Location $directory
        try { & npm.cmd ci; if ($LASTEXITCODE -ne 0) { throw "Installation failed in $directory" } }
        finally { Pop-Location }
    }
}
if (!(Test-Path (Join-Path $backendPath 'node_modules')) -or !(Test-Path (Join-Path $frontendPath 'node_modules'))) { throw 'Run with -Install first.' }
Start-Process -FilePath $env:ComSpec -ArgumentList '/k', 'npm.cmd start' -WorkingDirectory $backendPath
Start-Process -FilePath $env:ComSpec -ArgumentList '/k', 'npm.cmd run dev' -WorkingDirectory $frontendPath
Start-Process 'http://localhost:5173'
Write-Host 'World Smart Jobs started. Keep both terminal windows open for local automation.'
