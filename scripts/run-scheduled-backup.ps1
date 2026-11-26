# Windows scheduled runner. Password is DPAPI-protected for the current Windows user.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ConfigPath)
$ErrorActionPreference='Stop'
$config=Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$dir=Split-Path -Parent $ConfigPath
$secret=Get-Content -LiteralPath (Join-Path $dir 'database-password.dpapi') -Raw | ConvertTo-SecureString
$credential=[pscredential]::new($config.User,$secret)
$env:PGHOST=$config.Host
$env:PGPORT=[string]$config.Port
$env:PGUSER=$config.User
$env:PGDATABASE=$config.Database
$env:PGSSLMODE='verify-full'
$env:PGSSLROOTCERT=$config.RootCert
$env:PGPASSWORD=$credential.GetNetworkCredential().Password
$log=Join-Path $dir 'last-run.log'
try {
  & (Join-Path $dir 'backup-public.ps1') -Recipient $config.Recipient -Destination $config.Destination 2>&1 |
    Tee-Object -FilePath $log
  Add-Content -LiteralPath $log -Value "SUCCESS $([DateTime]::UtcNow.ToString('o'))"
} catch {
  Add-Content -LiteralPath $log -Value "FAILED $([DateTime]::UtcNow.ToString('o'))"
  throw
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
