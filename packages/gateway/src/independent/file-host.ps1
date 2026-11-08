# 请求文件由 Gateway 创建；正文不进入命令参数、日志或事件。仅执行固定的文件方法。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$guard = $null
try {
    Add-Type -TypeDefinition ([IO.File]::ReadAllText($args[1], [Text.Encoding]::UTF8))
    $request = [IO.File]::ReadAllText($args[0], [Text.Encoding]::UTF8) | ConvertFrom-Json
    $guard = New-Object AicFileGuard([string]$request.root, [string]$request.protectedRoot)
    switch ($request.operation) {
        'read' {
            $blob = $guard.ReadFile([string]$request.path)
            $result = @{ ok = $true; data = [Convert]::ToBase64String($blob.Bytes); hash = $blob.Hash; fileId = $blob.FileId }
        }
        'write' {
            $hash = $guard.WriteFile([string]$request.path, [string]$request.expectedHash, [Convert]::FromBase64String($request.data), [bool]$request.create, [bool]$request.createParents)
            $result = @{ ok = $true; hash = $hash }
        }
        'search' {
            $found = $guard.Search([string[]]$request.paths, [string]$request.query, [bool]$request.caseSensitive, [int]$request.maxMatches)
            $result = @{ ok = $true; found = $found }
        }
        'rules' {
            $items = New-Object System.Collections.Generic.List[object]
            $used = 0
            foreach ($relative in $request.paths) {
                try {
                    $blob = $guard.ReadFileWithin([string]$relative, (256 * 1024 - $used))
                    $used += $blob.Bytes.Length
                    $items.Add(@{ path = $relative; ok = $true; data = [Convert]::ToBase64String($blob.Bytes); hash = $blob.Hash; fileId = $blob.FileId })
                } catch {
                    $reason = 'io_error'
                    $message = $_.Exception.GetBaseException().Message
                    if ($message -match '^aic_(forbidden|not_found|busy|conflict|too_large|binary|io_error)$') { $reason = $Matches[1] }
                    $items.Add(@{ path = $relative; ok = $false; reason = $reason })
                }
            }
            $result = @{ ok = $true; items = @($items.ToArray()) }
        }
        default { throw 'aic_forbidden' }
    }
    [Console]::WriteLine(($result | ConvertTo-Json -Depth 8 -Compress))
} catch {
    $reason = 'io_error'
    $message = $_.Exception.GetBaseException().Message
    if ($message -match '^aic_(forbidden|not_found|busy|conflict|too_large|binary|io_error|interrupted)$') { $reason = $Matches[1] }
    [Console]::WriteLine((@{ ok = $false; reason = $reason } | ConvertTo-Json -Compress))
} finally {
    if ($null -ne $guard) { $guard.Dispose() }
}
