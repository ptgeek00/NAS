# Media Storage + SMB Share — Decisions & Runbook

_Captured 2026-08-17. Updated 2026-08-27: added a `Minecraft` share for publishing modpack updates, then corrected the mount setup after testing revealed a bind-mount nesting bug (confirmed fixed and Movies/TV confirmed unaffected)._

## Decision locked in this session

- **Network share protocol: SMB**, not NFS. User's main PC is Windows 11 Pro (NFS client exists there but is clunkier and Home-edition-incompatible in general; SMB has zero caveats regardless of client OS). Resolves the "Network share protocol(s): SMB, NFS, or both" item from the master project instructions' open-decisions list — update that doc.
- **Architecture: dedicated LXC for Samba** (`CT102`, hostname `smb`), not installed on the Proxmox host directly and not folded into the Plex container. Matches the "one container, one job" pattern already used for Plex (`CT101`). Privileged container (`--unprivileged 0`) — same rationale as Plex: avoids unprivileged LXC UID/GID remapping pain when bind-mounting host ZFS paths.

## Known issue (resolved): nested ZFS datasets added *after* CT102 first booted don't show through the parent bind mount

`CT102`'s `mp0` bind-mounts `/HDDs/media` as a whole into `/media`. A **separate ZFS dataset mounted underneath that path** (e.g. `HDDs/media/minecraft-mods`) is a distinct filesystem layered on top of the parent — it does not appear inside the container through that parent bind unless it already existed (and was already mounted) the first time `CT102` was booted with that `mp0` in its config. A `pct reboot` alone does **not** pick up a dataset created later — confirmed by testing: rebooting after adding `minecraft-mods` still showed it empty.

Discovered and fixed 2026-08-27, when the new `minecraft-mods` share showed up empty in Windows despite the file genuinely existing on the host. Root cause confirmed: `Movies` and `TV` were never actually affected, because both datasets were created and mounted *before* `CT102`'s `mp0` was first configured back on 2026-08-17 — so that original bind captured them from `CT102`'s very first boot. `minecraft-mods` was created while `CT102` was already up and running, which is exactly the case that doesn't propagate.

**The fix for any new dataset added under `/HDDs/media` from now on (added after CT102 already exists): give the Samba container its own dedicated `mp` pointing directly at that dataset**, not just the parent bind:

```bash
pct set 102 -mpN /HDDs/media/<new-dataset>,mp=/media/<new-dataset>   # pick the next free mpN number
pct reboot 102
```

(If a whole fresh rebuild of `CT102` ever happens, e.g. after all current datasets already exist, this issue wouldn't arise in the first place — it's specifically about mount-order-relative-to-container-boot, not something inherent to nested ZFS datasets in general.)

## Layout

- ZFS datasets on the `HDDs` pool: `HDDs/media/movies`, `HDDs/media/tv` (mirrors Plex's own recommended one-top-level-folder-per-library-type convention; add more, e.g. `HDDs/media/music`, the same way later).
- `HDDs/media/minecraft-mods` (added 2026-08-27) — not media in the Plex sense, just reuses the same share infrastructure to publish the Minecraft server's current `mods/` folder as a zip for LAN clients to grab. `chmod 777` on this one dataset specifically (not the movies/tv ones) — it's written to by `CT106`, an **unprivileged** LXC, whose files land under a shifted host UID; wide-open permissions on this single low-stakes folder sidesteps that rather than setting up proper subuid mapping. See `minecraft-server-setup-plan.md`'s "Publishing mod updates to the LAN" section for the publish script and full rationale. Has its own dedicated `mp1` on `CT102` (see known-issue section) in addition to `CT106`'s own `mp0`.
- Host mounts these at `/HDDs/media/...` (ZFS default mountpoint = pool name).
- Bind-mounted via Proxmox `mp0` into **both** `CT102` (Samba) and `CT101` (Plex) at `/media` inside each container — same underlying dataset. Any dataset that existed before that `mp0` was first set up shows through it fine (confirmed true for `movies`/`tv`); any dataset added later needs its own dedicated `mpN` on whichever container needs to see it (confirmed true for `minecraft-mods` on `CT102`). `CT106` (Minecraft) has its own direct `mp0` at `/HDDs/media/minecraft-mods` for write access, which was correct from the start since it targets the dataset itself rather than a parent containing it.

## Runbook

```bash
# on the Proxmox host
zfs create HDDs/media
zfs create HDDs/media/movies
zfs create HDDs/media/tv

pveam update
pveam available --section system | grep debian-13
pveam download local <exact-filename>
pct create 102 local:vztmpl/<exact-filename> \
  --hostname smb \
  --cores 2 \
  --memory 1024 \
  --rootfs local-zfs:8 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 0
pct start 102
pct set 102 -mp0 /HDDs/media,mp=/media

pct exec 102 -- apt update
pct exec 102 -- apt install -y samba
```

Inside the container (`pct enter 102`), append to `/etc/samba/smb.conf`:

```
[Movies]
   path = /media/movies
   read only = no
   browsable = yes
   valid users = joao
   force user = joao
   force group = joao

[TV]
   path = /media/tv
   read only = no
   browsable = yes
   valid users = joao
   force user = joao
   force group = joao

[Minecraft]
   path = /media/minecraft-mods
   read only = no
   browsable = yes
   valid users = joao
   force user = joao
   force group = joao
```

`force user`/`force group` sidesteps ZFS/Samba permission mapping fuss — every file lands owned by the same account regardless of connection details. Then:

```bash
adduser --no-create-home --disabled-password joao
smbpasswd -a joao
systemctl restart smbd
```

From Windows: `\\<CT102-IP>\Movies` (or `\TV`, or `\Minecraft`) in File Explorer's address bar (get the IP via `pct exec 102 -- hostname -I` from the host), authenticate as `joao`.

Give Plex (`CT101`) the same media:

```bash
pct set 101 -mp0 /HDDs/media,mp=/media
```

Then add libraries in Plex's web UI pointed at `/media/movies` and `/media/tv`.

Give the Minecraft server (`CT106`) write access to its own share folder:

```bash
zfs create HDDs/media/minecraft-mods
chmod 777 /HDDs/media/minecraft-mods
pct set 106 -mp0 /HDDs/media/minecraft-mods,mp=/mnt/lan-share
```

**And give `CT102` (Samba) its own direct mount to that same dataset** — see the known-issue section above for why the parent `mp0` alone isn't enough for a dataset created after `CT102` already existed:

```bash
pct set 102 -mp1 /HDDs/media/minecraft-mods,mp=/media/minecraft-mods
pct reboot 102
```

Confirmed working 2026-08-27 — `\\<CT102-IP>\Minecraft` shows `Aetherworks-mods-current.zip` correctly.

## Note for later

The RTL8125 NIC negotiating at 1Gb/s instead of its rated 2.5Gb/s (already on the master project instructions' open list) becomes actually relevant once real transfer volume starts flowing through this share — 1Gb/s caps around 110MB/s. Not a blocker, just the natural trigger to revisit that item if transfers feel slow.

## Still open (unchanged elsewhere)

- Plex vs Jellyfin final choice
- Document storage/serving method (separate from movies/TV — Immich handles photos, this doc only covers movies/TV)
- Role of spare 2TB drive
- 2.5Gb/s NIC link negotiation
