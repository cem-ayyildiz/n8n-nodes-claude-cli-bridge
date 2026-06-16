# n8n-nodes-claude-cli-bridge

n8n community node that calls the locally-installed, subscription-authenticated `claude` CLI directly from inside the n8n process — no Anthropic API key, no separate server to run.

## Why

The official Anthropic n8n node requires an API key (pay-per-token billing). This node instead shells out to the `claude` CLI, authenticated via `claude login`/`claude /login`, so usage rides your Claude subscription (Pro/Max/Team) instead.

## How it works

There is no bridge/server process. The node's `execute()` runs `claude -p "<prompt>"` as a child process of the n8n worker itself and returns `{ success, output, error }`.

- **n8n running on bare metal/VM** (no Docker): works out of the box as long as `claude` is on `PATH` and logged in as the user running n8n.
- **n8n running in Docker**: see the full setup below — this is the path that's actually been tested end-to-end.

## Install

```bash
npm install n8n-nodes-claude-cli-bridge
```

Or via the n8n UI: **Settings → Community Nodes → Install** → `n8n-nodes-claude-cli-bridge`.

## Credential: Claude CLI

| Field | Description |
|---|---|
| CLI Path | Path to the `claude` binary, or just `claude` if it's on `PATH`. Falls back to the `CLAUDE_CLI_PATH` env var, then `"claude"`. |
| Home Directory | Directory containing `.claude/` with login credentials. Leave empty to use the process `HOME`. For the Docker setup below, this is `/home/node`. |

## Node: Claude CLI

| Field | Description |
|---|---|
| Prompt | Text sent to `claude -p` |
| Model | Optional `--model` override |
| Attach PDF | Extracts text from a binary PDF input (via `pdftotext`, if installed) and appends it to the prompt |
| Input Binary Field | Name of the binary property holding the PDF (default `data`) |
| Timeout (ms) | Kills the `claude` process if it runs longer than this |

## Running n8n in Docker (tested, recommended setup)

**Do not bind-mount your host's `claude` binary or `~/.claude` credentials into the container.** This was tried and fails in two separate ways:

1. **Architecture/libc mismatch.** The official `claude` binary is typically glibc-linked. The official n8n image is Alpine (musl). A glibc binary will not run on it even if bind-mounted in.
2. **Single-file bind mounts break on rewrite.** The CLI rewrites `.claude.json` and `.credentials.json` via backup-and-replace (not in-place edit). Docker's file-level bind mount tracks the original inode, so the first time the host rewrites the file, the container's view of it goes stale or disappears.

The setup that actually works: **install the CLI natively inside the container** (matching its own musl/arch), and **log in once, interactively, inside the container**, persisting credentials to named Docker volumes — completely independent of any host-side `claude` login.

### 1. Dockerfile

```dockerfile
FROM docker.n8n.io/n8nio/n8n:latest
USER root
RUN npm install -g @anthropic-ai/claude-code
USER node
```

`npm` automatically resolves the correct platform build (e.g. `@anthropic-ai/claude-code-linux-arm64-musl`), so this works natively inside Alpine without any host binary involved.

### 2. docker-compose.yml

```yaml
services:
  n8n:
    build:
      context: .                # wherever the Dockerfile above lives
      dockerfile: Dockerfile
    environment:
      - N8N_COMMUNITY_NODES_ENABLED=true
      # ... your other n8n env vars
    volumes:
      - n8n_data:/home/node/.n8n
      - claude_home:/home/node/.claude
      - claude_data:/home/node/.local/share/claude

volumes:
  n8n_data:
  claude_home:
  claude_data:
```

Named volumes (not bind mounts) avoid both problems above: they're directories the container fully owns, immune to the host-rewrite/inode issue, and they persist across redeploys.

### 3. Build and deploy

```bash
docker build -t n8n-claude:latest .
docker compose up -d
```

### 4. Fix volume ownership (one-time)

Docker creates a brand-new named volume's mount point owned by `root`. The `node` user n8n runs as can't write to it until you fix this once:

```bash
docker exec -u root -it <container_name> chown -R node:node /home/node/.claude /home/node/.local/share/claude
```

### 5. Log in, interactively, inside the container

```bash
docker exec -it <container_name> sh -c 'HOME=/home/node claude'
```
Type `/login` at the prompt, complete the browser-based OAuth flow (it'll give you a URL since there's no browser in the container), then exit cleanly (Ctrl-D).

Verify it persisted with a **fresh** exec session (important — this confirms it was actually written to disk, not just held in memory for that one session):
```bash
docker exec -it <container_name> sh -c 'HOME=/home/node claude -p "say OK"; echo EXIT:$?'
# should print: OK
#               EXIT:0
```

### 6. Set up the n8n credential

- CLI Path: leave empty
- Home Directory: `/home/node`

That's it — the node now runs fully self-contained inside the n8n container, authenticated against your Claude subscription, with no host dependency and no separate server.
