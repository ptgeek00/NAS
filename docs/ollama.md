# Ollama / Local LLM Setup — Recommendation & Runbook

_Drafted 2026-08-25. Follows the same pattern as `gpu-passthrough-plex-plan.md` and `jellyfin-gpu-setup-plan.md` (LXC-based GPU sharing, native install, same device list). Both of those docs already flagged "Immich/Ollama GPU use planned earlier" — this is that plan._

## Status: `CT104` up and running with confirmed GPU acceleration — ✅ DONE

As of 2026-08-25: `CT104` (`ollama`) built, GPU passed through, Ollama installed and confirmed using the RTX 3050 — `nvidia-smi` showed `/usr/lib/ollama/llama-server` as a compute process using ~2.5GB VRAM during a `llama3.2:3b` run. The "Unable to detect NVIDIA/AMD GPU" warning the installer printed (see gotcha below) turned out to be cosmetic, not a real problem.

## The core constraint: 8GB VRAM is now a shared, contested resource

The RTX 3050 already serves Plex (`CT101`) and Jellyfin (`CT103`) for NVENC transcoding (shared driver-enforced cap of 3 concurrent encode sessions across both). Adding Ollama and, eventually, Immich's ML (face recognition/CLIP) means up to four consumers competing for 8GB:

- NVENC transcode sessions: small per-session VRAM footprint (roughly 100–300MB each), not the main risk — the 3-session cap is the real limit there, already documented.
- Immich ML (when it lands): CLIP/face-rec models typically resident at ~1.5–3GB while loaded.
- Ollama: this is the biggest single consumer, and the one you control most directly via model choice.

Recommendation: size Ollama's resident model to leave real headroom, and let idle models unload rather than pinning VRAM permanently.

## Model recommendation

Stick to the 7B–8B class at Q4_K_M quantization — this fits comfortably in ~4.5–6GB and leaves 2–3.5GB of headroom for Immich/transcode spikes. Avoid 13B+ models on this card given the concurrent load; even lightly-loaded, a 13–14B Q4 model (~8–9GB) leaves no headroom and will spill to CPU RAM (Ollama handles this automatically, but throughput drops sharply).

| Model | VRAM (Q4_K_M) | Good for |
|---|---|---|
| Llama 3.1 8B | ~5.0GB | General chat/RAG, best ecosystem support |
| Qwen 2.5 Coder 7B | ~4.7GB | Coding, pairs with Continue.dev |
| Mistral 7B | ~4.5GB | Lowest footprint, most context headroom |
| Qwen 2.5 7B | ~4.7GB | Strong reasoning, long context (manage `num_ctx`) |
| Gemma 2 9B | ~6.0GB | Highest quality of this group, but least headroom — keep context ≤4K |
| Llama 3.2 3B | ~2.2GB | Fast autocomplete/summarization, cheap to keep loaded alongside a bigger model — also the model used for the initial GPU smoke test |

Practical pattern: keep a 3B model loaded most of the time for cheap/fast tasks, and load a 7–8B model on demand for anything that needs more capability — rather than always running the biggest model that technically fits.

VRAM-friendly Ollama env vars (systemd drop-in, same mechanism used for `OLLAMA_HOST` below):
```
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_KEEP_ALIVE=5m"
```
This unloads an idle model after 5 minutes so a burst of Plex/Jellyfin transcoding or an Immich ML job doesn't fight a permanently-resident LLM for VRAM.

## Software choice

**Ollama**, consistent with the project's existing plan and with the native-install-over-Docker pattern already used for Plex/Jellyfin (same reasoning: avoids nested Docker + `nvidia-container-toolkit` failure modes for anything touching the GPU directly). Optionally add **Open WebUI** as a chat frontend — it only talks to Ollama's HTTP API and doesn't touch the GPU itself, so Docker (or a plain `pip install open-webui`) is fine for that piece specifically.

## Runbook: dedicated LXC for Ollama

Built as `CT104` (next free ID after `CT100`–`CT103`). Reuses the GPU device list already verified working for `CT101`/`CT103`, pinned by PCI `by-path` rather than `card0`/`renderD128` — see note below.

```bash
# on the Proxmox host
pct create 104 local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst \
  --hostname ollama \
  --cores 6 \
  --memory 12288 \
  --rootfs local-zfs:32 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 0
pct start 104
```

(6 cores / 12GB RAM: generous enough for prompt processing and any CPU-offloaded layers without starving Plex/Jellyfin's existing 4+2 core allocation on an 8c/16t CPU. Adjust down if this box feels tight once Immich lands too.)

Pass the GPU in. Edit `/etc/pve/lxc/104.conf`:
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

**Why `by-path` instead of `card0`/`renderD128`:** those two device nodes are assigned by kernel probe order at boot — stable only as long as nothing else on the bus changes. `/dev/dri/by-path/pci-0000:07:00.0-{card,render}` are symlinks keyed to the GPU's actual PCI address (`07:00.0`, confirmed in `full-inventory_2026-08-17.txt`), so they can't drift even if driver load order changes across a kernel bump or a second GPU/capture device is ever added. **2026-08-25: confirmed `CT101` and `CT103`'s live configs already use `by-path` for exactly this reason — `gpu-passthrough-plex-plan.md` and `jellyfin-gpu-setup-plan.md` have been updated to match.**

```bash
pct reboot 104
```

Matching userspace NVIDIA driver inside the container (version must match the host — currently `595.84`, check `nvidia-smi` on the host first in case it's drifted):
```bash
pct enter 104
cd /tmp
wget https://us.download.nvidia.com/XFree86/Linux-x86_64/595.84/NVIDIA-Linux-x86_64-595.84.run
chmod +x NVIDIA-Linux-x86_64-595.84.run
./NVIDIA-Linux-x86_64-595.84.run --no-kernel-module --silent
nvidia-smi
```

### Install Ollama natively

**The `debian-13-standard` template doesn't ship `curl` or `zstd`** — both are needed before the official install script will run: `curl` to fetch it, `zstd` because the Ollama binary archive is zstd-compressed and the installer fails partway through ("This version requires zstd for extraction") without it.

```bash
apt update
apt install -y curl ca-certificates zstd
curl -fsSL https://ollama.com/install.sh | sh
```

**Gotcha hit during this install: a stray `/etc/hosts` entry silently pointed `ollama.com` at the container's own loopback address.** `CT104`'s `/etc/hosts` had a line resolving `ollama.com` to `127.0.1.1` (the same loopback address Debian conventionally assigns to the container's own hostname, `ollama`) — likely an artifact of the base template or a hostname-collision in local DNS/NSS, not anything deliberately added. Symptom: `curl -fsSL https://ollama.com/install.sh` failed instantly with `Failed to connect to ollama.com port 443 after 0 ms: Could not connect to server` — the "0 ms" and the total absence of an IPv6 candidate in `curl -v` output are the tell that it's a static `/etc/hosts`/NSS hit rather than a real DNS round-trip to the LAN resolver (`nameserver 192.168.1.254`). Fix: `grep -n ollama /etc/hosts`, delete the line resolving `ollama.com` specifically (leave the normal `127.0.1.1  ollama` self-hostname line alone), then retry. Worth checking any other GPU LXCs (`CT101`/`CT103`) or future ones for the same stray entry if outbound HTTPS to a specific domain ever mysteriously fails instantly like this again.

**Gotcha: the installer's "Unable to detect NVIDIA/AMD GPU" warning is cosmetic here, not a real failure.** `install.sh` uses `lspci`/`lshw` (neither present on this minimal template) just to decide whether to auto-install extra OS-level GPU packages — it has nothing to do with whether Ollama can use the GPU at runtime, which depends only on the NVIDIA driver already installed manually in the step above. Confirmed working via `nvidia-smi` showing the `llama-server` process consuming VRAM during a real inference run (see Status above). Optionally `apt install -y pciutils` so a future reinstall doesn't print the warning, but it's not required for functionality.

Then configure it to listen beyond localhost and stay VRAM-friendly:
```bash
mkdir -p /etc/systemd/system/ollama.service.d
cat >/etc/systemd/system/ollama.service.d/override.conf <<'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_KEEP_ALIVE=5m"
EOF
systemctl daemon-reload
systemctl restart ollama
nvidia-smi   # confirm the ollama process shows up here once a model is loaded
```

Pull a starter model:
```bash
ollama pull llama3.1:8b
ollama pull qwen2.5-coder:7b
```

**Note on `ollama run <model> "<prompt>"` vs interactive chat:** passing a quoted prompt as an argument does a single one-shot reply and exits straight back to the shell — it does not stay in a chat session. Run `ollama run <model>` with no trailing argument to get an interactive `>>>` prompt for a real back-and-forth conversation (`/bye` or Ctrl+D to exit).

## Still open

- Whether to also deploy Open WebUI (and where — same LXC or separate), and whether to expose Ollama's API to other services (e.g. a future automation/agent tooling) beyond just a chat UI.
- Final RAM/core sizing once Immich is actually deployed and its real usage is known — the 12GB/6-core figure above is a starting estimate, not measured.
- Whether `nvidia-patch` (already noted as a maybe-need in the Plex doc for the 3-session NVENC cap) becomes relevant here too — it's transcode-specific, not an Ollama VRAM issue, but worth linking mentally since it's the same GPU.
- Root cause of the stray `/etc/hosts` `ollama.com` entry — not yet identified, just worked around.
