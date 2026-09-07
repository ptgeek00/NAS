# Proxmox Local Hostname + TLS Certificate — Decisions & Runbook

_Captured 2026-08-24._

## Context

Proxmox host was reachable at `192.168.1.107` with `/etc/hosts` mapping it to `proxmoxathome.com` — but `.com` isn't a domain actually owned, so it only resolved on the Proxmox host itself (local `/etc/hosts` entries never propagate to other devices) and risked colliding with a real public domain if that name is ever registered. Separately, Proxmox's default self-signed cert triggers browser "Not secure" warnings.

## Decisions locked in this session

- **Hostname: `proxmoxathome.lan`**, replacing `proxmoxathome.com`. Avoids any collision with a real public domain (unlike `.com`).
- **Certificate strategy: local CA via `mkcert`**, not Let's Encrypt. This box is LAN-only with no real owned domain, so ACME/Let's Encrypt (which needs either public reachability or DNS-01 against a domain you control) doesn't apply. `mkcert` creates a private CA, trusted only on devices you explicitly install it on, and issues a cert for `proxmoxathome.lan` + the IP.
- **Main workstation: Windows.** `mkcert` runs there; the generated cert/key get copied to the Proxmox host over `scp` using Windows' built-in OpenSSH client.

## Runbook

### 1. Rename the hosts entry on Proxmox itself

On the Proxmox host, edit `/etc/hosts`:

```bash
nano /etc/hosts
```

Change:
```
192.168.1.107 proxmoxathome.com proxmoxathome
```
to:
```
192.168.1.107 proxmoxathome.lan proxmoxathome
```

### 2. Install mkcert on the Windows workstation

In an elevated PowerShell:

```powershell
choco install mkcert -y
# If you use Firefox (it has its own cert store, separate from Windows):
choco install nss -y
```
(or `winget install FiloSottile.mkcert` if not using Chocolatey)

Then:
```powershell
mkcert -install
```
This creates the local CA and trusts it in Windows' cert store + any installed browsers on this machine.

### 3. Issue the certificate

```powershell
cd $HOME\Documents
mkcert proxmoxathome.lan 192.168.1.107
```

Produces:
- `proxmoxathome.lan+1.pem` (certificate)
- `proxmoxathome.lan+1-key.pem` (private key)

### 4. Enable Windows' OpenSSH client (if not already)

Check:
```powershell
Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Client*'
```
If not "Installed":
```powershell
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0
```

### 5. Copy the cert to Proxmox

```powershell
scp .\proxmoxathome.lan+1.pem root@192.168.1.107:/etc/pve/local/pveproxy-ssl.pem
scp .\proxmoxathome.lan+1-key.pem root@192.168.1.107:/etc/pve/local/pveproxy-ssl.key
```

### 6. Apply it on Proxmox

```bash
systemctl restart pveproxy
```

### 7. Make `proxmoxathome.lan` resolve on the Windows workstation

Edit (as Administrator) `C:\Windows\System32\drivers\etc\hosts`, add:
```
192.168.1.107   proxmoxathome.lan
```

Still open: whether to do this per-device via hosts file edits, or set up a network-wide DNS override (router custom DNS entry, or Pi-hole/AdGuard Home if one gets added later) so every device resolves it automatically instead of editing hosts files one by one.

### 8. Trust the CA on any other device

`mkcert -install` only trusted the CA on the Windows workstation. For any other device (phone, another PC) that will browse the Proxmox UI:

```powershell
mkcert -CAROOT
```
Shows the folder containing `rootCA.pem` (safe to copy/share) and `rootCA-key.pem` (keep private — never distribute). Copy `rootCA.pem` to each other device and import it into that device's trusted root certificate store. Not yet walked through per-OS (Windows/Mac/iOS/Android) — revisit when a specific device is in front of us.

## Still open

- Network-wide DNS resolution for `proxmoxathome.lan` (per-device hosts file vs. router/Pi-hole override) — see step 7.
- Trusting the root CA on devices other than the main Windows workstation.
- Whether to eventually front the box with a reverse proxy (e.g. if more services get their own subdomains later) — not needed yet, single UI endpoint today.
