# Keeps an SSH port forward to the gateway (ClashKingProxy on the VPS) open: 127.0.0.1:<LocalPort> -> VPS 127.0.0.1:8011.
# Reconnects when it drops.
#   powershell -ExecutionPolicy Bypass -File scripts\tunnel-gateway.ps1 -Server 203.0.113.10
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [int]$Port = 22,
  [int]$LocalPort = 8011,
  [int]$RemotePort = 8011,
  [string]$User = 'cocproxy',
  [string]$Key = "$env:USERPROFILE\.ssh\coc_proxy"
)
while ($true) {
  Write-Host "$(Get-Date -Format s) tunnel: 127.0.0.1:$LocalPort -> $User@${Server}:$Port -> 127.0.0.1:$RemotePort"
  ssh -N -L "127.0.0.1:${LocalPort}:127.0.0.1:${RemotePort}" -p $Port -i $Key `
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 `
    -o StrictHostKeyChecking=accept-new -o Compression=no "$User@$Server"
  Write-Host "$(Get-Date -Format s) tunnel closed (exit $LASTEXITCODE), reconnecting in 5 s"
  Start-Sleep -Seconds 5
}
