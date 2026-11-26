# Run locally in PowerShell 7 on Windows from a trusted checkout of this repository.
# No secrets are sent to GitHub or to ChatGPT. Requires age, PostgreSQL client >=17, and the Supabase CA certificate.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'This setup uses Windows DPAPI and Task Scheduler.'}
foreach($tool in @('pwsh','pg_dump','pg_restore','psql','age','age-keygen')){Get-Command $tool -ErrorAction Stop | Out-Null}
$dir=Join-Path $env:LOCALAPPDATA 'VeilleEmploi-Recovery'
$configPath=Join-Path $dir 'config.json'
if(Test-Path -LiteralPath $configPath){throw "Already configured at $configPath. Review it before changing settings."}
$hostName=(Read-Host 'Veille Emploi session pooler host (from Supabase Connect)').Trim()
$pgUser=(Read-Host 'Session pooler username (from Supabase Connect)').Trim()
if($hostName -notmatch '^[a-z0-9.-]+\.pooler\.supabase\.com$' -or $pgUser -notmatch '^[a-zA-Z0-9_]+\.maqyabqedzofmlcohfdc$'){throw 'Use the Veille Emploi session pooler host and project-specific username, not another project.'}
$cert=(Read-Host 'Full path to the Supabase database root CA certificate').Trim('"')
if(-not (Test-Path -LiteralPath $cert -PathType Leaf)){throw 'Certificate file not found'}
$destination=[IO.Path]::GetFullPath((Read-Host 'Private backup folder (local or Google Drive synced)').Trim('"'))
$recipient=(Read-Host 'Your age public recipient (age1...)').Trim()
if($recipient -notmatch '^age1[0-9a-z]+$'){throw 'Generate a key with age-keygen first and retain the private identity offline.'}
$secret=Read-Host 'Database password (hidden; stored encrypted for this Windows user)' -AsSecureString
if($secret.Length -eq 0){throw 'A database password is required'}
New-Item -ItemType Directory -Path $dir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'backup-public.ps1') -Destination $dir
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'run-scheduled-backup.ps1') -Destination $dir
Copy-Item -LiteralPath $cert -Destination (Join-Path $dir 'supabase-ca.crt')
$secret | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $dir 'database-password.dpapi')
@{Host=$hostName;Port=5432;User=$pgUser;Database='postgres';RootCert=(Join-Path $dir 'supabase-ca.crt');Destination=$destination;Recipient=$recipient} | ConvertTo-Json | Set-Content -LiteralPath $configPath
Write-Host 'Running first encrypted backup before scheduling.'
& (Join-Path $dir 'run-scheduled-backup.ps1') -ConfigPath $configPath
$task='VeilleEmploi-DailyEncryptedBackup'
if(Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue){throw 'A scheduled backup task already exists; review before replacing it.'}
$pwsh=(Get-Command pwsh -CommandType Application).Source
$runner=Join-Path $dir 'run-scheduled-backup.ps1'
$action=New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -NonInteractive -File `"$runner`" -ConfigPath `"$configPath`""
$trigger=New-ScheduledTaskTrigger -Daily -At 9am
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Write-Host "Daily backup scheduled at 09:00 local time while this Windows user is logged in. Check $dir\last-run.log and Task Scheduler."
Write-Host 'Keep the private age identity offline. Verify decryption and a staging restoration before relying on recovery.'
