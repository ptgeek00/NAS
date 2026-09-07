---
title: Fixing a hostname that was never really mine
date: 2026-08-24
authors: ptgeek00
excerpt: proxmoxathome.com was borrowed, not owned. Swapping to a .lan name and a local CA instead of chasing Let's Encrypt.
tags: [proxmox, tls, networking]
---

Small but overdue fix today. The Proxmox host has been answering to `proxmoxathome.com` on the LAN since day one, via a plain `/etc/hosts` entry — except I don't own that domain. It only ever resolved on the host itself, and it was one accidental real-world registration away from colliding with someone else's actual site.

Renamed it to `proxmoxathome.lan`, which can't collide with anything public. That still leaves the browser's "Not secure" warning from Proxmox's self-signed cert, and Let's Encrypt doesn't apply here — no public reachability, no owned domain to run a DNS-01 challenge against. `mkcert` is the right tool for a LAN-only box like this: it creates a local CA, trusted only on machines you explicitly install it on, and issues a real cert for the `.lan` name plus the host's IP.

Main workstation is Windows, so `mkcert` runs there, and the generated cert/key get `scp`'d over to `/etc/pve/local/pveproxy-ssl.{pem,key}` using Windows' built-in OpenSSH client rather than reaching for a third-party tool.

Still open: whether to push the `.lan` resolution out network-wide (router-level DNS override, or a Pi-hole if one ever gets added) instead of editing hosts files per device, and trusting the root CA on anything beyond the one Windows box. Full notes in [Proxmox hostname + TLS](/proxmox-cert-and-hostname/) — likely to get revisited entirely now that `ptgeek00.com` is a real, owned domain.
