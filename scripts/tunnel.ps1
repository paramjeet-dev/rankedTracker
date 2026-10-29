# Keeps an SSH SOCKS5 tunnel to the VPS open: 127.0.0.1:<LocalPort> -> VPS. Reconnects when it drops.
#   powershell -ExecutionPolicy Bypass -File scripts\tunnel.ps1 -Server 203.0.113.10
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [int]$Port = 22,
  [int]$LocalPort = 1080,
  [string]$User = 'cocproxy',
  [string]$Key = "$env:USERPROFILE\.ssh\coc_proxy"
)
while ($true) {
  Write-Host "$(Get-Date -Format s) tunnel: 127.0.0.1:$LocalPort -> $User@${Server}:$Port"
  ssh -N -D "127.0.0.1:$LocalPort" -p $Port -i $Key `
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 `
    -o StrictHostKeyChecking=accept-new -o Compression=no "$User@$Server"
  Write-Host "$(Get-Date -Format s) tunnel closed (exit $LASTEXITCODE), reconnecting in 5 s"
  Start-Sleep -Seconds 5
}
