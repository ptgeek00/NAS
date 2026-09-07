# Open WebUI + Knowledge Base (RAG) — Runbook

_Drafted 2026-08-25, not yet executed. Gives Ollama (`CT104`) a proper chat UI plus a document-reference workflow modeled on how this Claude Project works — upload your runbooks/docs, reference them in chat with citations. See the "Still open" section in `ollama-llm-setup-plan.md` for how this fits in._

## Decisions this runbook makes

- **New LXC (`CT105`, hostname `openwebui`)** rather than folding into `CT104` — same "one container, one job" pattern as the rest of this stack. It never touches the GPU (it only calls Ollama's HTTP API over the network), so it doesn't need any `devN:` passthrough.
- **Docker, not native install** — unlike Plex/Jellyfin/Ollama, Open WebUI has no GPU dependency, so the reasons to avoid Docker (nested `nvidia-container-toolkit` failure modes) don't apply here. Docker is genuinely the easiest way to run and upgrade it.
- **Unprivileged container with `nesting=1,keyctl=1`**, not privileged. The privileged choice made for `CT101`/`CT102`/`CT103` was specifically to avoid unprivileged UID/GID remap pain on ZFS bind mounts — this container doesn't bind-mount ZFS datasets, it just needs Docker-in-LXC to work, which the nesting/keyctl features handle.
- **Ollama embeddings (`nomic-embed-text`) for RAG**, not Open WebUI's bundled CPU-only default — keeps the embedding step on `CT104` alongside everything else GPU-adjacent, and it's a small model (~274MB) so the VRAM cost is minor.

## 1. Create the LXC

```bash
# on the Proxmox host
pveam update
pveam available --section system | grep debian-13
pveam download local <exact-filename-from-above>

pct create 105 local:vztmpl/<exact-filename> \
  --hostname openwebui \
  --cores 2 \
  --memory 4096 \
  --rootfs local-zfs:16 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --unprivileged 1 \
  --features nesting=1,keyctl=1
pct start 105
```

(2 cores / 4GB RAM / 16GB disk — Open WebUI itself is light, but leave headroom for the Docker image, its SQLite/vector DB, and document uploads. Bump the disk if you plan to upload a lot of large PDFs.)

## 2. Install Docker inside the container

Same gotcha as `CT104`: the `debian-13-standard` template ships without `curl`.

```bash
pct enter 105
apt update
apt install -y curl ca-certificates
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

## 3. Run Open WebUI, pointed at `CT104`'s Ollama

Get `CT104`'s IP first (`pct exec 104 -- hostname -I` from the host), then inside `CT105`:

```bash
docker run -d \
  -p 3000:8080 \
  -e OLLAMA_BASE_URL=http://<CT104-IP>:11434 \
  -v open-webui:/app/backend/data \
  --name open-webui \
  --restart unless-stopped \
  ghcr.io/open-webui/open-webui:main
```

Browse to `http://<CT105-IP>:3000`. The **first account you create becomes the admin account** — do this immediately, don't leave it open. Confirm the model dropdown lists whatever you've already pulled on `CT104` (`llama3.1:8b`, `qwen2.5-coder:7b`, etc.) — if it's empty, double-check `OLLAMA_BASE_URL` and that `CT104`'s Ollama is bound to `0.0.0.0` (it should be, from the earlier systemd override).

## 4. Fix Ollama's default context window before using RAG

Ollama defaults new model instances to a 2048-token context, which quietly truncates retrieved document chunks and makes RAG answers noticeably worse. In Open WebUI: **Workspace → Models → (select a model) → edit → Advanced Params → set `num_ctx`** — 8192 is a reasonable starting point.

This trades VRAM for context: a bigger `num_ctx` means a bigger KV cache resident on the GPU alongside the model weights, on top of whatever Plex/Jellyfin/Immich are using at the same time. If you start seeing OOM errors or slower responses under load, bring `num_ctx` back down before assuming something else is broken.

## 5. Set up embeddings for RAG

On `CT104`:
```bash
ollama pull nomic-embed-text
```

Back in Open WebUI: **Admin Settings → Documents → Embedding Model** → set to `nomic-embed-text` (Ollama). Leave chunking at the defaults to start (~1500 chars, 100 overlap) and enable **markdown header splitting** — your project docs are heavily-headered runbooks, so splitting on `#`/`##`/etc. will keep retrieved chunks coherent instead of cutting mid-section.

## 6. Upload documents and use them in chat

**Workspace → Knowledge → New Knowledge Base** — name it something like `homelab-docs`, upload the markdown runbooks (this doc, the Plex/Jellyfin/Ollama ones, `full-inventory`, etc.) or point it at whatever documents you want the model to reference. Files get chunked and embedded automatically on upload.

Two ways to use it in chat:
- **Per-message:** type `#` in the chat box, pick the knowledge base or an individual document — a document icon appears above the send button confirming it's attached for that message, with citations back to source chunks in the reply.
- **Always-on, closer to how this Project works:** **Workspace → Models → Create a Model** — this makes a custom persona (a system prompt + a base model + a Knowledge Base attached by default) that shows up in the model picker. Anything you ask it automatically has your docs in context without retyping `#` each time — this is the closest local equivalent to how I already have your project docs available in every message here.

## Known limits, set expectations before relying on this

- **Answers are only as good as the base model** (7B–8B class per the VRAM budget in `ollama-llm-setup-plan.md`) — retrieval quality can be good, but synthesis/reasoning over what's retrieved will be noticeably weaker than what you're used to here.
- **Open WebUI's "Artifacts" feature does not render Markdown/plain documents** — only HTML/SVG/JS visualizations. It's not a substitute for the model writing and saving actual document files; chat output is still just text you'd copy out yourself unless you wire up the separate file-write tool path (see the "still open" note below and the earlier conversation on Aider as the more realistic option for actual file edits).
- **This does not give the model the ability to read/write files or run commands on your server** — it's a chat-plus-retrieval UI, not an agent. That's a deliberate scope limit for this runbook; see `ollama-llm-setup-plan.md`'s discussion of why reliable local tool-calling realistically needs larger models than this GPU can hold.

## Still open

- Whether to also set up Open WebUI's "Tools" (Python function-calling) or "Open Terminal" feature for actual file read/write from chat — flagged in the earlier conversation as unreliable below ~30B parameter models, so likely not worth the complexity on this hardware, but revisit if a stronger local model ever becomes practical here.
- Whether to reverse-proxy this behind the same cert/hostname setup as `proxmox-cert-and-hostname-plan.md`, or just access it by container IP:port for now.
- User accounts: single-admin-only for now, or set up additional accounts if anyone else in the household will use it.
