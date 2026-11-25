$ErrorActionPreference = 'Stop'

Write-Host 'Embedding endpoint test'
Write-Host 'The API key input is hidden and is never written to disk.'
Write-Host ''

$defaultBaseUrl = 'https://api.siliconflow.cn/v1'
$defaultModel = 'BAAI/bge-m3'

$baseUrlInput = (Read-Host "Base URL [$defaultBaseUrl]").Trim()
$baseUrl = if ($baseUrlInput) { $baseUrlInput } else { $defaultBaseUrl }
if ($baseUrl.EndsWith('/embeddings')) {
    throw 'Base URL must not end with /embeddings.'
}

$modelInput = (Read-Host "Embedding model [$defaultModel]").Trim()
$model = if ($modelInput) { $modelInput } else { $defaultModel }
$secureKey = Read-Host 'API key (input hidden)' -AsSecureString
$key = [System.Net.NetworkCredential]::new('', $secureKey).Password
$url = $baseUrl.TrimEnd('/') + '/embeddings'

try {
    $headers = @{
        Authorization = "Bearer $key"
        'Content-Type' = 'application/json'
    }
    $body = @{
        model = $model
        input = @('hello world')
    } | ConvertTo-Json

    $response = Invoke-RestMethod `
        -Method Post `
        -Uri $url `
        -Headers $headers `
        -Body $body `
        -TimeoutSec 30

    if ($null -eq $response.data -or $response.data.Count -lt 1) {
        throw 'The response does not contain data[0].embedding.'
    }

    $dimension = @($response.data[0].embedding).Count
    if ($dimension -lt 1) {
        throw 'The returned embedding vector is empty.'
    }

    Write-Host ''
    Write-Host 'status=OK'
    Write-Host "vector_count=$(@($response.data).Count)"
    Write-Host "dimension=$dimension"
    Write-Host "model=$($response.model)"
}
catch {
    Write-Host ''
    Write-Host 'status=FAIL'
    Write-Host "url=$url"

    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode) {
        Write-Host "http_status=$statusCode"
    }
    Write-Host "message=$($_.Exception.Message)"
    exit 1
}
finally {
    Remove-Variable key, secureKey, headers, body, response -ErrorAction SilentlyContinue
}
