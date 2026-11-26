# Requires PowerShell 7, pg_dump, pg_restore and age on PATH.
# Configure PGHOST, PGPORT, PGUSER, PGDATABASE, PGSSLMODE and PGPASSFILE locally.
# Use a session-mode pooler/direct connection, not transaction mode.
# The age recipient is a public encryption key. Keep the private identity offline.
[CmdletBinding()]
param(
 [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Recipient,
 [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Destination
)
$ErrorActionPreference = 'Stop'
foreach ($cmd in @('pg_dump','pg_restore','age','psql')) { Get-Command $cmd -ErrorAction Stop | Out-Null }
foreach ($name in @('PGHOST','PGUSER','PGDATABASE')) {
 if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing local connection setting: $name" }
}
if ($env:PGSSLMODE -notin @('verify-full','verify-ca','require')) { throw 'Set PGSSLMODE to verify-full (preferred), verify-ca, or require.' }
$clientVersion = & pg_dump --version
if ($LASTEXITCODE -ne 0 -or $clientVersion -notmatch '(\d+)\.\d+') { throw 'Cannot determine pg_dump version' }
$clientMajor = [int]$Matches[1]
$serverVersion = & psql -X -w -A -t -v ON_ERROR_STOP=1 -c 'show server_version_num'
if ($LASTEXITCODE -ne 0 -or "$serverVersion" -notmatch '^\d+
if ($Recipient -notmatch '^age1[0-9a-z]+$') { throw 'Provide an age public recipient, not a private key.' }
$folder = [IO.Path]::GetFullPath($Destination)
[IO.Directory]::CreateDirectory($folder) | Out-Null
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$archive = Join-Path $folder "veille-public-$stamp.dump.age"
$partial = "$archive.partial"
# Stream the dump directly to age, never write an unencrypted dump to disk.
# Both native process exit codes are checked independently.
function Start-Native([string]$File,[string[]]$Arguments,[bool]$Read,[bool]$Write) {
 $psi = [Diagnostics.ProcessStartInfo]::new()
 $psi.FileName = (Get-Command $File -CommandType Application).Source
 $psi.UseShellExecute = $false
 $psi.RedirectStandardOutput = $Read
 $psi.RedirectStandardInput = $Write
 foreach($arg in $Arguments){ $psi.ArgumentList.Add($arg) }
 $proc = [Diagnostics.Process]::new(); $proc.StartInfo = $psi
 if(-not $proc.Start()){throw "Could not start $File"}
 return $proc
}
$dump = $null; $encrypt = $null
try {
 if((Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath $partial)){throw 'Archive already exists'}
 $encrypt = Start-Native 'age' @('-r',$Recipient,'-o',$partial) $false $true
 $dump = Start-Native 'pg_dump' @('--no-password','--format=custom','--schema=public','--no-owner') $true $false
 $dump.StandardOutput.BaseStream.CopyTo($encrypt.StandardInput.BaseStream)
 $encrypt.StandardInput.Close()
 $dump.WaitForExit(); $encrypt.WaitForExit()
 if($dump.ExitCode -ne 0 -or $encrypt.ExitCode -ne 0){throw "Backup failed (dump=$($dump.ExitCode), encrypt=$($encrypt.ExitCode))"}
 if((Get-Item -LiteralPath $partial).Length -lt 100){throw 'Encrypted archive unexpectedly small'}
 Move-Item -LiteralPath $partial -Destination $archive
 $digest=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
 "$digest  $([IO.Path]::GetFileName($archive))" | Set-Content -LiteralPath "$archive.sha256" -Encoding ascii
 Write-Output "Encrypted backup: $archive"
 Write-Output "SHA256: $digest"
 Write-Output 'Backup created; perform the separate restore drill before treating it as verified.'
} finally {
 foreach($proc in @($dump,$encrypt)){if($null -ne $proc){if(-not $proc.HasExited){$proc.Kill()};$proc.Dispose()}}
 if(Test-Path -LiteralPath $partial){Remove-Item -LiteralPath $partial -Force}
}
) { throw 'Cannot determine database server version' }
if ($clientMajor -lt [math]::Floor([int]$serverVersion / 10000)) { throw 'pg_dump is older than the database server. Upgrade PostgreSQL client tools.' }
if ($Recipient -notmatch '^age1[0-9a-z]+$') { throw 'Provide an age public recipient, not a private key.' }
$folder = [IO.Path]::GetFullPath($Destination)
[IO.Directory]::CreateDirectory($folder) | Out-Null
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$archive = Join-Path $folder "veille-public-$stamp.dump.age"
$partial = "$archive.partial"
# Stream the dump directly to age, never write an unencrypted dump to disk.
# Both native process exit codes are checked independently.
function Start-Native([string]$File,[string[]]$Arguments,[bool]$Read,[bool]$Write) {
 $psi = [Diagnostics.ProcessStartInfo]::new()
 $psi.FileName = (Get-Command $File -CommandType Application).Source
 $psi.UseShellExecute = $false
 $psi.RedirectStandardOutput = $Read
 $psi.RedirectStandardInput = $Write
 foreach($arg in $Arguments){ $psi.ArgumentList.Add($arg) }
 $proc = [Diagnostics.Process]::new(); $proc.StartInfo = $psi
 if(-not $proc.Start()){throw "Could not start $File"}
 return $proc
}
$dump = $null; $encrypt = $null
try {
 if(Test-Path -LiteralPath $archive){throw 'Archive already exists'}
 $encrypt = Start-Native 'age' @('-r',$Recipient,'-o',$partial) $false $true
 $dump = Start-Native 'pg_dump' @('--no-password','--format=custom','--schema=public','--no-owner') $true $false
 $dump.StandardOutput.BaseStream.CopyTo($encrypt.StandardInput.BaseStream)
 $encrypt.StandardInput.Close()
 $dump.WaitForExit(); $encrypt.WaitForExit()
 if($dump.ExitCode -ne 0 -or $encrypt.ExitCode -ne 0){throw "Backup failed (dump=$($dump.ExitCode), encrypt=$($encrypt.ExitCode))"}
 if((Get-Item -LiteralPath $partial).Length -lt 100){throw 'Encrypted archive unexpectedly small'}
 Move-Item -LiteralPath $partial -Destination $archive
 $digest=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
 "$digest  $([IO.Path]::GetFileName($archive))" | Set-Content -LiteralPath "$archive.sha256" -Encoding ascii
 Write-Output "Encrypted backup: $archive"
 Write-Output "SHA256: $digest"
 Write-Output 'Backup created; perform the separate restore drill before treating it as verified.'
} finally {
 foreach($proc in @($dump,$encrypt)){if($null -ne $proc){if(-not $proc.HasExited){$proc.Kill()};$proc.Dispose()}}
 if(Test-Path -LiteralPath $partial){Remove-Item -LiteralPath $partial -Force}
}
