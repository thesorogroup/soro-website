$keyPath = Join-Path $env:USERPROFILE 'Desktop\soro-operations-import-6d5f880ef12a.json'

if (-not (Test-Path -LiteralPath $keyPath)) {
  throw "The downloaded Google key was not found on your Desktop."
}

[Convert]::ToBase64String([System.IO.File]::ReadAllBytes($keyPath)) | Set-Clipboard
Write-Host 'The Soro service-account key is now copied to your clipboard.'
