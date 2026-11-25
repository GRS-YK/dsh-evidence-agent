$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $repoRoot '.env'
$examplePath = Join-Path $repoRoot '.env.example'

if (-not (Test-Path $envPath)) {
    Copy-Item -LiteralPath $examplePath -Destination $envPath
    Write-Host 'Created .env from .env.example.'
}

$secureKey = Read-Host 'Paste the SiliconFlow API key (input hidden)' -AsSecureString
$key = ([System.Net.NetworkCredential]::new('', $secureKey).Password).Trim()

if (-not $key -or $key -eq 'replace_with_your_local_key') {
    throw 'No valid API key was entered.'
}
if ($key -match '\s') {
    throw 'The API key contains whitespace. Copy it again without spaces.'
}

try {
    $lines = @(Get-Content -LiteralPath $envPath -Encoding UTF8)
    $replacement = "EMBEDDING_API_KEY=$key"
    $found = $false

    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match '^\s*EMBEDDING_API_KEY\s*=') {
            $lines[$index] = $replacement
            $found = $true
            break
        }
    }

    if (-not $found) {
        $lines += $replacement
    }

    [IO.File]::WriteAllLines(
        $envPath,
        $lines,
        [Text.UTF8Encoding]::new($false)
    )

    Write-Host 'Saved EMBEDDING_API_KEY to local .env.'
    Write-Host 'The key was not printed and .env is ignored by Git.'
}
finally {
    Remove-Variable key, secureKey -ErrorAction SilentlyContinue
}
