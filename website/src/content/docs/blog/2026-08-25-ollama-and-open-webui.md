---
title: A fourth mouth at the GPU's table
date: 2026-08-25
authors: ptgeek00
excerpt: CT104 brings Ollama onto the same 8GB card as Plex and Jellyfin, plus a chat frontend that never touches the GPU at all.
tags: [ollama, llm, gpu, open-webui]
featured: true
---

`CT104` is up: Ollama, installed natively, confirmed pulling the RTX 3050 for inference — `nvidia-smi` showed `llama-server` sitting at about 2.5GB of VRAM during a `llama3.2:3b` smoke test.

The real story here is budget, not installation. That 8GB card already serves NVENC transcoding for Plex and Jellyfin, and will eventually serve Immich's face-recognition/CLIP models too. Four consumers, one card. NVENC sessions are cheap individually (100–300MB each — the 3-session cap is the actual limit there, not VRAM). Ollama is the one I control most directly, so the plan is to stay in the 7B–8B class at Q4_K_M — comfortably 4.5–6GB, leaving real headroom — and let `OLLAMA_KEEP_ALIVE=5m` unload an idle model rather than pinning memory permanently. A 3B model stays loaded for cheap/fast tasks; anything bigger loads on demand.

Two gotchas worth remembering: the install script warns "Unable to detect NVIDIA/AMD GPU" because it looks for `lspci`/`lshw`, neither of which exists on the minimal Debian template — purely cosmetic, unrelated to whether Ollama can actually reach the driver at runtime. And a stray `/etc/hosts` entry inside the container was quietly resolving `ollama.com` to loopback, which looks exactly like a dead network until you know to check for it.

Open WebUI (`CT105`) is the planned next piece — a chat frontend that only ever talks to Ollama's HTTP API, so unlike everything else on this GPU it's a fine candidate for Docker rather than a native install. Full detail in [Ollama / local LLM](/ollama/) and [Open WebUI + RAG](/open-webui/).
