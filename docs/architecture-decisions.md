# Architecture decisions

A running log of what's settled and what's still open. Updated as decisions get made — nothing here should get re-litigated without a new entry explaining why.

## Decided

- **ZFS pool layout for the 3x 8TB HDDs:** RAIDZ1, pool named `HDDs`, 21.8TB usable. Built and healthy — see `hardware.md` for the SMR caveat that comes with it.
- **Role of the 2x 500GB NVMe pair:** mirrored as `rpool`, serving as the Proxmox boot pool *and* the default location for all LXC/VM root disks. No portion reserved separately as a ZFS special device or L2ARC for `HDDs`.
- **GPU passthrough strategy: LXC-based sharing**, not VM PCIe passthrough. The NVIDIA driver lives on the Proxmox host; GPU device nodes get passed into individual LXCs. This lets Plex, Jellyfin, Ollama, and eventually Immich's ML all reach the GPU concurrently instead of locking it to one VM. See `gpu-passthrough-plex.md`.
- **NVIDIA kernel module type: open-source (MIT/GPL)**, not proprietary — recommended by NVIDIA for the Ampere-generation RTX 3050, no functional difference for NVENC/CUDA.
- **Plex and Jellyfin: native Debian packages**, each in its own LXC, not Docker — avoids the nested Docker + `nvidia-container-toolkit` failure modes for anything touching the GPU directly.
- **Network share protocol: SMB**, not NFS. The main workstation is Windows, where SMB has no caveats and NFS is clunkier. See `media-storage-smb.md`.
- **Local LLM: Ollama**, native install, same GPU-sharing and no-Docker reasoning as Plex/Jellyfin. See `ollama.md`.
- **Open WebUI: Docker**, unlike Ollama — it never touches the GPU directly, so the reasons to avoid Docker elsewhere don't apply. See `open-webui.md`.
- **Local hostname: `proxmoxathome.lan`**, with a local `mkcert` CA for TLS rather than Let's Encrypt, since the box was LAN-only with no owned public domain at the time. See `proxmox-cert-and-hostname.md` — likely to be revisited now that `ptgeek00.com` exists.
- **LXC map so far:**

  | CTID | Hostname | Role |
  |---|---|---|
  | 100 | — | Original container, predates this documentation |
  | 101 | plex | Plex, native, GPU passthrough |
  | 102 | smb | Samba file sharing |
  | 103 | jellyfin | Jellyfin, native, GPU passthrough |
  | 104 | ollama | Ollama, native, GPU passthrough |
  | 105 | openwebui | Open WebUI, Docker, no GPU |
  | 106 | minecraft | Modded Minecraft (NeoForge), CPU only |

## Still open

- Final choice between Plex and Jellyfin, once the side-by-side trial has run long enough
- Role of the spare 2TB drive — candidates: Proxmox Backup Server datastore, a `zfs send`/`recv` target, or scratch space. Not a good candidate for joining the existing RAIDZ1 vdev (mismatched redundancy)
- How documents (as opposed to photos, which Immich will own) get stored and served
- Chasing the RTL8125's full 2.5Gb/s link speed instead of the 1Gb/s it currently negotiates
- Whether to front the stack with a reverse proxy now that `ptgeek00.com` is a real, owned domain
