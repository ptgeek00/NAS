---
title: Getting the RTX 3050 talking to Plex and Jellyfin
date: 2026-08-17
authors: ptgeek00
excerpt: The host's first GPU driver install, a fight with an in-tree Rust driver nobody asked for, and two media servers sharing one card.
tags: [gpu, proxmox, plex, jellyfin]
---

First real milestone on this box: the GPU is no longer sitting idle behind `nouveau`. `nvidia-smi` reports the RTX 3050 on the host, and both Plex (`CT101`) and Jellyfin (`CT103`) can reach it for hardware transcoding.

The plan going in was LXC-based GPU sharing rather than classic VM PCIe passthrough — the driver lives once on the host, and device nodes get passed into whichever containers need them. That's the only way Plex, Jellyfin, and eventually Ollama and Immich's ML pipeline can all touch the same 8GB card without fighting over exclusive ownership.

It wasn't a clean install. The kernel that ships with Proxmox 9.2.2 is new enough to include `nova_core` — the in-tree Rust NVIDIA driver — and it grabbed the GPU before the real installer got a chance, failing silently with no `nvidia-smi` ever appearing. Blacklisting `nova`/`nova_core`/`nova_drm` alongside the usual `nouveau` entry fixed it. A second, unrelated snag: a subscription-less Proxmox install points at the enterprise repo by default, which returns a flat 401 and blocks `apt update` for everything, GPU-related or not. Swapping in the `pve-no-subscription` repo cleared that.

Both containers are privileged, mounting the same `/dev/nvidia*` device nodes plus the DRM card/render nodes — pinned by PCI `by-path` rather than `card0`/`renderD128`, so a kernel bump or a second GPU down the line can't silently renumber them out from under a running config.

One thing worth flagging for later: consumer NVIDIA cards cap out at 3 simultaneous NVENC sessions, and that cap is shared across every consumer on the card — not per service. Not a problem with one or two streams today, but it's the first place to look if concurrent transcodes ever start falling back to software.

Full runbook, including the DKMS self-healing service that came out of a kernel-update outage a day later: [GPU passthrough + Plex](/gpu-passthrough-plex/).
