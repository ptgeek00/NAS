# Modded Minecraft Server — Setup Plan (Aetherworks pack, NeoForge 1.21.1)

Occasional-use modded server, hosted as a Proxmox LXC. LAN-only for now, with a documented path to open it up to remote friends later.

## Update: a friend shared a ready-made pack — verified, and it changes the plan

Someone shared a complete pack for this build, called **Aetherworks**, as two `.mrpack` files (Modrinth's official modpack format) plus setup scripts, in `Downloads\modpack zips\Reeves pack` on your PC:

- `Aetherworks-1.21.1.mrpack` — the **client** pack, 198 mods.
- `Aetherworks-1.21.1-SERVER.mrpack` — the **server** pack, 176 mods (client-only mods correctly stripped).
- `READ-ME-FIRST.txt` / `READ-ME-FIRST_Server.txt` — instructions from whoever built it.
- `SETUP.ps1` / `START-SERVER.bat` — Windows scripts to build and run a server from the pack.

**I checked it against your original mod list, and it's essentially a complete match:** I extracted both packs' manifests and diffed them against `modpacks.txt`. Of 198 mods, 191 are byte-identical filenames, and 7 are the same mod at a slightly newer version (normal drift — e.g. `voicechat...2.6.21.jar` → `2.6.22`), plus one mod that was renamed by its author (`moogs_structures` → `MoogsStructureLib`, an alpha-to-stable graduation). Nothing from your list is missing, and nothing unexplained was added. The server pack strips exactly the 22 mods you'd expect to be client-only (Sodium, Iris, EntityCulling, AmbientSounds, minimap, MouseTweaks, NotEnoughAnimations, ImmediatelyFast, and so on) — more thoroughly and more reliably than the manual list I'd put together earlier.

This also explains the whole CurseForge saga from before: the **8 "Loot Integrations" mods** I confirmed weren't on Modrinth are bundled directly *inside* the pack file itself (`overrides/mods/`), pre-downloaded by whoever built it — along with 7 other mods it just ships directly rather than fetching. The pack sidesteps that problem entirely.

**I also read `SETUP.ps1` line by line before recommending it — it's safe.** It only talks to three places: Modrinth (mod downloads, each one SHA-512-verified against the pack's manifest — a corrupted or tampered download is rejected, not used), `maven.neoforged.net` (the official NeoForge installer), and Mojang (via that installer, standard). Nothing else, no obfuscation, nothing written outside the folder you run it in.

**One catch: those scripts are Windows-only** (PowerShell + `.bat`), built for hosting on a Windows PC — but our plan hosts this on the Proxmox LXC (Linux). The `.mrpack` files themselves are just portable zip files, so below is a Linux equivalent of `SETUP.ps1` that does the same thing (extract bundled files, download the rest from Modrinth with the same SHA-512 verification, install NeoForge) for the container. Everything else in this plan (LXC sizing, screen/systemd, connecting, going remote later) is unaffected — the pack replaces steps 3–4 of the *old* plan (the manual "fetch each mod, hunt CurseForge for the rest" process), nothing else.

## Decisions this plan makes for you (flag if you want them different)

| Choice | Value | Why |
|---|---|---|
| Hosting | LXC (your pick) | Cheap to start/stop for occasional play, near-zero cost when off |
| LXC OS | Debian 13 (trixie) | Matches host base, has Java 21 natively |
| CTID | `106` | `100` original LXC, `101` Plex, `102` Samba, `103` Jellyfin, `104` Ollama, `105` Open WebUI all already in use |
| CPU cores | 6 of 8 | Leaves headroom for Proxmox + anything else; bump to 8 if nothing else runs while you play |
| Container memory | `12288` MB (12GB) | Must be *bigger* than the JVM heap below — the gap is headroom for off-heap JVM stuff (thread stacks, JIT, native libs from mods like Create/VoiceChat/Chunky). Set the heap equal to or above the container limit and the LXC's own kernel OOM-killer silently kills the `java` process — that's what a bare `Killed` in the terminal with no Java crash log means |
| RAM (heap) | `Xmx10G` / `Xms10G` | Mid-range for this pack size (176 server mods); leaves 2GB of the 12GB container limit for off-heap — see above |
| Root disk | 60GB on `local-zfs` (your NVMe mirror) | Mods (~2–3GB) + world + backups all benefit from NVMe latency; SMR `HDDs` pool is a poor fit for a live world's small random writes |
| Autostart on host boot | Off | You said "occasional" — no point idling RAM |

Storage note: I deliberately kept the whole container on the NVMe `rpool`/`local-zfs`, not the `HDDs` RAIDZ1 pool, because SMR drives are exactly the kind of thing that struggles with a Minecraft world's constant small region-file writes. `SimpleBackups` (already in the pack) runs automatically and writes into the server folder — same advice as before applies: an easy extra layer of safety later is periodically copying that backups folder from the host side onto `HDDs`, e.g. `zfs snapshot`/`zfs send`, or a plain `rsync`. Not required to get started.

---

## 1. Create the LXC

Check the current Debian 13 template name and pull it if you don't have it cached:

```bash
pveam update
pveam available | grep debian-13
pveam download local debian-13-standard_13.*_amd64.tar.zst   # use the exact filename from the line above
```

Create the container (adjust the template filename to match what you downloaded):

```bash
pct create 106 local:vztmpl/debian-13-standard_13.x-x_amd64.tar.zst \
  --hostname minecraft \
  --cores 6 \
  --memory 12288 \
  --swap 2048 \
  --rootfs local-zfs:60 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 \
  --onboot 0 \
  --features nesting=0
```

Start it and get a shell:

```bash
pct start 106
pct enter 106
```

(Optional but recommended once you plan to forward a port later: give it a static LAN IP now instead of DHCP — either a DHCP reservation on your router keyed to its MAC, or set `--net0 name=eth0,bridge=vmbr0,ip=192.168.x.x/24,gw=192.168.x.1` to match your LAN.)

## 2. Base packages + Java 21

Inside the container:

```bash
apt update && apt full-upgrade -y
apt install -y openjdk-21-jdk curl wget unzip zip screen python3

java -version   # confirm it reports 21.x
```

Create a dedicated user and working directory (don't run the server as root):

```bash
useradd -m -s /bin/bash minecraft
mkdir -p /opt/minecraft/server
chown -R minecraft:minecraft /opt/minecraft
```

**About that scp in the next step needing a password:** `useradd` on its own leaves the account locked — no password at all, not an empty one — so `minecraft@<container-ip>` can't authenticate yet. Pick one, still as root:

- **Quick fix:** `passwd minecraft` and set one interactively. Good enough for a homelab box only reachable on your LAN.
- **Cleaner (no password, ever):** copy your PC's SSH public key in instead. From your PC, if you don't already have a keypair: `ssh-keygen -t ed25519` (any prompts can be left at defaults), then copy the contents of `~/.ssh/id_ed25519.pub` (or wherever it landed) and, back on the container as root:
  ```bash
  mkdir -p /home/minecraft/.ssh
  echo "paste-your-public-key-here" >> /home/minecraft/.ssh/authorized_keys
  chown -R minecraft:minecraft /home/minecraft/.ssh
  chmod 700 /home/minecraft/.ssh
  chmod 600 /home/minecraft/.ssh/authorized_keys
  ```

Either way, once that's done:

```bash
su - minecraft
cd /opt/minecraft/server
```

## 3. Build the server from the Aetherworks pack

**Get the server pack onto the container.** From your PC (adjust IP/path — the file is in `Downloads\modpack zips\Reeves pack`):

```bash
scp "C:\Users\killweeaboos\Downloads\modpack zips\Reeves pack\Aetherworks-1.21.1-SERVER.mrpack" minecraft@<container-ip>:/opt/minecraft/server/
```

**Run this setup script** — it's the Linux equivalent of the pack's own `SETUP.ps1`: it unpacks the bundled configs and mods (including the 8 Loot Integrations mods and the others shipped directly in the pack), downloads the rest from Modrinth with the same SHA-512 verification the Windows version does, then installs NeoForge 21.1.248 the normal way.

Save this as `/opt/minecraft/server/setup.sh` (still as the `minecraft` user):

```bash
#!/bin/bash
set -euo pipefail

ROOT="/opt/minecraft/server"
NEOFORGE="21.1.248"
PACK="$ROOT/Aetherworks-1.21.1-SERVER.mrpack"
cd "$ROOT"

if [ ! -f "$PACK" ]; then
  echo "Missing $PACK — scp it here first." >&2
  exit 1
fi

mkdir -p mods
WORK=$(mktemp -d)
unzip -q "$PACK" modrinth.index.json -d "$WORK"

echo "Unpacking configs and bundled mods..."
unzip -oq "$PACK" 'overrides/*' -d "$WORK/ov"
( cd "$WORK/ov/overrides" && find . -type f ) | while IFS= read -r f; do
  dest="$ROOT/${f#./}"
  mkdir -p "$(dirname "$dest")"
  cp "$WORK/ov/overrides/${f#./}" "$dest"
done
echo "  $(find "$WORK/ov/overrides" -type f | wc -l) files"

echo "Downloading mods from Modrinth (SHA-512 verified)..."
python3 - "$WORK/modrinth.index.json" "$ROOT" <<'PYEOF'
import json, sys, os, hashlib, urllib.request

idx = json.load(open(sys.argv[1]))
root = sys.argv[2]
done = skip = 0
failed = []

def sha512(path):
    h = hashlib.sha512()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

files = idx["files"]
for i, f in enumerate(files, 1):
    dest = os.path.join(root, f["path"])
    want = f["hashes"]["sha512"]

    if os.path.exists(dest) and sha512(dest) == want:
        skip += 1
        continue

    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    try:
        urllib.request.urlretrieve(f["downloads"][0], tmp)
        if sha512(tmp) != want:
            os.remove(tmp)
            print(f"  HASH MISMATCH: {f['path']}")
            failed.append(f["path"])
        else:
            os.replace(tmp, dest)
            done += 1
    except Exception as e:
        print(f"  FAILED: {f['path']} ({e})")
        failed.append(f["path"])

    if i % 25 == 0:
        print(f"  {i} / {len(files)}")

print(f"downloaded {done}, already present {skip}, failed {len(failed)}")
if failed:
    print("Re-run this script to retry — it skips what it already has.")
    sys.exit(1)
PYEOF

echo "mods folder now holds $(find "$ROOT/mods" -maxdepth 1 -name '*.jar' | wc -l) jars"
rm -rf "$WORK"

if [ ! -f "$ROOT/libraries/net/neoforged/neoforge/$NEOFORGE/unix_args.txt" ]; then
  echo "Downloading NeoForge $NEOFORGE installer..."
  wget -q "https://maven.neoforged.net/releases/net/neoforged/neoforge/$NEOFORGE/neoforge-$NEOFORGE-installer.jar" -O neoforge-installer.jar
  java -jar neoforge-installer.jar --installServer
  rm -f neoforge-installer.jar
else
  echo "NeoForge $NEOFORGE already installed, skipping."
fi

if [ ! -f "$ROOT/server.properties" ]; then
cat > "$ROOT/server.properties" <<'EOF'
motd=Aetherworks
online-mode=true
max-players=10
server-port=25565
view-distance=10
simulation-distance=8
allow-flight=true
spawn-protection=0
sync-chunk-writes=false
white-list=true
difficulty=normal
level-name=world
EOF
  echo "Wrote server.properties (whitelist is ON by default)."
fi

echo "Setup complete."
```

`allow-flight=true` is deliberate, not a default I'd normally leave on — the pack's own README flags it explicitly: Aether wings, Ars Nouveau flight, and Create Aeronautics aircraft all trip the anti-cheat's flight detection if it's `false`, kicking players mid-air. Leave it as-is.

Run it:

```bash
chmod +x setup.sh
./setup.sh
```

This will take a while (downloading and hash-verifying however many mods aren't bundled, then the NeoForge install) — let it run. If anything fails partway, just run `./setup.sh` again; like the Windows version, it skips what it already has and retries the rest.

Set your heap size in `user_jvm_args.txt` (created by the NeoForge installer, sitting right next to `run.sh` at `/opt/minecraft/server/user_jvm_args.txt`):

```bash
nano user_jvm_args.txt
```

```
-Xms10G
-Xmx10G
```

Accept the EULA (server won't start without this):

```bash
echo "eula=true" > eula.txt
```

## 4. First run (foreground, to catch problems)

```bash
cd /opt/minecraft/server
./run.sh
```

Watch the log. With ~176 server-side mods, first startup (registry loading + world gen setup) can take several minutes — that's normal, not a hang. Once it prints something like `Done (X.Xs)! For help, type "help"`, it's up. Type `stop` and hit enter to shut it down cleanly before moving to step 5.

If it crashes, `logs/latest.log` (or the crash report it points you to) names the mod — the pack's own README calls out the exact pattern to look for: `Missing or unsupported mandatory dependencies: Mod ID: 'x', Requested by: 'y'`. Given this pack is verified and hash-checked, a crash at this stage is much more likely to be a Java version or memory problem (recheck steps 2 and 3) than a genuinely broken mod.

**If instead you just see `Killed` with no crash report at all** (often mid-worldgen, e.g. right after a `bettercaves`/`wover`/structure-mod log line), that's the LXC's kernel OOM-killer, not Java — it means the JVM's actual memory use (heap + off-heap: thread stacks, JIT, native libraries) exceeded the container's `--memory` limit, so the kernel killed the process outright with no chance to log anything. Confirm it on the **Proxmox host** (not inside the container — unprivileged LXCs don't get their own kernel log):

```bash
dmesg -T | grep -i "killed process" | tail -5
```

If that shows `java`, bump the container's memory ceiling above the heap size (it needs headroom, not just to match it) and restart:

```bash
pct set 106 -memory 12288   # if it's still at the old 10240
pct reboot 106
```

Then re-enter the container and run `./run.sh` again.

## 5. Run it via `screen` so you can start/stop occasionally without staying SSH'd in

**Always `cd` into the server folder before starting `screen` — don't just point `screen` at `run.sh` by its full path.** `run.sh` (generated by the NeoForge installer) resolves `mods/`, `libraries/`, `world/`, `logs/` etc. relative to whatever directory the shell was in when it launched, not relative to the script's own location. If you start it from a login shell (e.g. `su - minecraft -c "..."`, which drops you in `/home/minecraft`) without `cd`-ing first, it'll silently run against whatever happens to exist in that wrong directory instead of your real install — no error, just a server that looks alive but has none of your mods, world, or logs. (This actually happened during setup: a leftover NeoForge install sitting directly in `/home/minecraft` from early testing caused exactly this — a "server" that accepted connections but booted vanilla-only in ~1 second instead of the real ~75-second, 176-mod boot. It's since been cleaned up, but the lesson stands.)

```bash
cd /opt/minecraft/server
screen -dmS mc ./run.sh
```

or, in one line from outside the container:

```bash
pct exec 106 -- su - minecraft -c "cd /opt/minecraft/server && screen -dmS mc ./run.sh"
```

To check on it / send commands (like `/save-all`, `/stop`, or the whitelist commands below) at the in-game console:

```bash
screen -r mc          # attach
# Ctrl+A then D to detach without stopping the server
```

To stop it gracefully from outside the screen session:

```bash
screen -S mc -X stuff "stop$(printf '\r')"
```

**If `stop` hangs** (the log shows `Stopping server` → `Saving worlds` → `waiting for N chunks to unload` and then nothing, for longer than a minute or two — this happened once, likely a C2ME chunk-save interaction): the process is deadlocked but still holds the port, so `ss -tlnp | grep 25565` will misleadingly show it as "listening" and healthy. Don't trust that alone. Find and force-kill it, confirm the port is actually free, then restart clean:

```bash
pct exec 106 -- ss -tlnp | grep 25565     # note the pid
pct exec 106 -- kill -9 <pid>
pct exec 106 -- ss -tlnp | grep 25565     # should now be empty
```

Then restart with the `cd`-first command above, and don't trust a stale-looking `tail logs/latest.log` either — attach live with `screen -r mc` and watch for the real `Done (X.Xs)!` line before reconnecting.

### Optional: a systemd unit for convenience

As root inside the container, `/etc/systemd/system/minecraft.service`:

```ini
[Unit]
Description=NeoForge Minecraft Server
After=network.target

[Service]
User=minecraft
WorkingDirectory=/opt/minecraft/server
ExecStart=/usr/bin/screen -DmS mc /opt/minecraft/server/run.sh
ExecStop=/usr/bin/screen -S mc -X stuff "stop$(printf '\\r')"
Restart=no
Type=simple
TimeoutStopSec=180

[Install]
WantedBy=multi-user.target
```

**Note on `Type=simple` (corrected 2026-08-27 — this used to say `Type=forking` + `GuessMainPID=no`, which is broken):** `screen -DmS` (capital `-D`) deliberately keeps `screen` running in the foreground rather than forking away and exiting, which is exactly what `Type=simple` expects — systemd tracks `screen` itself as the main process. `Type=forking` expects the opposite (the launched process forks a child and its parent exits immediately), which never happens here, so it just times out after 90 seconds with "Job for minecraft.service failed because a timeout was exceeded." `ExecStop` still works the same way under `Type=simple` — it sends `stop` into the console, and since `run.sh` is the only window in that screen session, `screen` itself exits naturally once the server's graceful shutdown finishes, satisfying systemd's wait. `TimeoutStopSec=180` gives that shutdown headroom given the hung-shutdown issue documented earlier in this plan.

```bash
systemctl daemon-reload
systemctl enable minecraft    # starts automatically whenever the container itself boots — no manual step after `pct start`
systemctl start minecraft     # start now (first time, or right after enabling)
systemctl stop minecraft      # stop when done
```

**Checking on it:** `systemctl status minecraft` should show `active (running)` almost immediately (no more timeout). To see the live console, attach as the `minecraft` user specifically — root can't see another user's screen session: `su - minecraft -c "screen -r mc"` (Ctrl+A then D to detach without stopping it).

**Updated decision (was "off," now "on"):** the service is enabled, so from now on `pct start 106` alone is enough — the server comes up on its own once the container finishes booting, no separate `pct exec 106 -- systemctl start minecraft` needed. This is a different switch from the LXC's own `--onboot` flag, which is still **off** — the container itself still only starts when you run `pct start 106` (or `pct reboot 106`), it does not come up automatically when the Proxmox host itself boots. So: start the container → server follows automatically; host reboots → container (and therefore the server) stays off until you start it. Stop the LXC itself (`pct stop 106`) when you're done playing to free the RAM/CPU back to the host entirely — `systemctl stop minecraft` first if you want the graceful in-game shutdown/save rather than relying on the container stop to signal it.

## 6. Whitelist your players

The pack ships with `white-list=true`. In the `screen` console (or systemd's journal isn't interactive, so use `screen -r mc` regardless):

```
whitelist add TheirUsername
whitelist add YourUsername
op YourUsername
whitelist list
```

Usernames are case-sensitive and checked against Mojang — have people paste their exact username rather than typing it from memory.

## 7. Connect (LAN, for now)

Find the container's LAN IP:

```bash
pct exec 106 -- ip -4 a show eth0
```

In the Minecraft launcher, add server `<container-ip>:25565`.

## 8. When you're ready for remote friends (not needed yet)

The pack's own README lists three options, in the order I'd try them too:

1. **[playit.gg](https://playit.gg)** — easiest, free, nothing for your players to install. Install the agent on whichever machine can reach the LXC, add a tunnel of type "Minecraft Java" pointed at the container's LAN IP, port 25565, and share the address it gives you. Leave "Proxy Protocol" **off** — NeoForge can't read it and every connection silently fails.
2. **Tailscale** — private, nothing exposed to the internet, but every player installs it too. Worth it specifically because it carries the voice chat's UDP port automatically (see below), with no extra port-forwarding.
3. **Port forwarding** — best latency, no third party, but requires forwarding TCP 25565 on your router to the container's **static** LAN IP (this is why a static/reserved IP from step 1 matters — a forward pointed at a DHCP-assigned address breaks on the next lease renewal) and giving players your home IP, ideally behind a dynamic DNS hostname (DuckDNS, Cloudflare) since that can change.

Whichever you pick: test it yourself first, connecting with your own Minecraft client using the public address rather than `localhost` — that exercises the actual path your friends will use.

**Voice chat note:** the pack includes proximity voice chat (Simple Voice Chat), which needs UDP port 24454 in addition to the game's TCP 25565. If you only forward/tunnel the game port, players get a harmless "voice chat unavailable" warning and nothing else breaks — plenty of groups just use Discord instead. If you do want it working: forward UDP 24454 too, and for playit.gg specifically set `voice_host=<the address and port the tunnel gives you>` in `config/voicechat/voicechat-server.properties`; leave it blank for Tailscale or plain port forwarding.

## Verification checklist

- [ ] `java -version` inside the container reports 21.x
- [ ] `./setup.sh` completes with 0 failed downloads
- [ ] `eula.txt` has `eula=true`
- [ ] `./run.sh` reaches `Done (X.Xs)!` with no mod crash in the log
- [ ] `server.properties` has `allow-flight=true` (don't turn this off)
- [ ] Heap set correctly — check via `screen -r mc` then `/tps` or watch RAM with `pct exec 106 -- free -h` while a couple of players are on
- [ ] `whitelist list` shows the people you added
- [ ] Server was started with a `cd /opt/minecraft/server` first (not launched from `$HOME` — see step 5's warning) and `screen -r mc` shows the real ~176-mod boot (`Dedicated server took NN seconds to load`), not a ~1-second vanilla-only boot
- [ ] Can connect from a LAN device using `<container-ip>:25565`
- [ ] `pct stop 106` cleanly frees the RAM back on the host (`free -h` on the Proxmox host before/after)
- [ ] Decide + note: final heap size once you've played a session or two (10G may be plenty, or you may want to bump toward 12G)

---

## Client setup — for you and friends

This got much simpler once the Aetherworks pack turned up — no more manually assembling 198 mods.

### 1. Install Prism Launcher

Free, open source, keeps this modpack in its own isolated instance rather than dumping everything into a shared `.minecraft`. Download from [prismlauncher.org](https://prismlauncher.org/download). It offers to install Java 21 for you on first run — say yes.

### 2. Import the pack

```
Add Instance  →  Import  →  Browse  →  pick Aetherworks-1.21.1.mrpack  →  OK
```

That's the **client** pack — `Aetherworks-1.21.1.mrpack`, not the `-SERVER` one — from the same `Downloads\modpack zips\Reeves pack` folder. Prism downloads all ~200 mods and installs Minecraft 1.21.1 + NeoForge 21.1.248 automatically; you don't pick versions yourself, the pack specifies them. Takes about ten minutes, mostly download time.

### 3. Set memory — don't skip this

1. Right-click the instance → **Edit Instance**.
2. In the left sidebar of the window that opens, click **Settings**.
3. Along the top of that page, click the **Java** tab.
4. You'll see three group boxes — Java Installation, **Memory**, Java Arguments — each with its own checkbox, unchecked by default (which is exactly why the field looked missing: unchecked, this instance just inherits Prism's global memory setting instead of showing its own). **Check the box on the Memory group** to turn on a per-instance override.
5. Now the Minimum/Maximum memory fields are editable — set **Maximum memory allocation** to `8192` MB.

The pack can't carry this setting itself. With the default (usually 2GB, from Prism's global setting) it'll stutter badly or crash while loading.

### 4. First launch

Hit Launch. The first start takes 3–6 minutes (every mod gets compiled and cached); later starts are much faster. If it crashes on the very first try, launch once more before troubleshooting further.

### 5. Connect

`Multiplayer → Add Server` (or Direct Connection), paste the address from step 7 (LAN) or step 8 (remote) above. Get whitelisted first (step 6 above) and give the host your exact Minecraft username — capitalization matters.

### Worth knowing

- Press **E** for inventory — the item list on the right is EMI. Type `@create` or `@aether` in its search box to filter to one mod's items; `-@chipped` hides the biggest decoration mod and cuts the list by about a third.
- **Shaders**: Iris is already included. Drop a shader `.zip` into the instance's `shaderpacks` folder, then enable it in Options → Video Settings → Shader Packs. Complementary and BSL both work well with this pack.
- If you see "Incompatible client" or a red list of "Channel of mod X failed to connect": your local mod set doesn't match the server's — almost always means the pack wasn't imported cleanly. Delete the instance and re-import the `.mrpack` rather than copying jars into an existing instance; copying leaves the old loader version behind, which is exactly what causes this.
- Anything else: grab `logs/latest.log` from the instance folder (right-click instance → Instance Folder → `logs`) before asking for help — it names the actual problem.

---

## Add-on mods (added after the base pack) — vein mining + storage

Checked against the base 198-mod list on 2026-08-27: no conflicts, nothing overlapping. Added on both client and server — **everyone must use these exact files**, not "whatever's latest," to avoid a repeat of the channel-mismatch saga:

| Mod | Filename | SHA-512 | Client | Server |
|---|---|---|---|---|
| Sophisticated Storage | `sophisticatedstorage-1.21.1-1.5.91.2127.jar` | `d8548870cb96a6fd6f50b22dc4822a8acc68168c85efb7a1878d2e0f853334011ff3e17a14dfdf2a7f3f7dde0e995046650a5ca12b9b881dc378ff3c3275375b` | ✅ | ✅ |
| Sophisticated Backpacks | `sophisticatedbackpacks-1.21.1-3.25.57.1871.jar` | `94799950da617a0574971ae3f7e886e5b1615c30cbd9b2f2874f2bac7a2860505ce89c7c14a7c82beec09675a1a6fc6ab1d0c1ca28e25b974b7aed62663da614` | ✅ | ✅ |
| Sophisticated Core (required dep of both Storage and Backpacks — one copy covers both) | `sophisticatedcore-1.21.1-1.4.89.2291.jar` | `ac6ae564f3b363789db0bd66d8bb58712473ff81c3ee9142af75ef90898036e83b3de885713a7bcacfe4dbe4e54c49d29d040b8d7df53c8a212b5a91f3cff859` | ✅ | ✅ |
| VeinMiner | `veinminer-neoforge-2.11.2+1.21.1.jar` | `195fdfe9f1358e85218e770c953223825d102f54b5f607857b8893959cd2164a04c921987611a7933592ba89a83aa2bd8f3cec0b1fcf7d87a20b168f88b2cc05` | ✅ | ✅ |
| KotlinLangForge (required dep — separate from the pack's existing `kotlinforforge`, both coexist fine) | `KotlinLangForge-2.12.1-k2.4.0-3.0+neoforge.jar` | `6f18bd7407bc6a04703d5a2f0c34ee384fa20245ddbef6bdcf1a4aa86074041ef390e739eb2e30c5366d8ac27fc1ae4df8793eac0e94b85c845a5a0280eb1d48` | ✅ | ✅ |
| VeinMiner Hotkey (optional QoL — bind vein-mining to a key instead of default sneak-while-mining) | `veinminer-client-neoforge-2.11.2+1.21.1.jar` | `7ad476f80a5aee3b030d161f3be643cf01622cce254b9779b8d37137693cd6a9d4740c00ee94e265873b14ab19aa18cc9fb9324e5e9669bb9dc94d34c1c2679e` | optional | not needed (client-only) |
| **JEI — required upgrade** (replaces the base pack's `jei-1.21.1-neoforge-19.27.0.340.jar` on both client and server; delete the old jar) | `jei-1.21.1-neoforge-19.39.0.368.jar` | `e0fedc5dddea7f48a061053f5f3cb8e4805dbd0734ee9ae07809a1766a02c7b6ed938b1d34234628dbb73e21277d9f09dacd20902006c678180ce009f4bc07b3` | ✅ | ✅ |

Sophisticated Backpacks' only required dependency is Sophisticated Core, already covered above — no new library needed. Its optional integrations (Curios, Chipped, JEI) are all already in the base pack — **but discovered 2026-08-27: Sophisticated Core needs JEI 19.32.0.359 or newer, and the base pack's bundled JEI (19.27.0.340) is older than that**, which surfaced as a client-side "Error loading mods" screen on first launch. JEI is bundled in the server pack too, so both sides need the old jar deleted and the new one added — see the JEI row above and the commands below.

Direct download links (Modrinth CDN):
- https://cdn.modrinth.com/data/hMlaZH8f/versions/H7wGZ8Sl/sophisticatedstorage-1.21.1-1.5.91.2127.jar
- https://cdn.modrinth.com/data/TyCTlI4b/versions/7G0STUUO/sophisticatedbackpacks-1.21.1-3.25.57.1871.jar
- https://cdn.modrinth.com/data/nmoqTijg/versions/Wxcy92XH/sophisticatedcore-1.21.1-1.4.89.2291.jar
- https://cdn.modrinth.com/data/OhduvhIc/versions/syKekkIm/veinminer-neoforge-2.11.2%2B1.21.1.jar
- https://cdn.modrinth.com/data/1vrSzlao/versions/j7m3xyCe/KotlinLangForge-2.12.1-k2.4.0-3.0%2Bneoforge.jar
- https://cdn.modrinth.com/data/dxa0Bm8m/versions/dIwSWhIM/veinminer-client-neoforge-2.11.2%2B1.21.1.jar (optional hotkey addon)
- https://cdn.modrinth.com/data/u6dRKJwZ/versions/bEGnP8IF/jei-1.21.1-neoforge-19.39.0.368.jar (JEI upgrade — replaces the old bundled one)

**Server side** — the Proxmox host has normal internet access, so `wget` works directly:

```bash
pct exec 106 -- su - minecraft -c '
cd /opt/minecraft/server/mods
wget -q "https://cdn.modrinth.com/data/nmoqTijg/versions/Wxcy92XH/sophisticatedcore-1.21.1-1.4.89.2291.jar"
wget -q "https://cdn.modrinth.com/data/hMlaZH8f/versions/H7wGZ8Sl/sophisticatedstorage-1.21.1-1.5.91.2127.jar"
wget -q "https://cdn.modrinth.com/data/TyCTlI4b/versions/7G0STUUO/sophisticatedbackpacks-1.21.1-3.25.57.1871.jar"
wget -q "https://cdn.modrinth.com/data/1vrSzlao/versions/j7m3xyCe/KotlinLangForge-2.12.1-k2.4.0-3.0%2Bneoforge.jar"
wget -q "https://cdn.modrinth.com/data/OhduvhIc/versions/syKekkIm/veinminer-neoforge-2.11.2%2B1.21.1.jar"
rm -f jei-1.21.1-neoforge-19.27.0.340.jar
wget -q "https://cdn.modrinth.com/data/u6dRKJwZ/versions/bEGnP8IF/jei-1.21.1-neoforge-19.39.0.368.jar"
ls -la
'
```

**Windows equivalent** — if you'd rather grab these directly on your own PC, run this in PowerShell. It saves straight into the Aetherworks Prism instance's own `mods` folder, so there's no manual copy/drag step afterward:

```powershell
$dest = "$env:USERPROFILE\AppData\Roaming\PrismLauncher\instances\Aetherworks-1.21.1\minecraft\mods"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$files = @{
  "sophisticatedcore-1.21.1-1.4.89.2291.jar"      = "https://cdn.modrinth.com/data/nmoqTijg/versions/Wxcy92XH/sophisticatedcore-1.21.1-1.4.89.2291.jar"
  "sophisticatedstorage-1.21.1-1.5.91.2127.jar"   = "https://cdn.modrinth.com/data/hMlaZH8f/versions/H7wGZ8Sl/sophisticatedstorage-1.21.1-1.5.91.2127.jar"
  "sophisticatedbackpacks-1.21.1-3.25.57.1871.jar" = "https://cdn.modrinth.com/data/TyCTlI4b/versions/7G0STUUO/sophisticatedbackpacks-1.21.1-3.25.57.1871.jar"
  "KotlinLangForge-2.12.1-k2.4.0-3.0+neoforge.jar" = "https://cdn.modrinth.com/data/1vrSzlao/versions/j7m3xyCe/KotlinLangForge-2.12.1-k2.4.0-3.0%2Bneoforge.jar"
  "veinminer-neoforge-2.11.2+1.21.1.jar"          = "https://cdn.modrinth.com/data/OhduvhIc/versions/syKekkIm/veinminer-neoforge-2.11.2%2B1.21.1.jar"
  "jei-1.21.1-neoforge-19.39.0.368.jar"           = "https://cdn.modrinth.com/data/u6dRKJwZ/versions/bEGnP8IF/jei-1.21.1-neoforge-19.39.0.368.jar"
}

Remove-Item -Path (Join-Path $dest "jei-1.21.1-neoforge-19.27.0.340.jar") -ErrorAction SilentlyContinue   # old JEI, incompatible with Sophisticated Core

foreach ($name in $files.Keys) {
    Invoke-WebRequest -Uri $files[$name] -OutFile (Join-Path $dest $name) -UseBasicParsing
}

explorer $dest   # opens the mods folder so you can confirm the jars landed there
```

If your Prism instance is named something other than `Aetherworks-1.21.1`, or Prism's data folder was moved off the default location, adjust `$dest` to match — right-click the instance → **Instance Folder** in Prism will show you the real path if you're not sure.

(The dictionary's left-hand names are set explicitly as the save-as filenames — Modrinth's URLs URL-encode the `+` in a couple of filenames as `%2B`, and this sidesteps any ambiguity about what the saved file ends up called.)

Restart it. Now that the systemd service is fixed and enabled (see step 5), this is the simplest way:

```bash
pct exec 106 -- systemctl restart minecraft
pct exec 106 -- systemctl status minecraft
pct exec 106 -- su - minecraft -c "screen -r mc"
```

(If you're not using the systemd service for some reason, the manual fallback is the same `cd`-first stop/start dance from step 5.)

Check the boot log's "Mod List" block for the 5 new entries plus the bumped JEI version, and the usual `Done (X.Xs)!`.

**Client side (you + every friend)** — to guarantee everyone matches the server exactly, don't have each person search Modrinth separately (too easy to grab a slightly newer version and trigger a channel mismatch). Instead: right-click the instance → **Instance Folder** → `mods` folder → drop in the same jar files (whoever's hosting can zip and send them, or use the LAN share below). Restart the instance.

**Don't forget to republish to the LAN share** after this change — the `Aetherworks-mods-current.zip` on `\\<CT102-IP>\Minecraft` still has the old JEI in it until you re-run the publish script (see "Publishing mod updates to the LAN" below):

```bash
pct exec 106 -- su - minecraft -c "/opt/minecraft/server/publish-mods.sh"
```

**Using them:**
- **Vein mining**: hold sneak (crouch) while breaking one block in a vein (ores, logs) — mines the whole connected vein. With the optional Hotkey addon, check Options → Controls → VeinMiner to bind a dedicated key instead.
- **Sophisticated Storage**: craft a basic Wood Barrel or Wood Chest (search "sophisticated" in JEI/EMI for the recipe), then craft upgrades (Stack Upgrade, Filter Upgrade, Hopper Upgrade, etc.) to slot into it for auto-sorting/auto-pulling.
- **Sophisticated Backpacks**: craft a basic Backpack (search "backpack" in JEI/EMI), wear it in a normal inventory slot or — since Curios is already in the pack — a dedicated Curios accessory slot. Takes the same upgrade items as Sophisticated Storage (Stack Upgrade, Void Upgrade, etc.), since both mods share Sophisticated Core's upgrade system.

---

## Publishing mod updates to the LAN (via the existing SMB share)

One-time setup so any future mod change (like today's) lands as a ready-to-grab zip on the network share, instead of hand-downloading jars per person every time. Builds on the SMB share already documented in `media-storage-smb-plan.md` (`CT102`, Samba, backed by the `HDDs` ZFS pool) — see that doc for the full share layout; this just adds one more folder to it.

**On the Proxmox host, one time:**

```bash
zfs create HDDs/media/minecraft-mods
chmod 777 /HDDs/media/minecraft-mods
```

`chmod 777` is the pragmatic call here, not the tight one — `CT106` (the Minecraft LXC) is **unprivileged**, so a file it creates lands on the host under a shifted UID (the classic unprivileged-LXC 100000+ offset), which would otherwise fight with the `force user = joao` Samba config on the share. Wide-open permissions on this one folder sidesteps that; it's not sensitive data, just a mods zip. Flag it if you'd rather do proper subuid mapping instead.

Mount that same dataset into the Minecraft container:

```bash
pct set 106 -mp0 /HDDs/media/minecraft-mods,mp=/mnt/lan-share
```

**Correction, discovered while testing this:** it does *not* become visible inside `CT102` (Samba) for free. `CT102`'s existing `mp0` only bind-mounts `/HDDs/media` itself — a ZFS dataset mounted *underneath* that path (like `minecraft-mods`) is a separate filesystem layered on top and doesn't show through a plain bind of its parent, even across a reboot of `CT102`. `CT102` needs its own direct mount to this dataset too:

```bash
pct set 102 -mp1 /HDDs/media/minecraft-mods,mp=/media/minecraft-mods
pct reboot 102
```

(Landing it at the exact same path, `/media/minecraft-mods`, the Samba config below expects — so no extra path juggling.) This same nesting quirk could in principle also affect the `Movies`/`TV` shares, since they're set up the identical way — worth a one-time check that files genuinely show up in `\\<CT102-IP>\Movies` and `\\<CT102-IP>\TV`, and if not, the fix is the same pattern: a dedicated `mp` for that specific dataset rather than relying on the parent bind.

**On `CT102` (Samba),** add one more share block to `/etc/samba/smb.conf` (same pattern as the existing `[Movies]`/`[TV]` blocks):

```
[Minecraft]
   path = /media/minecraft-mods
   read only = no
   browsable = yes
   valid users = joao
   force user = joao
   force group = joao
```

```bash
pct exec 102 -- systemctl restart smbd
```

**On `CT106` (Minecraft),** the `zip` command is needed and wasn't part of the original package list from step 2 (only `unzip` was) — install it once:

```bash
pct exec 106 -- apt install -y zip
```

Then a small publish script — save as `/opt/minecraft/server/publish-mods.sh`:

```bash
#!/bin/bash
set -euo pipefail
cd /opt/minecraft/server
zip -rq /mnt/lan-share/Aetherworks-mods-current.zip mods/
echo "Published $(date '+%Y-%m-%d %H:%M') — $(du -h /mnt/lan-share/Aetherworks-mods-current.zip | cut -f1)"
```

```bash
pct exec 106 -- su - minecraft -c "chmod +x /opt/minecraft/server/publish-mods.sh"
```

Run it any time the `mods/` folder changes (like today's vein mining/storage additions):

```bash
pct exec 106 -- su - minecraft -c "/opt/minecraft/server/publish-mods.sh"
```

From Windows, the whole current mod set is then just `\\<CT102-IP>\Minecraft\Aetherworks-mods-current.zip` — same address style as the existing `\\<CT102-IP>\Movies` share. Get `CT102`'s IP the same way as before: `pct exec 102 -- hostname -I` from the host. Whoever's playing extracts that zip's `mods/` contents straight into their Prism instance's `mods` folder — no per-person downloading, and it's always whatever the server currently has, so it can't drift out of sync with what the server's actually running.
