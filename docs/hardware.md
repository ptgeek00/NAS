# Hardware

Captured from a full inventory sweep on 2026-08-17. Re-run the reference commands and update this table whenever hardware changes.

| Component | Spec | Notes |
|---|---|---|
| CPU | AMD Ryzen 7 3700X | 8 cores / 16 threads, AMD-V + AMD-Vi (IOMMU) enabled and active |
| GPU | NVIDIA GeForce RTX 3050 8GB (GA107, ZOTAC) | PCI `07:00.0` `[10de:2582]` + HD Audio function `07:00.1` `[10de:2291]`, both alone in **IOMMU Group 16** — a clean split, nothing else to isolate around it |
| RAM | 32GB (2x16GB G.Skill, 3200MT/s) | Only 2 of 4 DIMM slots populated (A2 + B2) — A1/B1 free, room to grow to 64GB later |
| Motherboard | ASUS TUF GAMING B550-PLUS (AM4) | BIOS/UEFI 3611, IOMMU confirmed active in `dmesg` |
| Storage — bulk | 3x 8TB Seagate BarraCuda `ST8000DM004-2U9188` | ZFS RAIDZ1 pool `HDDs`, 21.8TB usable, ONLINE, no errors. ⚠️ SMR drives — see risk note below |
| Storage — extra | 1x 2TB Seagate BarraCuda `ST2000DM008-2FR102` | NTFS-formatted, not in any ZFS pool. Also SMR. Role still open |
| Storage — fast | 2x 500GB KIOXIA-EXCERIA G2 NVMe | ZFS-mirrored as `rpool` — the Proxmox boot pool, hosting `local` and `local-zfs`, i.e. every LXC/VM root disk today |
| Network | Realtek RTL8125 2.5GbE (`06:00.0`, `[10ec:8125]`), bridged as `vmbr0` | ⚠️ Currently negotiating at 1000Mb/s, not the card's rated 2.5Gb/s |

## SMR risk note

All four spinning drives are SMR (Shingled Magnetic Recording), not CMR. SMR performs poorly on sustained/random writes and — more importantly — can make ZFS **resilvers** (rebuilding a RAIDZ1 vdev after a drive failure) dramatically slower, which extends the window where a second drive failure would mean data loss.

The `HDDs` pool is already built as RAIDZ1 across three SMR drives — workable, not ideal. For anything in the "important documents / irreplaceable photos" category, the RAIDZ1 pool alone isn't treated as a backup. A second copy (Proxmox Backup Server on the spare 2TB drive, or an offsite copy of just documents + Immich originals) is the plan, not relying on RAIDZ1 redundancy by itself.

## Software stack

- **Hypervisor:** Proxmox VE 9.2.2 (kernel 7.0.2-6-pve, Debian 13 "trixie" base)
- **Media servers:** Plex and Jellyfin, running side by side for a head-to-head trial
- **File sharing:** Samba, for getting files onto the pool from the Windows workstation
- **Photo storage:** Immich (planned)
- **Local LLM:** Ollama, GPU-accelerated, sharing the RTX 3050 with everything else above
