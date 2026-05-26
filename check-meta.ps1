$metaPath = "C:\Users\Admin\.kiro\tasks\8030bcf985057e38\credits-and-subscription-system.meta.json"
$content = Get-Content $metaPath -Raw
$json = $content | ConvertFrom-Json

Write-Host "Total tasks in meta: $($json.tasks.Count)"
Write-Host ""
Write-Host "Status breakdown:"
$json.tasks | Group-Object -Property status | ForEach-Object { Write-Host "  $($_.Name): $($_.Count)" }
Write-Host ""
Write-Host "First 5 task IDs:"
$json.tasks[0..4] | ForEach-Object { Write-Host "  [$($_.status)] $($_.id)" }
Write-Host ""
Write-Host "Dependencies for task with '4.5' in id:"
$t = $json.tasks | Where-Object { $_.id -like "*4.5*" }
if ($t) { Write-Host "  ID: $($t.id)"; Write-Host "  Status: $($t.status)"; Write-Host "  Dependencies: $($t.dependencies -join ', ')" }
else { Write-Host "  Not found" }
