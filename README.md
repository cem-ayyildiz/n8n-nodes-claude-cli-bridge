# n8n-nodes-claude-cli-bridge

n8n community node that calls the locally-installed, subscription-authenticated `claude` CLI directly from inside the n8n process — no Anthropic API key, no separate server to run.

## Why

The official Anthropic n8n node requires an API key (pay-per-token billing). This node instead shells out to the `claude` CLI that's already logged in on the machine (via `claude login`), so usage rides your Claude subscription (Pro/Max/Team) instead.

## How it works

There is no bridge/server process. The node's `execute()` runs `claude -p "<prompt>"` as a child process of the n8n worker itself and returns `{ success, output, error }`. This means:

- **n8n running on bare metal/VM** (no Docker): works out of the box as long as `claude` is on `PATH` and logged in as the user running n8n.
- **n8n running in Docker**: the container needs access to (a) the `claude` binary and (b) the `~/.claude` credentials directory created by `claude login` on the host. See below.

## Install

```bash
npm install n8n-nodes-claude-cli-bridge
```

Or via the n8n UI: **Settings → Community Nodes → Install** → `n8n-nodes-claude-cli-bridge`.

## Credential: Claude CLI

| Field | Description |
|---|---|
| CLI Path | Path to the `claude` binary, or just `claude` if it's on `PATH`. Falls back to the `CLAUDE_CLI_PATH` env var, then `"claude"`. |
| Home Directory | Directory containing `.claude/` with your login credentials. Leave empty to use the process `HOME`. Set this for the Docker setup below. |

## Node: Claude CLI

| Field | Description |
|---|---|
| Prompt | Text sent to `claude -p` |
| Model | Optional `--model` override |
| Attach PDF | Extracts text from a binary PDF input (via `pdftotext`, if installed) and appends it to the prompt |
| Input Binary Field | Name of the binary property holding the PDF (default `data`) |
| Timeout (ms) | Kills the `claude` process if it runs longer than this |

## Running n8n in Docker

The CLI and its login credentials must be reachable from inside the n8n container:

```yaml
services:
  n8n:
    image: n8nio/n8n
    environment:
      - CLAUDE_CLI_PATH=/usr/local/bin/claude
    volumes:
      - /usr/local/bin/claude:/usr/local/bin/claude:ro   # the CLI binary
      - ~/.claude:/home/node/.claude:ro                   # your login credentials
```

Then in the credential, set **Home Directory** to `/home/node` (or wherever you mounted `.claude`). No separate bridge container is needed — the CLI runs directly as a child process of the n8n container itself.

If the host's `claude` binary depends on a Node.js runtime not present in the n8n image, install the `claude` CLI directly inside a custom n8n image instead of bind-mounting the binary.
