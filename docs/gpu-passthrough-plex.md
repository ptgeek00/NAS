# GPU Passthrough + Plex Hardware Transcoding — Decisions & Runbook

_Captured 2026-08-17, updated same day as the host driver install was completed live. This resolves two items that were listed as "open" in the master project instructions — update that doc's "Key architectural decisions" section to move these into "already made":_

_**2026-08-25 update:** `dev4`/`dev5` below now shown as `/dev/dri/by-path/...` — the live config for `CT101` was switched from `card0`/`renderD128` to PCI `by-path` device names (keyed to the GPU's fixed PCI address `07:00.0` rather than kernel boot-order enumeration, which can shift). This doc has been updated to match the live config; see `ollama-llm-setup-plan.md` for the full rationale._

## Decisions locked in this session

- **GPU passthrough strategy: LXC-based sharing**, not VM PCIe passthrough. NVIDIA driver installs on the Proxmox host; GPU device nodes get passed into individual LXCs via the modern `devN:` config syntax. This lets Plex/Jellyfin, Immich's ML, and Ollama all reach the GPU concurrently instead of locking it to one VM.
- **Plex install method: native Debian package inside its own LXC**, not via CasaOS's Docker app store. User runs CasaOS for managing other apps, but for the first GPU-transcoding pass, native install avoids the nested Docker + nvidia-container-toolkit layer (extra failure points: Compose `count: all` bug, `NVIDIA_DRIVER_CAPABILITIES` misconfig, device nodes missing after reboot). CasaOS can still run alongside for other services in the same or a different LXC; this decision only concerns Plex itself.
- **NVIDIA kernel module type: open-source (MIT/GPL)**, not proprietary. NVIDIA recommends the open kernel modules for Turing/Ampere/Ada/Hopper GPUs — the RTX 3050 (GA107, Ampere) qualifies. No functional difference for NVENC/CUDA; only the kernel-space shim differs, userspace libraries are identical either way.

## Status: host driver install — DONE ✅, now self-healing across kernel updates (see gotcha #7)

As of 2026-08-17: `nvidia-smi` confirmed working on the Proxmox host. Driver `595.84`, CUDA `13.2`, GPU visible (`GeForce RTX 3050`, idle, `Persistence-M` on after running `nvidia-smi -pm 1`). Plex (`CT101`) and Jellyfin (`CT103`) both stood up with GPU passthrough — see `jellyfin-gpu-setup-plan.md` for the Jellyfin side.

**2026-08-18 update:** hit gotcha #7 (DKMS not rebuilt for a new kernel after a routine `pve-no-subscription` update) — driver broke, fixed same day, and a boot-time `nvidia-dkms-ensure.service` was added so this self-heals automatically going forward instead of needing a manual catch-and-fix each time.

### Gotchas hit during the host driver install (read before repeating this on another box)

1. **`nova_core` conflict.** Proxmox 9.2.2's kernel (7.0.2-6-pve) is new enough to include `nova_core`/`nova_drm` — the in-tree Rust NVIDIA driver landing in mainline Linux. It auto-bound to the GPU before the proprietary/open NVIDIA installer could claim it, causing the installer to silently fail (no `nvidia-smi` ever got installed) and showing up in `dmesg` as `NovaCore 0000:07:00.0: NVIDIA (Chipset: GA107...)` plus a GSP firmware load failure. **Fix:** blacklist it alongside nouveau:
   ```bash
   cat >>/etc/modprobe.d/blacklist-nouveau.conf <<'EOF'
   blacklist nova
   blacklist nova_core
   blacklist nova_drm
   options nova modeset=0
   EOF
   update-initramfs -u -k all
   reboot
   ```
   Confirm with `lsmod | grep -i nova` (should be empty) before re-running the NVIDIA installer.

2. **Enterprise repo 401 errors blocking `apt install build-essential`/`pve-headers`.** Fresh Proxmox installs without a paid subscription point at `enterprise.proxmox.com` by default, which returns `401 Unauthorized` and blocks `apt update` entirely — including for unrelated packages. Fix (one-time, do this on any fresh Proxmox box regardless of GPU work):
   ```bash
   # disable enterprise stanzas in /etc/apt/sources.list.d/pve-enterprise.sources
   # and /etc/apt/sources.list.d/ceph.sources (add `Enabled: no` to each)
   cat >/etc/apt/sources.list.d/proxmox.sources <<'EOF'
   Types: deb
   URIs: http://download.proxmox.com/debian/pve
   Suites: trixie
   Components: pve-no-subscription
   Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
   EOF
   apt update
   ```

3. **`cc`/`gcc` not found during DKMS build.** `build-essential` wasn't actually installed (blocked by gotcha #2 above at the time). Re-run `apt install -y build-essential dkms pve-headers-$(uname -r) proxmox-default-headers` after fixing the repos, confirm with `which cc gcc`.

4. **Persistence daemon: went with `nvidia-smi -pm 1` instead of the `nvidia-persistenced` systemd service.** The `.run` installer doesn't register a `nvidia-persistenced.service` unit on Debian automatically (it only ships a template you'd have to manually install from `/usr/share/doc/NVIDIA_GLX-1.0/sample/nvidia-persistenced-init.tar.bz2`). Simpler path taken: a custom oneshot unit (`nvidia-boot.service`) that runs `nvidia-smi` at boot (before `pve-guests.service`) to force device-node creation, plus `nvidia-smi -pm 1` for persistence mode. Good enough for a single-host homelab; revisit with the real daemon only if this proves flaky.

5. **NVIDIA driver `.run` installer prompts** — for reference, answered: "Multiple kernel module types" → **NVIDIA Proprietary or MIT/GPL** → chose **MIT/GPL** (see decision above). "Register with DKMS?" → **Yes** (survives future kernel updates — this whole gotcha list started because a driver *wasn't* DKMS-managed). "Run nvidia-xconfig to update X config?" → **No** (headless host, no X server ever runs here).

6. **`/dev/nvidia-modeset` doesn't exist on this host, and that's fine.** That device node is only created when the `nvidia-drm` module has KMS modesetting enabled (`nvidia-drm.modeset=1`), which happens for GPUs actually driving a display. This is a headless server — nothing ever asks the GPU to drive a monitor — so the node never gets created, and attempting to pass it into an LXC (`devN: /dev/nvidia-modeset`) fails Proxmox's container start with `Device /dev/nvidia-modeset does not exist`. It's not required for NVENC transcoding, CUDA, or any compute/encode workload (Plex, Immich ML, Ollama) — just leave it out of the `devN:` list. (If some future need for actual display output on this GPU comes up, the fix would be `nvidia-modprobe -m` to force-create it, not something to set up preemptively.)

7. **DKMS did NOT auto-rebuild after a routine kernel update — driver went dark, broke both Plex and Jellyfin's GPU access. Now automated away.** Hit 2026-08-18, ~1 day after the initial install. The `pve-no-subscription` repo shipped a kernel bump (`7.0.2-6-pve` → `7.0.14-12-pve`); DKMS was registered (gotcha #5, "Yes") but only had a build for the *old* kernel (`dkms status` showed `nvidia/595.84, 7.0.2-6-pve: installed` while `uname -r` reported `7.0.14-12-pve`). Root cause: headers were only ever installed for the specific kernel version running at driver-install time (`pve-headers-$(uname -r)`, pinned), not a tracking meta-package — so when the new kernel landed, DKMS had no headers to build against and silently didn't rebuild. Symptom chain: `pct reboot <ctid>` on any GPU-passthrough container → `Device /dev/nvidia0 does not exist` → `nvidia-smi` on the host itself → `NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver` → `lsmod | grep nvidia` empty.

   **One-off manual fix used at the time:**
   ```bash
   apt update
   apt install -y pve-headers-$(uname -r)
   dkms install -m nvidia -v 595.84 -k $(uname -r)
   modprobe nvidia nvidia_uvm nvidia_drm
   nvidia-smi
   nvidia-smi -pm 1
   systemctl restart nvidia-boot.service
   ```
   Then reboot/restart every GPU-passthrough container (`pct reboot 101`, `pct reboot 103`, etc.) to pick the devices back up.

   **Implemented same day: a self-healing boot-time check, so this no longer requires noticing/manual intervention.** `/usr/local/sbin/nvidia-dkms-ensure.sh` runs as a systemd oneshot (`nvidia-dkms-ensure.service`) before `nvidia-boot.service`, which itself runs before `pve-guests.service` — so the check-and-fix happens before Proxmox ever tries to start a GPU-passthrough container. On a normal boot (no kernel change) it's a no-op, sub-second check. On a boot after a kernel bump, it installs the matching headers and rebuilds automatically.

   Script (`/usr/local/sbin/nvidia-dkms-ensure.sh`):
   ```bash
   #!/bin/bash
   set -e
   KVER="$(uname -r)"
   NVIDIA_VER="$(dkms status | grep '^nvidia/' | head -n1 | sed -E 's#^nvidia/([0-9.]+).*#\1#')"

   if [ -z "$NVIDIA_VER" ]; then
     echo "nvidia-dkms-ensure: no nvidia DKMS module registered, nothing to do."
     exit 0
   fi

   if dkms status | grep -q "nvidia/${NVIDIA_VER}, ${KVER}"; then
     echo "nvidia-dkms-ensure: module already built for ${KVER}, OK."
   else
     echo "nvidia-dkms-ensure: rebuilding nvidia ${NVIDIA_VER} for new kernel ${KVER}..."
     apt-get update -qq || true
     apt-get install -y "pve-headers-${KVER}" || true
     dkms install -m nvidia -v "${NVIDIA_VER}" -k "${KVER}" --force || true
   fi

   modprobe nvidia nvidia_uvm nvidia_drm 2>/dev/null || true
   ```

   Unit (`/etc/systemd/system/nvidia-dkms-ensure.service`):
   ```ini
   [Unit]
   Description=Ensure NVIDIA DKMS module is built for the currently running kernel
   Before=nvidia-boot.service
   After=network-online.target
   Wants=network-online.target
   DefaultDependencies=no

   [Service]
   Type=oneshot
   ExecStart=/usr/local/sbin/nvidia-dkms-ensure.sh
   RemainAfterExit=true
   TimeoutStartSec=300

   [Install]
   WantedBy=multi-user.target
   ```

   `nvidia-boot.service` was updated with `After=nvidia-dkms-ensure.service` to lock in the ordering. Both enabled via `systemctl enable nvidia-dkms-ensure.service` (and `nvidia-boot.service` was already enabled from the original install).

   **Complementary, not yet done:** check whether `unattended-upgrades` is configured to auto-reboot this host after kernel updates (`grep -i reboot /etc/apt/apt.conf.d/50unattended-upgrades`) — that's what silently triggered this whole incident. The DKMS fix above means a surprise reboot won't break the GPU anymore, but it'll still interrupt any in-progress Plex/Jellyfin stream. Worth deciding whether to disable auto-reboot so kernel bumps only happen when deliberately triggered.

## Runbook: NVIDIA driver on host + Plex LXC with HW transcoding

### 1. Install NVIDIA driver on the Proxmox host — ✅ done, see gotchas above

Proxmox 9.2.2 runs kernel 7.0.2-6-pve — driver series 550.x fails to compile against this kernel (VMA locking API changes). Use driver 580.x production branch or newer (595.x/610.x also fine). To always get a current version rather than a stale hardcoded one:

```bash
cd /tmp
VER=$(curl -s https://download.nvidia.com/XFree86/Linux-x86_64/latest.txt | awk '{print $1}')
wget https://us.download.nvidia.com/XFree86/Linux-x86_64/${VER}/NVIDIA-Linux-x86_64-${VER}.run
chmod +x NVIDIA-Linux-x86_64-${VER}.run
./NVIDIA-Linux-x86_64-${VER}.run --dkms
reboot
```

After reboot: `nvidia-smi` on the host should show the RTX 3050. (Confirmed working — see Status above.)

Boot-time device node + persistence handling (see gotcha #4 for why this differs from the originally planned `nvidia-persistenced` service; see gotcha #7 for the `nvidia-dkms-ensure.service` that now runs before this):

```bash
cat >/etc/systemd/system/nvidia-boot.service <<'EOF'
[Unit]
Description=Touch NVIDIA GPU at boot to create device nodes
After=nvidia-dkms-ensure.service
Before=pve-guests.service
DefaultDependencies=no

[Service]
Type=oneshot
ExecStart=/usr/bin/nvidia-smi
RemainAfterExit=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now nvidia-boot.service
nvidia-smi -pm 1
```

### 2. Create a dedicated Plex LXC — ✅ done (`CT101`)

Template filenames/versions drift — always check the current one rather than hardcoding:

```bash
pveam update
pveam available --section system | grep debian-13
pveam download local <exact-filename-from-above>
```

```bash
pct create 101 local:vztmpl/<exact-filename> \
  --hostname plex \
  --cores 4 \
  --memory 4096 \
  --rootfs local-zfs:16 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 0 \
  --features nesting=0
pct start 101
```

(`--unprivileged 0` = privileged container, simplest for direct `/dev/nvidia*` device access. Sized 4 cores / 4GB RAM — adjust against whatever else lands on this box; Plex itself is light except during transcodes.)

### 3. Pass the GPU into the LXC

Edit `/etc/pve/lxc/101.conf` and add:

```
dev0: /dev/nvidia0
dev1: /dev/nvidiactl
dev2: /dev/nvidia-uvm
dev3: /dev/nvidia-uvm-tools
dev4: /dev/dri/by-path/pci-0000:07:00.0-card
dev5: /dev/dri/by-path/pci-0000:07:00.0-render
dev6: /dev/nvidia-caps/nvidia-cap1
dev7: /dev/nvidia-caps/nvidia-cap2
```

**`dev4`/`dev5` use PCI `by-path` names, not `card0`/`renderD128` (2026-08-25 update).** `cardN`/`renderDNNN` numbers are assigned by kernel probe order at boot, which can shift if driver load order changes across a kernel update or a second GPU/capture device is ever added. `/dev/dri/by-path/pci-0000:07:00.0-{card,render}` are symlinks keyed to the GPU's fixed PCI address instead, so they can't drift. If the in-container device name Plex's hardware-transcode setting expects looks different after this change, check `ls -la /dev/dri/` inside `CT101` to see what node name actually landed there.

Deliberately **not** included: `/dev/nvidia-modeset` — doesn't exist on this headless host and isn't needed for compute/transcode workloads (see gotcha #6 above). If you ever add it back after forcing its creation, it's harmless to include.

Note on the caps devices: `nvidia-cap1`/`nvidia-cap2` are MIG (Multi-Instance GPU) control nodes (`mig-config`/`mig-monitor` capabilities) — a datacenter-GPU feature the RTX 3050 doesn't support. The driver creates these nodes on this host regardless (confirmed via `ls /dev/nvidia-caps/` — they exist even though MIG itself is a no-op on this card), so there's no reason to leave them out; they're just permanently inert here.

Reboot the container to apply the new device config: `pct reboot 101`. (Note: `pct restart` is **not** a valid subcommand — Proxmox's `pct` uses `reboot`/`start`/`stop`/`shutdown`, not `restart`.)

If this reboot ever fails with `Device /dev/nvidia0 does not exist` (or any `/dev/nvidia*` device), that's gotcha #7 — as of 2026-08-18 this should self-heal on the next host boot via `nvidia-dkms-ensure.service`; if it still happens, check `systemctl status nvidia-dkms-ensure.service` first before assuming it's a passthrough config problem.

### 4. Install matching userspace driver inside the LXC

Version **must match** the host driver exactly (currently `595.84`) — don't use the "grab latest" one-liner here, latest may have moved past what the host has installed by the time you do this.

The LXC is a separate filesystem from the host, so get the installer into it one of two ways:

**Option A — download fresh, directly inside the container (simplest):**
```bash
pct enter 101
```
This drops you into a root shell *inside* the container. From there:
```bash
cd /tmp
wget https://us.download.nvidia.com/XFree86/Linux-x86_64/595.84/NVIDIA-Linux-x86_64-595.84.run
chmod +x NVIDIA-Linux-x86_64-595.84.run
./NVIDIA-Linux-x86_64-595.84.run --no-kernel-module --silent
nvidia-smi
```
`exit` to return to the Proxmox host shell when done.

**Option B — push the file you already downloaded on the host, without entering the container:**
```bash
pct push 101 /tmp/NVIDIA-Linux-x86_64-595.84.run /tmp/NVIDIA-Linux-x86_64-595.84.run
pct exec 101 -- chmod +x /tmp/NVIDIA-Linux-x86_64-595.84.run
pct exec 101 -- /tmp/NVIDIA-Linux-x86_64-595.84.run --no-kernel-module --silent
pct exec 101 -- nvidia-smi
```
(Only works if that file's still sitting in `/tmp` on the host — if it's gone, Option A is easier than re-fetching it on the host just to push it over.)

### 5. Install Plex natively

```bash
curl https://downloads.plex.tv/plex-keys/PlexSign.key | gpg --dearmor | tee /usr/share/keyrings/plex-archive-keyring.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/plex-archive-keyring.gpg] https://downloads.plex.tv/repo/deb public main" > /etc/apt/sources.list.d/plexmediaserver.list
apt update
apt install -y plexmediaserver
```

If `apt update` throws `Policy rejected non-revocation signature ... SHA1 is not considered secure`, that's the Debian-13-wide `sqv`/Sequoia SHA1 cutoff (2026-02-01), not specific to Plex — extend the deadline in `/etc/crypto-policies/back-ends/apt-sequoia.config` (copy from `/usr/share/apt/default-sequoia.config` first, then push out the `sha1.second_preimage_resistance` date under `[hash_algorithms]`).

Point Plex's transcode temp directory at the NVMe `rpool` (fast, not the SMR `HDDs` pool) — Settings → Transcoder → Transcoder temporary directory, e.g. `/var/lib/plexmediaserver/transcode` on the container's rootfs, which already lives on `rpool` via `local-zfs`.

### 6. Enable hardware transcoding in Plex

Settings → Transcoder:
- "Use hardware acceleration when available" — **requires an active Plex Pass subscription**, this is a Plex-side licensing gate, not a technical one.
- "Use hardware-accelerated video encoding"

Test with a stream that forces transcoding and watch `nvidia-smi` on the host for a `plex` process using the encoder.

### Known gotcha: NVENC session limit

Consumer NVIDIA GPUs (including the RTX 3050) are limited by the driver to **3 simultaneous NVENC encode sessions**, regardless of Plex Pass — and as of 2026-08-17 this cap is shared with Jellyfin (`CT103`) too, see `jellyfin-gpu-setup-plan.md`. The homelab community workaround is [keylase/nvidia-patch](https://github.com/keylase/nvidia-patch), applied on the host or inside the LXC against the installed driver — unofficial and technically against Nvidia's driver EULA, but widely used. Worth knowing about before assuming 4+ concurrent transcodes will just work.

## Media library

Movies/TV now live on a shared `HDDs/media` ZFS dataset, bind-mounted into both Plex and Jellyfin — see `media-storage-smb-plan.md` for the full storage + SMB setup (that doc also resolves the "SMB vs NFS" open item below).

## Still open

- Plex vs Jellyfin final choice — both now running side by side specifically for this comparison
- Document storage/serving method (movies/TV are handled; this is about documents specifically, still unresolved)
- Role of spare 2TB drive
- 2.5Gb/s NIC link negotiation
- Whether `unattended-upgrades` auto-reboots this host after kernel updates (see gotcha #7's "complementary, not yet done" note)
