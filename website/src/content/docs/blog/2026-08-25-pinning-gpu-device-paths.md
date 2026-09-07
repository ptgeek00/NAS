---
title: Renumbering-proofing the GPU device paths
date: 2026-08-25
authors: ptgeek00
excerpt: card0 and renderD128 are assigned by boot order, not by the GPU. Switching every container to PCI by-path names instead.
tags: [gpu, proxmox]
---

A small config change that's really a small insurance policy. The `devN:` entries passing the GPU into `CT101`, `CT103`, and now `CT104` originally referenced `/dev/dri/card0` and `/dev/dri/renderD128` — but those numbers are assigned by kernel probe order at boot, not tied to the GPU itself. Add a second GPU or capture card later, or just have driver load order shift across a kernel update, and those names can silently point at the wrong device.

`/dev/dri/by-path/pci-0000:07:00.0-{card,render}` are symlinks keyed to the GPU's actual PCI address instead — confirmed fixed from the original inventory sweep — so they can't drift regardless of what else is on the bus. All three GPU-passthrough containers are on the `by-path` names now. Cheap to do today, annoying to debug later if skipped.
