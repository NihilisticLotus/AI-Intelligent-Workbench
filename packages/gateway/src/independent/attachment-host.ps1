# 只读取数据库确认的上传身份；附件正文仅经本次私有管道回传，不写日志或事件。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -TypeDefinition ([IO.File]::ReadAllText($args[1], [Text.Encoding]::UTF8))
    $request = [IO.File]::ReadAllText($args[0], [Text.Encoding]::UTF8) | ConvertFrom-Json
    $blob = [AicFileGuard]::ReadAttachment([string]$request.dataDirectory, [string]$request.taskId, [string]$request.attachmentId, [string]$request.sha256, [long]$request.size, [int]$request.maxBytes)
    [Console]::WriteLine((@{ ok = $true; data = [Convert]::ToBase64String($blob.Bytes); hash = $blob.Hash } | ConvertTo-Json -Compress))
} catch {
    $reason = 'io_error'
    $message = $_.Exception.GetBaseException().Message
    if ($message -match '^aic_(forbidden|not_found|busy|conflict|too_large|io_error)$') { $reason = $Matches[1] }
    [Console]::WriteLine((@{ ok = $false; reason = $reason } | ConvertTo-Json -Compress))
}
