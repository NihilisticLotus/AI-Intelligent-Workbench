# 只由工作区管理器调用；不接受命令，不向输出写路径、正文或系统异常。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$guard = $null
$completed = New-Object System.Collections.Generic.List[string]
try {
    Add-Type -TypeDefinition ([IO.File]::ReadAllText($args[1], [Text.Encoding]::UTF8))
    $request = [IO.File]::ReadAllText($args[0], [Text.Encoding]::UTF8) | ConvertFrom-Json
    $guard = New-Object AicFileGuard([string]$request.root, [string]$request.protectedRoot, [bool]$request.managed)
    foreach ($file in $request.files) {
        $guard.TransferFile([string]$file.path, [string]$file.expectedHash, [string]$file.source, [string]$file.sourceHash)
        $completed.Add([string]$file.path)
    }
    [Console]::WriteLine((@{ok=$true;files=@($completed.ToArray())}|ConvertTo-Json -Compress))
} catch {
    $reason = 'io_error'
    $message = $_.Exception.GetBaseException().Message
    if ($message -match '^aic_(forbidden|not_found|busy|conflict|io_error|interrupted)$') { $reason = $Matches[1] }
    [Console]::WriteLine((@{ok=$false;files=@($completed.ToArray());reason=$reason}|ConvertTo-Json -Compress))
} finally {
    if ($null -ne $guard) { $guard.Dispose() }
}
