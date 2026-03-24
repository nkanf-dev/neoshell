$ports = 3000, 4000
$processIds = @()

foreach ($port in $ports) {
  $processIds += @(
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
}

$processIds = $processIds | Where-Object { $_ } | Select-Object -Unique

if (-not $processIds -or $processIds.Count -eq 0) {
  Write-Output "neoshell dev ports are already clear."
  exit 0
}

foreach ($processId in $processIds) {
  taskkill /PID $processId /T /F | Out-Null
}

Write-Output ("Stopped process tree(s): " + ($processIds -join ", "))
