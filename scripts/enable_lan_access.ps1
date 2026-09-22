<#
Run this script only in an elevated PowerShell window on the approved portal host.
It opens the application port for the specified office subnet; it does not modify GIS or survey data.
#>
param(
  [string]$RemoteAddress = '192.168.0.0/24',
  [int]$Port = 5890
)

$ruleName = "MRDCL Household Survey Portal (TCP $Port)"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
  Set-NetFirewallRule -DisplayName $ruleName -Enabled True -Direction Inbound -Action Allow -Profile Any
  Set-NetFirewallAddressFilter -AssociatedNetFirewallRule $existing -RemoteAddress $RemoteAddress
} else {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any -RemoteAddress $RemoteAddress | Out-Null
}

Write-Host "MRDCL portal is allowed from $RemoteAddress on TCP $Port."
