param(
    [string]$SourcePath = (Join-Path $PSScriptRoot 'va-welcome-website-live.html'),
    [string]$OutputPath = (Join-Path $PSScriptRoot 'va-welcome-power-automate-body.txt')
)

$utf8 = [System.Text.Encoding]::UTF8
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$source = [System.IO.File]::ReadAllText($SourcePath, $utf8)

$styleMatch = [System.Text.RegularExpressions.Regex]::Match(
    $source,
    '<style>(?<style>[\s\S]*?)</style>',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
)
$bodyMatch = [System.Text.RegularExpressions.Regex]::Match(
    $source,
    '<body\b[^>]*>(?<body>[\s\S]*?)</body>',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
)

if (-not $bodyMatch.Success) {
    throw 'The source newsletter does not contain an HTML body.'
}

$styleBlock = if ($styleMatch.Success) {
    '<style>' + $styleMatch.Groups['style'].Value + '</style>' + "`r`n"
} else {
    ''
}

$body = $bodyMatch.Groups['body'].Value.Trim()
$powerAutomateBody = $styleBlock + $body + "`r`n"

[System.IO.File]::WriteAllText($OutputPath, $powerAutomateBody, $utf8NoBom)
Write-Output $OutputPath
