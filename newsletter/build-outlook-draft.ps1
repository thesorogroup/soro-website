param(
    [string]$HtmlPath = (Join-Path $PSScriptRoot 'va-welcome-website-live.html'),
    [string]$TextPath = (Join-Path $PSScriptRoot 'va-welcome-website-live.txt'),
    [string]$OutputPath = (Join-Path $PSScriptRoot 'Soro-VA-Welcome-Outlook-Draft.eml')
)

$utf8 = [System.Text.Encoding]::UTF8
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$crlf = "`r`n"
$boundary = 'soro-va-welcome-20260813'
$subject = 'Welcome to the Soro VA Community Newsletter 1st Edition! ' + [char]0x2014 + ' Our Website Is Live!'

$htmlBody = [System.IO.File]::ReadAllText($HtmlPath, $utf8)
$plainBody = [System.IO.File]::ReadAllText($TextPath, $utf8)

# The subject and preheader are metadata in the text companion, not part of the
# message body shown to recipients.
$plainBody = [System.Text.RegularExpressions.Regex]::Replace(
    $plainBody,
    '\ASubject:.*?\r?\nPreheader:.*?\r?\n\r?\n',
    '',
    [System.Text.RegularExpressions.RegexOptions]::Singleline
)

function ConvertTo-MimeBase64([string]$value) {
    return [System.Convert]::ToBase64String(
        $utf8.GetBytes($value),
        [System.Base64FormattingOptions]::InsertLineBreaks
    )
}

$encodedSubject = [System.Convert]::ToBase64String($utf8.GetBytes($subject))
$plainBase64 = ConvertTo-MimeBase64 $plainBody
$htmlBase64 = ConvertTo-MimeBase64 $htmlBody

$message = @(
    'X-Unsent: 1'
    'From: Soro Group Talent Team <talents@thesorogroup.com>'
    'Reply-To: talents@thesorogroup.com'
    'To:'
    "Subject: =?utf-8?B?${encodedSubject}?="
    'MIME-Version: 1.0'
    "Content-Type: multipart/alternative; boundary=`"$boundary`""
    ''
    "--$boundary"
    'Content-Type: text/plain; charset="utf-8"'
    'Content-Transfer-Encoding: base64'
    ''
    $plainBase64
    "--$boundary"
    'Content-Type: text/html; charset="utf-8"'
    'Content-Transfer-Encoding: base64'
    ''
    $htmlBase64
    "--$boundary--"
    ''
) -join $crlf

[System.IO.File]::WriteAllText($OutputPath, $message, $utf8NoBom)
Write-Output $OutputPath
