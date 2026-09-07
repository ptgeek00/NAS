---
title: A modded Minecraft server, a friend's modpack, and a mounting-order bug
date: 2026-08-27
authors: ptgeek00
excerpt: CT106 hosts a 176-mod NeoForge server for occasional play — plus a real ZFS gotcha discovered while publishing mod updates to the LAN.
tags: [minecraft, zfs, samba]
---

`CT106` now runs a modded NeoForge 1.21.1 server for occasional weekend play, built from a friend's pre-assembled Aetherworks pack rather than the manual mod-by-mod assembly the original plan called for. Worth the swap: 198 client mods, 176 server-side (client-only mods correctly stripped), every download SHA-512-verified against the pack's own manifest. Diffing it against the mod list from before found 191 byte-identical files, 7 at a normal newer patch version, and one alpha-to-stable rename — nothing missing, nothing unexplained added.

The container itself is sized around one hard rule: the JVM heap has to sit *below* the container's memory ceiling, not equal to it — 10GB heap inside a 12GB container, leaving room for thread stacks, JIT, and the native libraries mods like Create and Simple Voice Chat bring with them. Skip that gap and the LXC's own kernel OOM-killer ends the `java` process with no crash log at all, just a bare `Killed` in the terminal.

The more interesting find came from something unrelated: publishing a mod-update zip to the existing Samba share (`CT102`). A ZFS dataset created *after* `CT102` was already running doesn't show up through a parent bind mount that predates it — confirmed by testing, and confirmed that `Movies`/`TV` were never affected only because those datasets existed before `CT102`'s `mp0` was first configured. The fix is a dedicated `mp` pointing straight at the new dataset rather than relying on the parent bind. Filed under: ZFS mount order matters more than it looks like it should.

Full setup, including the systemd unit fix (`Type=simple`, not `Type=forking` — `screen -DmS` never actually forks) and the vein-mining/storage mod additions from the same day: [Minecraft server](/minecraft-server/) and [Media storage + SMB](/media-storage-smb/).
