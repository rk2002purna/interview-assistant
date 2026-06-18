$metaPath = "C:\Users\Admin\.kiro\tasks\8030bcf985057e38\credits-and-subscription-system.meta.json"
$content = Get-Content $metaPath -Raw
$json = $content | ConvertFrom-Json

$inProgress = $json.tasks | Where-Object { $_.status -eq "in_progress" }
Write-Host "Found $($inProgress.Count) in_progress tasks:"
foreach ($t in $inProgress) {
    Write-Host "  - $($t.id)"
    $t.status = "completed"
}

$json | ConvertTo-Json -Depth 10 | Set-Content $metaPath -Encoding UTF8
Write-Host "Done - updated meta.json"
