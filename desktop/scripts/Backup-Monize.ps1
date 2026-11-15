<#
.SYNOPSIS
Makes a full copy of the Monize data folder on Windows, or puts one back.

.DESCRIPTION
A full backup is everything the Windows app keeps: the PostgreSQL database
(pgdata), attachments, the automatic backups folder, logs, config.json and
the key file Windows uses to unlock config.json (shell\Local State). It is
the whole instance, every user on it included, exactly as it was.

PostgreSQL's files are only consistent while the server is stopped, so the
script quits Monize first (Monize.exe --quit), checks that the database shut
down cleanly, copies the folder, checks the copy, and starts Monize again if
it was running.

A full backup restores only on the same Windows account that made it. The
passwords in config.json are locked to that account by Windows (DPAPI). On a
new PC or a new Windows account, install Monize, sign up, and restore an
in-app backup instead (Settings > Backup & Restore); the guide's Windows
page explains both.

Runs in Windows PowerShell 5.1 (built into Windows) and PowerShell 7.

.PARAMETER Destination
Backup mode: the folder to put the backup in. The backup is a new folder
inside it named Monize-backup-<date>-<time> (or a .zip with -Zip).

.PARAMETER Restore
Restore mode: a backup folder or .zip this script made. The current data
folder is renamed to <data folder>.before-restore-<date>-<time>, never
deleted, and the backup is copied in its place.

.PARAMETER Zip
Backup mode: write one .zip instead of a folder.

.PARAMETER DataDir
The Monize data folder. Default: the folder "Move data folder" recorded in
%LOCALAPPDATA%\Monize-location.ini, else %LOCALAPPDATA%\Monize.

.PARAMETER MonizeExe
Monize.exe. Default: %LOCALAPPDATA%\Programs\Monize\Monize.exe.

.PARAMETER NoRestart
Leave Monize closed afterwards.

.PARAMETER Force
Restore mode: restore a backup made under another Windows account or on
another PC anyway. Monize will not be able to unlock it; only for someone
who knows exactly why they are doing it.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\Backup-Monize.ps1 -Destination E:\MonizeBackups

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\Backup-Monize.ps1 -Destination E:\MonizeBackups -Zip

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\Backup-Monize.ps1 -Restore E:\MonizeBackups\Monize-backup-20261114-210000
#>
[CmdletBinding(DefaultParameterSetName = 'Backup')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Backup')]
    [string] $Destination,

    [Parameter(Mandatory = $true, ParameterSetName = 'Restore')]
    [string] $Restore,

    [Parameter(ParameterSetName = 'Backup')]
    [switch] $Zip,

    [string] $DataDir,

    [string] $MonizeExe,

    [switch] $NoRestart,

    [Parameter(ParameterSetName = 'Restore')]
    [switch] $Force
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$ManifestName = 'monize-backup.json'
# `--quit` waits up to 120 s for the running app to stop its database.
$QuitTimeoutSeconds = 150

# Stops the run. Raised as an exception so every `finally` below runs (the
# backup starts Monize again and removes its partial copy) before the
# message is printed and the script exits 1.
$script:Stopped = $null
function Fail([string] $Message) {
    $script:Stopped = $Message
    throw $Message
}

function Resolve-DataDir {
    if ($DataDir) { return [System.IO.Path]::GetFullPath($DataDir) }
    $pointer = Join-Path $env:LOCALAPPDATA 'Monize-location.ini'
    if (Test-Path -LiteralPath $pointer) {
        # UTF-16 with a byte-order mark, written by "Move data folder".
        foreach ($line in (Get-Content -LiteralPath $pointer -Encoding Unicode)) {
            if ($line -like 'dataDir=*') { return $line.Substring('dataDir='.Length) }
        }
        Fail "$pointer does not name a data folder. Pass -DataDir."
    }
    return (Join-Path $env:LOCALAPPDATA 'Monize')
}

function Resolve-MonizeExe {
    if ($MonizeExe) { return [System.IO.Path]::GetFullPath($MonizeExe) }
    return (Join-Path $env:LOCALAPPDATA 'Programs\Monize\Monize.exe')
}

function Get-MonizeProcess([string] $Exe) {
    $all = @(Get-Process -Name 'Monize' -ErrorAction SilentlyContinue)
    return @($all | Where-Object {
            try { $_.Path -ieq $Exe } catch { $false }
        })
}

function Stop-Monize([string] $Exe, [string] $Data) {
    Write-Host 'Closing Monize and stopping its database...'
    if (Test-Path -LiteralPath $Exe) {
        $process = Start-Process -FilePath $Exe -ArgumentList '--quit' -PassThru -WindowStyle Hidden
        if (-not $process.WaitForExit($QuitTimeoutSeconds * 1000)) {
            Fail "Monize.exe --quit did not finish within $QuitTimeoutSeconds seconds."
        }
        if ($process.ExitCode -ne 0) {
            Fail "Monize.exe --quit exited with $($process.ExitCode). Quit Monize from its tray icon and try again."
        }
    }
    elseif (@(Get-Process -Name 'Monize' -ErrorAction SilentlyContinue).Count -gt 0) {
        Fail "Monize is running but $Exe was not found. Pass -MonizeExe, or quit Monize from its tray icon first."
    }
    $deadline = (Get-Date).AddSeconds(20)
    while (@(Get-MonizeProcess $Exe).Count -gt 0 -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
    }
    if (@(Get-MonizeProcess $Exe).Count -gt 0) {
        Fail 'Monize is still running. Quit it from its tray icon and try again.'
    }
    # Present exactly while PostgreSQL has the database open: copying then
    # would give a backup that may not start.
    if (Test-Path -LiteralPath (Join-Path $Data 'pgdata\postmaster.pid')) {
        Fail 'The database did not shut down cleanly (pgdata\postmaster.pid is still there). Start Monize, quit it from the tray icon, and try again.'
    }
}

function Start-MonizeAgain([string] $Exe, [bool] $WasRunning) {
    if ($NoRestart -or -not $WasRunning) { return }
    if (Test-Path -LiteralPath $Exe) {
        Write-Host 'Starting Monize again...'
        Start-Process -FilePath $Exe | Out-Null
    }
}

# Every file under $Root that belongs in a full backup, as paths relative to
# it: the whole folder except the Chromium profile (only its key file,
# shell\Local State, is needed) and the markers "Move data folder" leaves.
function Get-BackupFile([string] $Root) {
    $prefix = $Root.TrimEnd('\') + '\'
    $files = Get-ChildItem -LiteralPath $Root -Recurse -File -Force
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($prefix.Length)
        if ($relative -like 'shell\*' -and $relative -ne 'shell\Local State') { continue }
        if ($relative -eq 'moved-elsewhere.json' -or $relative -eq '.monize-move') { continue }
        if ($relative -eq $ManifestName) { continue }
        [pscustomobject]@{ Relative = $relative; Length = $file.Length }
    }
}

function Copy-Tree([string] $From, [string] $To) {
    $files = @(Get-BackupFile $From)
    $total = ($files | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $total) { $total = 0 }
    $done = 0
    $count = 0
    foreach ($file in $files) {
        $target = Join-Path $To $file.Relative
        $parent = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        Copy-Item -LiteralPath (Join-Path $From $file.Relative) -Destination $target -Force
        $done += $file.Length
        $count += 1
        if ($count % 200 -eq 0) {
            $percent = 100
            if ($total -gt 0) { $percent = [int](100 * $done / $total) }
            Write-Progress -Activity 'Copying' -Status "$count of $($files.Count) files" -PercentComplete $percent
        }
    }
    Write-Progress -Activity 'Copying' -Completed
    return $files
}

# The copy has every file, at the same size.
function Assert-SameFiles([object[]] $Expected, [string] $Root) {
    $actual = @{}
    foreach ($file in @(Get-BackupFile $Root)) { $actual[$file.Relative] = $file.Length }
    foreach ($file in $Expected) {
        if (-not $actual.ContainsKey($file.Relative)) { Fail "The copy is missing $($file.Relative)." }
        if ($actual[$file.Relative] -ne $file.Length) { Fail "The copy of $($file.Relative) has a different size." }
    }
}

function Get-InstalledVersion([string] $Exe) {
    if (-not (Test-Path -LiteralPath $Exe)) { return $null }
    return (Get-Item -LiteralPath $Exe).VersionInfo.ProductVersion
}

try {
    $data = Resolve-DataDir
    $exe = Resolve-MonizeExe
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value

    if ($PSCmdlet.ParameterSetName -eq 'Backup') {
        if (-not (Test-Path -LiteralPath (Join-Path $data 'config.json'))) {
            Fail "$data has no config.json, so it is not a Monize data folder. Pass -DataDir."
        }
        $destRoot = [System.IO.Path]::GetFullPath($Destination)
        $dataFull = $data.TrimEnd('\') + '\'
        if (($destRoot.TrimEnd('\') + '\').StartsWith($dataFull, [System.StringComparison]::OrdinalIgnoreCase)) {
            Fail 'The destination is inside the data folder. Choose a folder elsewhere, ideally on another drive.'
        }
        $name = 'Monize-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
        $target = Join-Path $destRoot $name
        if ($Zip) { $staging = Join-Path $destRoot ".$name.partial" } else { $staging = "$target.partial" }

        $wasRunning = @(Get-MonizeProcess $exe).Count -gt 0
        Stop-Monize $exe $data
        if (-not (Test-Path -LiteralPath $destRoot)) { New-Item -ItemType Directory -Path $destRoot | Out-Null }
        $copied = $false
        try {
            Write-Host "Copying $data ..."
            $files = @(Copy-Tree $data $staging)
            Assert-SameFiles $files $staging
            $bytes = ($files | Measure-Object -Property Length -Sum).Sum
            if ($null -eq $bytes) { $bytes = 0 }
            $manifest = [ordered]@{
                format         = 1
                createdAt      = (Get-Date).ToUniversalTime().ToString('o')
                computer       = $env:COMPUTERNAME
                windowsUserSid = $sid
                dataDir        = $data
                monizeVersion  = Get-InstalledVersion $exe
                files          = $files.Count
                bytes          = $bytes
            }
            $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $staging $ManifestName) -Encoding UTF8
            $copied = $true
        }
        finally {
            Start-MonizeAgain $exe $wasRunning
            if (-not $copied -and (Test-Path -LiteralPath $staging)) {
                Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        if ($Zip) {
            Write-Host 'Compressing...'
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [System.IO.Compression.ZipFile]::CreateFromDirectory($staging, "$target.zip", [System.IO.Compression.CompressionLevel]::Optimal, $false)
            Remove-Item -LiteralPath $staging -Recurse -Force
            $target = "$target.zip"
        }
        else {
            Rename-Item -LiteralPath $staging -NewName $name
        }
        Write-Host ''
        Write-Host "Backup written: $target" -ForegroundColor Green
        Write-Host "$($files.Count) files, $([math]::Round($bytes / 1MB, 1)) MB."
        Write-Host 'It restores only under this Windows account. Keep your recovery key and in-app backups too.'
        return
    }

    # Restore
    $source = [System.IO.Path]::GetFullPath($Restore)
    if (-not (Test-Path -LiteralPath $source)) { Fail "$source does not exist." }
    $expanded = $null
    if ((Get-Item -LiteralPath $source) -is [System.IO.FileInfo]) {
        if ([System.IO.Path]::GetExtension($source) -ne '.zip') { Fail "$source is neither a backup folder nor a .zip." }
        $expanded = Join-Path ([System.IO.Path]::GetTempPath()) ('monize-restore-' + [guid]::NewGuid().ToString('N'))
        Write-Host 'Unpacking the .zip...'
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($source, $expanded)
        $source = $expanded
    }
    try {
        $manifestPath = Join-Path $source $ManifestName
        if (-not (Test-Path -LiteralPath $manifestPath)) { Fail "$source has no $ManifestName, so this script did not make it." }
        if (-not (Test-Path -LiteralPath (Join-Path $source 'config.json'))) { Fail "$source has no config.json." }
        if (-not (Test-Path -LiteralPath (Join-Path $source 'pgdata'))) { Fail "$source has no pgdata folder." }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($manifest.windowsUserSid -ne $sid -and -not $Force) {
            Fail ("This backup was made under another Windows account or on another PC ($($manifest.computer)). " +
                'Monize could not unlock it here. Install Monize, sign up, and restore an in-app backup instead ' +
                '(Settings > Backup & Restore). -Force restores it anyway.')
        }
        $installed = Get-InstalledVersion $exe
        if ($manifest.monizeVersion -and $installed -and $manifest.monizeVersion -ne $installed) {
            Write-Host "The backup was made with Monize $($manifest.monizeVersion); $installed is installed." -ForegroundColor Yellow
            Write-Host 'A newer Monize updates the restored database on its next start. An older one may refuse it.' -ForegroundColor Yellow
        }

        $expected = @(Get-BackupFile $source)
        if (Test-Path -LiteralPath $data) { Stop-Monize $exe $data }

        $kept = $null
        if (Test-Path -LiteralPath $data) {
            $kept = "$data.before-restore-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
            Write-Host "Keeping the current data folder as $kept"
            Rename-Item -LiteralPath $data -NewName (Split-Path -Leaf $kept)
        }
        Write-Host "Copying the backup to $data ..."
        try {
            $null = Copy-Tree $source $data
            Assert-SameFiles $expected $data
        }
        catch {
            if ($kept) {
                Fail ("$($_.Exception.Message) The data folder from before the restore is untouched at $kept; " +
                    "delete $data and rename it back to $(Split-Path -Leaf $data) to return to it.")
            }
            throw
        }
        # Started whether or not it was running: the person asked for this data.
        Start-MonizeAgain $exe $true
        Write-Host ''
        Write-Host "Restored $($manifest.createdAt) to $data" -ForegroundColor Green
        if ($kept) { Write-Host "The data folder it replaced is kept at $kept. Delete it once Monize works." }
        Write-Host 'Sign in again: the window''s saved sign-in is not part of a backup.'
    }
    finally {
        if ($expanded -and (Test-Path -LiteralPath $expanded)) { Remove-Item -LiteralPath $expanded -Recurse -Force }
    }
}
catch {
    Write-Host ''
    if ($script:Stopped) {
        Write-Host "Stopped: $script:Stopped" -ForegroundColor Red
    }
    else {
        Write-Host "Stopped by an unexpected error: $($_.Exception.Message)" -ForegroundColor Red
    }
    exit 1
}
