#Requires -Version 7.2
<#
.SYNOPSIS
Installs the Monize Windows installer, runs the installed application, and
uninstalls it again, failing on the first thing that is not as documented.

.DESCRIPTION
The CI job desktop-windows (.github/workflows/ci.yml) runs this against the
installer it has just built; desktop/README.md ("CI") says how to run it by
hand. In order:

  1. The installer and its uninstaller ask for no elevation (their manifests
     say asInvoker), and a silent install (/S) lands in the per-user default,
     %LOCALAPPDATA%\Programs\Monize, registered under HKCU only.
  2. Monize.exe starts with MONIZE_DATA_DIR set to a fresh folder and
     MONIZE_INSECURE_SECRETS=1; the frontend answers /api/v1/health/live and
     then /api/v1/health/ready (which goes through to the backend and the
     database); config.json holds the expected ports and DPAPI-wrapped
     secrets; a user registers, reads the accounts list and their profile
     with the session cookies, and is refused without them.
  3. Everything the installation runs listens on 127.0.0.1 only (plan D4).
  4. `Monize.exe --quit` (same MONIZE_DATA_DIR) exits 0, leaves no process
     from the installation folder, and PostgreSQL's postmaster.pid is gone.
  5. A relaunch keeps the ports in config.json and the user can sign in.
  6. Killing the main Monize.exe hard ends the backend and the frontend by
     themselves and frees their ports while postgres.exe survives; the next
     launch stops that server, comes back on the same ports, and quits.
  7. A silent install into %LOCALAPPDATA%\Monize (/S /D=...) is refused.
  8. A silent uninstall keeps the data directory; `--remove-data` removes
     %LOCALAPPDATA%\Monize, checked only when this run created that folder.
     A %LOCALAPPDATA%\Monize that existed before the run is never removed.

It refuses to start when Monize is already installed for the current user.
On a failure it prints every exit code it collected, the tail of every file
under the data directory's logs and the processes still running from the
installation, stops whatever it started, uninstalls what it installed, keeps
the data directory for inspection, and exits 1.

.PARAMETER Installer
The Monize-Setup-<version>.exe to test. Default: the newest one in
desktop\release.

.PARAMETER DataDir
The MONIZE_DATA_DIR to run the application with. It must not exist yet, or be
empty. Default: a new folder under the temp directory. Removed after a pass.

.PARAMETER FrontendPort
The frontend port a first run on a machine with that port free persists in
config.json (src/ports.ts: DEFAULT_PORTS). Also BackendPort and PostgresPort.

.PARAMETER BootTimeoutSeconds
How long a launch may take to answer the readiness check.

.EXAMPLE
pwsh -NoProfile -File desktop\scripts\smoke-install.ps1 -Installer desktop\release\Monize-Setup-1.21.0.exe
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '', Justification = 'The output of this script is a CI log, not pipeline data.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSReviewUnusedParameter', '', Justification = 'The parameters are read by the functions below, through the script scope.')]
[CmdletBinding()]
param(
    [string] $Installer = '',
    [string] $DataDir = '',
    [ValidateRange(1024, 65535)] [int] $FrontendPort = 3380,
    [ValidateRange(1024, 65535)] [int] $BackendPort = 3381,
    [ValidateRange(1024, 65535)] [int] $PostgresPort = 5433,
    [ValidateRange(30, 1800)] [int] $BootTimeoutSeconds = 300
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# --- Bounds ----------------------------------------------------------------

# `--quit` gives up after 120 s itself (QUIT_WAIT_MS in src/shell/quit-wait.ts).
$QuitTimeoutSeconds = 150
$InstallerTimeoutSeconds = 600
# After `--quit` returns: Chromium's helper processes may take a moment.
$SettleSeconds = 15
# After the main process is killed: the children notice their stdin closing.
$OrphanExitSeconds = 30
$HttpTimeoutSeconds = 30
$LogTailLines = 80

# --- State -----------------------------------------------------------------

$script:ExitCodes = [System.Collections.Generic.List[string]]::new()
$script:Started = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$script:WeInstalled = $false
$script:Step = 'starting'

# --- Helpers ---------------------------------------------------------------

function Write-Step([string] $Message) {
    $script:Step = $Message
    Write-Host "==> $Message"
}

function Write-Detail([string] $Message) {
    Write-Host "    $Message"
}

function Assert-True([bool] $Condition, [string] $Message) {
    if (-not $Condition) {
        throw "ASSERTION FAILED: $Message"
    }
}

# Runs an executable to completion within a bound and returns its exit code.
# The arguments are one string because the NSIS switches /D= and _?= must be
# last and unquoted, even when the path holds a space.
function Invoke-Executable {
    param(
        [Parameter(Mandatory)] [string] $FilePath,
        [string] $Arguments = '',
        [Parameter(Mandatory)] [int] $TimeoutSeconds,
        [Parameter(Mandatory)] [string] $Label,
        [hashtable] $Environment = @{}
    )
    $info = [System.Diagnostics.ProcessStartInfo]::new($FilePath)
    $info.Arguments = $Arguments
    $info.UseShellExecute = $false
    $info.WorkingDirectory = [System.IO.Path]::GetTempPath()
    $null = $info.Environment.Remove('ELECTRON_RUN_AS_NODE')
    foreach ($name in $Environment.Keys) {
        $info.Environment[$name] = [string] $Environment[$name]
    }
    Write-Detail "run: `"$FilePath`" $Arguments"
    $process = [System.Diagnostics.Process]::Start($info)
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $process.Kill($true)
        $script:ExitCodes.Add("${Label}: timed out after ${TimeoutSeconds}s")
        throw "$Label did not finish within ${TimeoutSeconds}s"
    }
    $code = $process.ExitCode
    $script:ExitCodes.Add("${Label}: $code")
    Write-Detail "$Label exited with $code"
    return $code
}

function Get-InstallProcess([string] $InstallDir) {
    $prefix = $InstallDir.TrimEnd('\') + '\'
    return @(Get-CimInstance -ClassName Win32_Process | Where-Object {
            $null -ne $_.ExecutablePath -and
            $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
        })
}

function Format-InstallProcess([object[]] $Processes) {
    return @($Processes | Where-Object { $null -ne $_ } | ForEach-Object {
            $commandLine = [string] $_.CommandLine
            if ($commandLine.Length -gt 160) { $commandLine = $commandLine.Substring(0, 160) + '...' }
            "pid $($_.ProcessId) (parent $($_.ParentProcessId)) $($_.Name): $commandLine"
        })
}

function Test-ProcessAlive([int] $ProcessId) {
    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Get-ListeningPid([int] $Port) {
    return @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            ForEach-Object { [int] $_.OwningProcess } | Select-Object -Unique)
}

# Polls $Condition every half second until it returns $true. A launch that
# exits while being waited for fails at once rather than at the deadline.
function Wait-Until {
    param(
        [Parameter(Mandatory)] [scriptblock] $Condition,
        [Parameter(Mandatory)] [int] $TimeoutSeconds,
        [Parameter(Mandatory)] [string] $What,
        [System.Diagnostics.Process] $Watch = $null
    )
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
        if (& $Condition) {
            Write-Detail ("{0} after {1:N1}s" -f $What, $clock.Elapsed.TotalSeconds)
            return
        }
        if ($null -ne $Watch -and $Watch.HasExited) {
            throw "Monize.exe (pid $($Watch.Id)) exited with $($Watch.ExitCode) while waiting for: $What"
        }
        Start-Sleep -Milliseconds 500
    }
    throw "timed out after ${TimeoutSeconds}s waiting for: $What"
}

# One HTTP request; $null when nothing answered (connection refused, timeout).
function Invoke-Http {
    param(
        [Parameter(Mandatory)] [string] $Method,
        [Parameter(Mandatory)] [string] $Uri,
        [Microsoft.PowerShell.Commands.WebRequestSession] $Session = $null,
        [object] $Json = $null
    )
    $request = @{
        Method             = $Method
        Uri                = $Uri
        TimeoutSec         = $HttpTimeoutSeconds
        SkipHttpErrorCheck = $true
        NoProxy            = $true
    }
    if ($null -ne $Session) { $request.WebSession = $Session }
    if ($null -ne $Json) {
        $request.ContentType = 'application/json'
        $request.Body = ($Json | ConvertTo-Json -Compress)
    }
    try {
        return Invoke-WebRequest @request
    }
    catch [System.Net.Http.HttpRequestException], [System.Threading.Tasks.TaskCanceledException], [System.TimeoutException] {
        return $null
    }
}

function Test-Http200([string] $Uri) {
    try {
        $response = Invoke-Http -Method Get -Uri $Uri
        return $null -ne $response -and $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

# True while the process with this id is the one that started at $StartTime,
# so a reused process id does not pass for the original.
function Test-SameProcess([int] $ProcessId, [datetime] $StartTime) {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    return $null -ne $process -and $process.StartTime -eq $StartTime
}

function Assert-Status($Response, [int[]] $Expected, [string] $What) {
    Assert-True ($null -ne $Response) "$What`: no answer"
    $body = [string] $Response.Content
    if ($body.Length -gt 400) { $body = $body.Substring(0, 400) + '...' }
    Assert-True ($Expected -contains [int] $Response.StatusCode) "$What`: HTTP $($Response.StatusCode), expected $($Expected -join ' or '): $body"
}

function Get-CookieName([Microsoft.PowerShell.Commands.WebRequestSession] $Session, [string] $Origin) {
    return @($Session.Cookies.GetCookies([Uri] $Origin) | ForEach-Object { $_.Name })
}

function Read-AppConfig([string] $Path) {
    return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

# The requestedExecutionLevel values in a PE file's manifest. The manifest is
# a resource of the NSIS stub, so it lies near the start, ahead of the payload.
function Get-ExecutionLevel([string] $Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $length = [int] [Math]::Min($stream.Length, 8MB)
        $buffer = [byte[]]::new($length)
        $read = 0
        while ($read -lt $length) {
            $count = $stream.Read($buffer, $read, $length - $read)
            if ($count -le 0) { break }
            $read += $count
        }
    }
    finally {
        $stream.Dispose()
    }
    $text = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
    return @([regex]::Matches($text, 'requestedExecutionLevel\s+level\s*=\s*"(\w+)"') |
            ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
}

function Get-UninstallEntry([string] $Root) {
    if (-not (Test-Path -LiteralPath $Root)) { return @() }
    return @(Get-ChildItem -LiteralPath $Root -ErrorAction SilentlyContinue | ForEach-Object {
            $properties = Get-ItemProperty -LiteralPath $_.PSPath
            $display = $properties.PSObject.Properties['DisplayName']
            if ($null -ne $display -and $display.Value -eq 'Monize') { $properties }
        })
}

function Get-UninstallValue($Entry, [string] $Name) {
    $property = $Entry.PSObject.Properties[$Name]
    if ($null -eq $property) { return '' }
    return [string] $property.Value
}

$UserUninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$MachineUninstallRoots = @(
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)

function Show-FailureReport {
    Write-Host ''
    Write-Host "Failed at: $script:Step"
    Write-Host 'Exit codes collected:'
    foreach ($line in $script:ExitCodes) { Write-Host "  $line" }
    if ($null -ne $script:InstallDir -and (Test-Path -LiteralPath $script:InstallDir)) {
        Write-Host "Processes running from ${script:InstallDir}:"
        foreach ($line in (Format-InstallProcess (Get-InstallProcess $script:InstallDir))) { Write-Host "  $line" }
    }
    $logs = Join-Path $DataDir 'logs'
    if (Test-Path -LiteralPath $logs) {
        foreach ($file in (Get-ChildItem -LiteralPath $logs -File -Recurse | Sort-Object -Property FullName)) {
            Write-Host ''
            Write-Host "----- $($file.FullName) (last $LogTailLines lines) -----"
            foreach ($line in (Get-Content -LiteralPath $file.FullName -Tail $LogTailLines)) { Write-Host $line }
        }
    }
    else {
        Write-Host "No logs directory at $logs"
    }
    Write-Host ''
    Write-Host "The data directory is kept for inspection: $DataDir"
}

# Stops everything this run started and removes what it installed. Never
# throws: it runs after a failure, whose message matters more.
function Invoke-Cleanup {
    $exe = Join-Path $script:InstallDir 'Monize.exe'
    try {
        $running = @($script:Started | Where-Object { -not $_.HasExited })
        if ($running.Count -gt 0 -and (Test-Path -LiteralPath $exe)) {
            $null = Invoke-Executable -FilePath $exe -Arguments '--quit' -TimeoutSeconds $QuitTimeoutSeconds -Label 'cleanup: Monize.exe --quit' -Environment $script:AppEnvironment
        }
    }
    catch {
        Write-Host "cleanup: --quit failed: $($_.Exception.Message)"
    }
    foreach ($process in $script:Started) {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    if ($script:WeInstalled -and (Test-Path -LiteralPath $script:InstallDir)) {
        foreach ($leftover in (Get-InstallProcess $script:InstallDir)) {
            Stop-Process -Id $leftover.ProcessId -Force -ErrorAction SilentlyContinue
        }
        $uninstaller = Join-Path $script:InstallDir 'Uninstall Monize.exe'
        if (Test-Path -LiteralPath $uninstaller) {
            try {
                $null = Invoke-Executable -FilePath $uninstaller -Arguments "/currentuser /S _?=$script:InstallDir" -TimeoutSeconds $InstallerTimeoutSeconds -Label 'cleanup: uninstall'
            }
            catch {
                Write-Host "cleanup: uninstall failed: $($_.Exception.Message)"
            }
        }
        Remove-Item -LiteralPath $script:InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# --- Steps -----------------------------------------------------------------

function Invoke-MonizeLaunch {
    $info = [System.Diagnostics.ProcessStartInfo]::new($script:Exe)
    $info.UseShellExecute = $false
    $info.WorkingDirectory = $script:InstallDir
    $null = $info.Environment.Remove('ELECTRON_RUN_AS_NODE')
    foreach ($name in $script:AppEnvironment.Keys) {
        $info.Environment[$name] = [string] $script:AppEnvironment[$name]
    }
    $process = [System.Diagnostics.Process]::Start($info)
    $script:Started.Add($process)
    Write-Detail "Monize.exe started, pid $($process.Id)"
    return $process
}

# Waits for config.json and the readiness check, and returns the ports. The
# ports are read again on every poll: a launch that had to move a busy port
# rewrites config.json, and the wait then follows it.
function Wait-Ready([System.Diagnostics.Process] $Main) {
    $config = Join-Path $DataDir 'config.json'
    Wait-Until -What 'config.json written' -TimeoutSeconds $BootTimeoutSeconds -Watch $Main -Condition {
        Test-Path -LiteralPath $config
    }
    foreach ($check in @('live', 'ready')) {
        Wait-Until -What "the frontend answering /api/v1/health/$check" -TimeoutSeconds $BootTimeoutSeconds -Watch $Main -Condition {
            $current = (Read-AppConfig $config).ports
            Test-Http200 "http://127.0.0.1:$($current.frontend)/api/v1/health/$check"
        }
    }
    return (Read-AppConfig $config).ports
}

function Assert-PersistedPort($Ports, [string] $When) {
    Assert-True ($Ports.frontend -eq $FrontendPort -and $Ports.backend -eq $BackendPort -and $Ports.postgres -eq $PostgresPort) `
        "$When`: config.json holds ports frontend=$($Ports.frontend) backend=$($Ports.backend) postgres=$($Ports.postgres), expected $FrontendPort/$BackendPort/$PostgresPort (a port busy on this machine moves; pass -FrontendPort, -BackendPort and -PostgresPort to match)"
}

function Invoke-SignIn {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'Password', Justification = 'A throwaway password generated for a throwaway user, sent as JSON.')]
    param([string] $Origin, [string] $Email, [string] $Password)
    $session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $response = Invoke-Http -Method Post -Uri "$Origin/api/v1/auth/login" -Session $session -Json @{ email = $Email; password = $Password }
    Assert-Status -Response $response -Expected @(200, 201) -What 'POST /api/v1/auth/login'
    $body = $response.Content | ConvertFrom-Json
    Assert-True ($null -ne $body.PSObject.Properties['user']) "login answered without a user (2FA or email verification?): $($response.Content)"
    Assert-True (@(Get-CookieName $session $Origin) -contains 'auth_token') 'login set no auth_token cookie'
    return $session
}

function Assert-Profile([string] $Origin, [Microsoft.PowerShell.Commands.WebRequestSession] $Session, [string] $Email) {
    $profileResponse = Invoke-Http -Method Get -Uri "$Origin/api/v1/auth/profile" -Session $Session
    Assert-Status -Response $profileResponse -Expected @(200) -What 'GET /api/v1/auth/profile'
    $userProfile = $profileResponse.Content | ConvertFrom-Json
    Assert-True ($userProfile.email -eq $Email) "profile email is '$($userProfile.email)', expected '$Email'"
    $accounts = Invoke-Http -Method Get -Uri "$Origin/api/v1/accounts" -Session $Session
    Assert-Status -Response $accounts -Expected @(200) -What 'GET /api/v1/accounts'
    Assert-True ($accounts.Content.TrimStart().StartsWith('[')) "GET /api/v1/accounts is not a JSON array: $($accounts.Content)"
}

function Invoke-Quit([string] $When) {
    $code = Invoke-Executable -FilePath $script:Exe -Arguments '--quit' -TimeoutSeconds $QuitTimeoutSeconds -Label "Monize.exe --quit ($When)" -Environment $script:AppEnvironment
    Assert-True ($code -eq 0) "Monize.exe --quit ($When) exited with $code (3 means it gave up waiting for the running shell)"
    foreach ($process in $script:Started) {
        if (-not $process.HasExited) {
            Assert-True ($process.WaitForExit(10000)) "Monize.exe pid $($process.Id) is still running after --quit returned"
        }
    }
    try {
        Wait-Until -What 'no process left in the installation folder' -TimeoutSeconds $SettleSeconds -Condition {
            @(Get-InstallProcess $script:InstallDir).Count -eq 0
        }
    }
    catch {
        throw "after --quit ($When), still running: $((Format-InstallProcess (Get-InstallProcess $script:InstallDir)) -join '; ')"
    }
    $pidFile = Join-Path $DataDir 'pgdata\postmaster.pid'
    Assert-True (-not (Test-Path -LiteralPath $pidFile)) "pgdata\postmaster.pid still exists after --quit ($When): PostgreSQL was not shut down cleanly"
}

function Assert-LoopbackOnly($Ports) {
    $pids = @(Get-InstallProcess $script:InstallDir | ForEach-Object { [int] $_.ProcessId })
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $pids -contains [int] $_.OwningProcess })
    foreach ($listener in $listeners) {
        Write-Detail "listening: $($listener.LocalAddress):$($listener.LocalPort) (pid $($listener.OwningProcess))"
    }
    $listening = @($listeners | ForEach-Object { [int] $_.LocalPort })
    foreach ($port in @($Ports.frontend, $Ports.backend, $Ports.postgres)) {
        Assert-True ($listening -contains [int] $port) "nothing from the installation listens on port $port"
    }
    $exposed = @($listeners | Where-Object { $_.LocalAddress -ne '127.0.0.1' })
    Assert-True ($exposed.Count -eq 0) "listening beyond 127.0.0.1 (plan D4): $(($exposed | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort) pid $($_.OwningProcess)" }) -join ', ')"
}

function Assert-DataIntact([string] $When) {
    Assert-True (Test-Path -LiteralPath (Join-Path $DataDir 'pgdata\PG_VERSION')) "$When`: $DataDir\pgdata is gone"
    Assert-True (Test-Path -LiteralPath (Join-Path $DataDir 'config.json')) "$When`: $DataDir\config.json is gone"
}

function Invoke-Uninstall([string] $Switches, [string] $Label) {
    $uninstaller = Join-Path $script:InstallDir 'Uninstall Monize.exe'
    Assert-True (Test-Path -LiteralPath $uninstaller) "$uninstaller is missing"
    # The switches of the HKCU entry's QuietUninstallString, plus _?=, which
    # keeps the uninstaller from copying itself to %TEMP% and returning at
    # once, so its exit code is the uninstall's. It also means the
    # uninstaller cannot delete itself; that one file is removed below.
    $code = Invoke-Executable -FilePath $uninstaller -Arguments "$Switches _?=$script:InstallDir" -TimeoutSeconds $InstallerTimeoutSeconds -Label $Label
    Assert-True ($code -eq 0) "$Label exited with $code"
    Assert-True (-not (Test-Path -LiteralPath $script:Exe)) "$Label left $script:Exe behind"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $script:InstallDir 'resources'))) "$Label left the resources folder behind"
    Assert-True (@(Get-UninstallEntry $UserUninstallRoot).Count -eq 0) "$Label left the HKCU uninstall entry behind"
    Remove-Item -LiteralPath $script:InstallDir -Recurse -Force
    $script:WeInstalled = $false
}

function Invoke-Install([string] $Label) {
    $code = Invoke-Executable -FilePath $Installer -Arguments '/S' -TimeoutSeconds $InstallerTimeoutSeconds -Label $Label
    $script:WeInstalled = $true
    Assert-True ($code -eq 0) "$Label exited with $code"
    Assert-True (Test-Path -LiteralPath $script:Exe) "$Label did not create $script:Exe (the per-user default)"
}

# --- Preconditions ---------------------------------------------------------

if (-not $IsWindows) {
    Write-Host 'smoke-install.ps1 runs on Windows only.'
    exit 2
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    Write-Host 'LOCALAPPDATA is not set.'
    exit 2
}

if ($Installer -eq '') {
    $release = Join-Path (Split-Path -Parent $PSScriptRoot) 'release'
    $newest = @(Get-ChildItem -Path $release -Filter 'Monize-Setup-*.exe' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Extension -ieq '.exe' } | Sort-Object -Property LastWriteTime -Descending | Select-Object -First 1)
    if ($newest.Count -eq 0) {
        Write-Host "No Monize-Setup-*.exe in $release; build one with npm run dist or pass -Installer."
        exit 2
    }
    $Installer = $newest[0].FullName
}
$Installer = (Resolve-Path -LiteralPath $Installer).ProviderPath

$script:InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Monize'
$script:Exe = Join-Path $script:InstallDir 'Monize.exe'
$script:UninstallCommand = '"' + (Join-Path $script:InstallDir 'Uninstall Monize.exe') + '"'
$DefaultDataDir = Join-Path $env:LOCALAPPDATA 'Monize'
$DefaultDataPreexisted = Test-Path -LiteralPath $DefaultDataDir

if ((Test-Path -LiteralPath $script:InstallDir) -or @(Get-UninstallEntry $UserUninstallRoot).Count -gt 0) {
    Write-Host "Monize is already installed for this user ($script:InstallDir). This script installs and uninstalls it; uninstall it first."
    exit 2
}

if ($DataDir -eq '') {
    $DataDir = Join-Path ([System.IO.Path]::GetTempPath()) "monize smoke $([System.Guid]::NewGuid().ToString('N').Substring(0, 8))"
}
$DataDir = [System.IO.Path]::GetFullPath($DataDir)
if (Test-Path -LiteralPath $DataDir) {
    if (@(Get-ChildItem -LiteralPath $DataDir -Force).Count -gt 0) {
        Write-Host "The data directory $DataDir is not empty; the smoke test needs a fresh one."
        exit 2
    }
}
$script:AppEnvironment = @{
    MONIZE_DATA_DIR         = $DataDir
    MONIZE_INSECURE_SECRETS = '1'
}

Write-Host "Installer:      $Installer"
Write-Host "Install folder: $script:InstallDir"
Write-Host "Data folder:    $DataDir"
Write-Host "Default data:   $DefaultDataDir (existed before this run: $DefaultDataPreexisted)"

# --- The run ---------------------------------------------------------------

$failed = $false
try {
    Write-Step 'The installer asks for no elevation'
    $levels = @(Get-ExecutionLevel $Installer)
    Assert-True (($levels.Count -eq 1) -and ($levels[0] -eq 'asInvoker')) "the installer's manifest requests '$($levels -join ', ')', expected asInvoker"

    Write-Step 'Silent install into the per-user default'
    Invoke-Install 'install (/S)'
    foreach ($relative in @(
            'Uninstall Monize.exe',
            'resources\backend\dist\main.js',
            'resources\frontend\server.js',
            'resources\postgres\bin\postgres.exe',
            'resources\postgres\bin\pg_ctl.exe',
            'resources\postgres\bin\vcruntime140.dll',
            'resources\postgres\bin\vcruntime140_1.dll',
            'resources\postgres\bin\msvcp140.dll',
            'resources\shell\parent-watch.cjs')) {
        Assert-True (Test-Path -LiteralPath (Join-Path $script:InstallDir $relative)) "the installation has no $relative"
    }
    $webp = @(Get-ChildItem -LiteralPath (Join-Path $script:InstallDir 'resources\backend\help\images') -Filter '*.webp' -File -ErrorAction SilentlyContinue)
    Assert-True ($webp.Count -gt 0) 'the installation carries no WebP help screenshots (was cwebp on PATH when it was staged?)'
    $uninstallerLevels = @(Get-ExecutionLevel (Join-Path $script:InstallDir 'Uninstall Monize.exe'))
    Assert-True (($uninstallerLevels.Count -eq 1) -and ($uninstallerLevels[0] -eq 'asInvoker')) "the uninstaller's manifest requests '$($uninstallerLevels -join ', ')', expected asInvoker"
    $entries = @(Get-UninstallEntry $UserUninstallRoot)
    Assert-True ($entries.Count -eq 1) "expected one HKCU uninstall entry named Monize, found $($entries.Count)"
    $uninstallString = Get-UninstallValue $entries[0] 'UninstallString'
    Assert-True ($uninstallString.StartsWith($script:UninstallCommand, [System.StringComparison]::OrdinalIgnoreCase)) "the HKCU uninstall entry's UninstallString is '$uninstallString', expected it to start with $script:UninstallCommand"
    foreach ($root in $MachineUninstallRoots) {
        Assert-True (@(Get-UninstallEntry $root).Count -eq 0) "a per-machine uninstall entry named Monize exists under $root"
    }

    Write-Step 'First launch'
    $main = Invoke-MonizeLaunch
    $ports = Wait-Ready $main
    Assert-PersistedPort $ports 'first launch'
    $origin = "http://127.0.0.1:$($ports.frontend)"
    $config = Read-AppConfig (Join-Path $DataDir 'config.json')
    foreach ($name in @('jwtSecret', 'encryptionKey', 'databasePassword')) {
        Assert-True ($config.secrets.$name.enc -eq 'safeStorage') "config.json stores $name as '$($config.secrets.$name.enc)', expected DPAPI (safeStorage)"
    }

    Write-Step 'Register a user and read authenticated routes as that user'
    $email = "smoke-$([System.Guid]::NewGuid().ToString('N').Substring(0, 12))@example.com"
    $password = "Smoke-$([Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(12)))-a1!"
    $session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $register = Invoke-Http -Method Post -Uri "$origin/api/v1/auth/register" -Session $session -Json @{ email = $email; password = $password; firstName = 'Smoke' }
    Assert-Status -Response $register -Expected @(200, 201) -What 'POST /api/v1/auth/register'
    $registered = $register.Content | ConvertFrom-Json
    Assert-True ($null -ne $registered.PSObject.Properties['user']) "registration answered without a user (email verification required?): $($register.Content)"
    $cookies = @(Get-CookieName $session $origin)
    foreach ($cookie in @('auth_token', 'refresh_token', 'csrf_token')) {
        Assert-True ($cookies -contains $cookie) "registration set no $cookie cookie (set: $($cookies -join ', '))"
    }
    Assert-Profile -Origin $origin -Session $session -Email $email
    $anonymous = Invoke-Http -Method Get -Uri "$origin/api/v1/accounts"
    Assert-Status -Response $anonymous -Expected @(401) -What 'GET /api/v1/accounts without cookies'

    Write-Step 'Every listener is on 127.0.0.1 (plan D4)'
    Assert-LoopbackOnly $ports

    Write-Step 'Quit with Monize.exe --quit'
    Invoke-Quit 'first launch'
    foreach ($port in @($ports.frontend, $ports.backend, $ports.postgres)) {
        Assert-True (@(Get-ListeningPid $port).Count -eq 0) "port $port is still listening after --quit"
    }

    Write-Step 'Relaunch: same ports, the same user signs in'
    $main = Invoke-MonizeLaunch
    $relaunchPorts = Wait-Ready $main
    Assert-PersistedPort $relaunchPorts 'relaunch'
    $session = Invoke-SignIn -Origin $origin -Email $email -Password $password
    Assert-Profile -Origin $origin -Session $session -Email $email

    Write-Step 'Kill the main process hard: the children follow, PostgreSQL stays'
    $backendPids = @(Get-ListeningPid $relaunchPorts.backend)
    $frontendPids = @(Get-ListeningPid $relaunchPorts.frontend)
    $postgresPids = @(Get-ListeningPid $relaunchPorts.postgres)
    Assert-True ($backendPids.Count -eq 1 -and $frontendPids.Count -eq 1 -and $postgresPids.Count -eq 1) `
        "expected one listener per port, found backend=$($backendPids -join ',') frontend=$($frontendPids -join ',') postgres=$($postgresPids -join ',')"
    $children = @($backendPids[0], $frontendPids[0])
    $postmaster = $postgresPids[0]
    $postmasterStart = (Get-Process -Id $postmaster).StartTime
    Assert-True ($children -notcontains $main.Id) 'the main process itself owns the backend or frontend port'
    Write-Detail "main $($main.Id), backend $($backendPids[0]), frontend $($frontendPids[0]), postgres $postmaster"
    Stop-Process -Id $main.Id -Force
    Assert-True ($main.WaitForExit(10000)) "Monize.exe pid $($main.Id) survived Stop-Process -Force"
    Wait-Until -What 'the backend and frontend exited and freed their ports' -TimeoutSeconds $OrphanExitSeconds -Condition {
        @($children | Where-Object { Test-ProcessAlive $_ }).Count -eq 0 -and
        @(Get-ListeningPid $relaunchPorts.backend).Count -eq 0 -and
        @(Get-ListeningPid $relaunchPorts.frontend).Count -eq 0
    }
    try {
        Wait-Until -What 'no Monize.exe left in the installation folder' -TimeoutSeconds $SettleSeconds -Condition {
            @(Get-InstallProcess $script:InstallDir | Where-Object { $_.Name -ieq 'Monize.exe' }).Count -eq 0
        }
    }
    catch {
        throw "after the kill, still running: $((Format-InstallProcess (Get-InstallProcess $script:InstallDir)) -join '; ')"
    }
    Assert-True (Test-SameProcess $postmaster $postmasterStart) "postgres.exe pid $postmaster did not survive the kill: the leftover-server path is not exercised"
    Assert-True (@(Get-ListeningPid $relaunchPorts.postgres) -contains $postmaster) "postgres.exe pid $postmaster stopped listening on $($relaunchPorts.postgres)"

    Write-Step 'Relaunch after the kill: the leftover server is stopped, same ports'
    $main = Invoke-MonizeLaunch
    $recoveredPorts = Wait-Ready $main
    Assert-PersistedPort $recoveredPorts 'relaunch after the kill'
    Assert-True (-not (Test-SameProcess $postmaster $postmasterStart)) "the leftover postgres.exe pid $postmaster is still running after the relaunch"
    $session = Invoke-SignIn -Origin $origin -Email $email -Password $password
    Assert-Profile -Origin $origin -Session $session -Email $email
    Invoke-Quit 'relaunch after the kill'

    Write-Step 'A silent install into the data folder is refused'
    $refused = @("$DefaultDataDir\smoke-refusal")
    if (-not $DefaultDataPreexisted) { $refused = @($DefaultDataDir) + $refused }
    foreach ($target in $refused) {
        $existedBefore = Test-Path -LiteralPath (Join-Path $target 'Monize.exe')
        $code = Invoke-Executable -FilePath $Installer -Arguments "/S /D=$target" -TimeoutSeconds $InstallerTimeoutSeconds -Label "install (/S /D=$target)"
        Assert-True ($code -ne 0) "a silent install into $target exited 0"
        Assert-True ($existedBefore -or -not (Test-Path -LiteralPath (Join-Path $target 'Monize.exe'))) "a refused install still wrote $target\Monize.exe"
    }
    Assert-True (Test-Path -LiteralPath $script:Exe) 'a refused install removed the existing installation'
    $entries = @(Get-UninstallEntry $UserUninstallRoot)
    $uninstallString = if ($entries.Count -eq 1) { Get-UninstallValue $entries[0] 'UninstallString' } else { '' }
    Assert-True ($uninstallString.StartsWith($script:UninstallCommand, [System.StringComparison]::OrdinalIgnoreCase)) "a refused install changed the HKCU uninstall entry (UninstallString '$uninstallString')"

    Write-Step 'Silent uninstall keeps the data'
    Invoke-Uninstall '/currentuser /S' 'uninstall (/currentuser /S)'
    Assert-DataIntact 'after the uninstall'
    if ($DefaultDataPreexisted) {
        Assert-True (Test-Path -LiteralPath $DefaultDataDir) "the uninstall removed $DefaultDataDir"
    }

    Write-Step 'Silent uninstall with --remove-data'
    if ($DefaultDataPreexisted) {
        if ($env:GITHUB_ACTIONS -eq 'true') {
            throw "$DefaultDataDir existed before the run on a CI runner, so --remove-data cannot be checked"
        }
        Write-Host "    SKIPPED: $DefaultDataDir existed before this run and is never removed by it."
    }
    else {
        Invoke-Install 'reinstall (/S)'
        $null = New-Item -ItemType Directory -Path $DefaultDataDir -Force
        Set-Content -LiteralPath (Join-Path $DefaultDataDir 'smoke-marker.txt') -Value 'created by desktop/scripts/smoke-install.ps1'
        Invoke-Uninstall '/currentuser /S --remove-data' 'uninstall (/currentuser /S --remove-data)'
        Assert-True (-not (Test-Path -LiteralPath $DefaultDataDir)) "uninstall --remove-data left $DefaultDataDir behind"
        Assert-DataIntact 'after uninstall --remove-data (MONIZE_DATA_DIR is never removed)'
    }

    Write-Host ''
    Write-Host 'Smoke test passed. Exit codes:'
    foreach ($line in $script:ExitCodes) { Write-Host "  $line" }
}
catch {
    $failed = $true
    Write-Host ''
    Write-Host "SMOKE TEST FAILED: $($_.Exception.Message)"
    Write-Host $_.ScriptStackTrace
    try { Show-FailureReport } catch { Write-Host "diagnostics failed: $($_.Exception.Message)" }
}
finally {
    Invoke-Cleanup
}

if ($failed) {
    exit 1
}
Remove-Item -LiteralPath $DataDir -Recurse -Force -ErrorAction SilentlyContinue
exit 0
