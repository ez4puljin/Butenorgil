# Add Windows Firewall inbound rules for the ERP server.
# Self-elevates via UAC on first run; idempotent thereafter.

$rules = @(
    @{ Name = "ERP App 8000";       Port = 8000 },
    @{ Name = "ERP CertHelper 8080";Port = 8080 }
)

# Detect admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "Requesting administrator rights to open firewall ports..." -ForegroundColor Yellow
    Start-Process -FilePath "powershell.exe" -Verb RunAs `
        -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File", "`"$PSCommandPath`"" `
        -Wait
    exit
}

foreach ($r in $rules) {
    $existing = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
    if ($existing) {
        Remove-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
    }
    New-NetFirewallRule `
        -DisplayName $r.Name `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort $r.Port `
        -Profile Any `
        | Out-Null
    Write-Host ("[OK] Allowed inbound TCP {0} ({1})" -f $r.Port, $r.Name) -ForegroundColor Green
}
Write-Host ""
Write-Host "Done. You can close this window." -ForegroundColor Cyan
Start-Sleep -Seconds 3
