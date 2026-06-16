# n8n-nodes-claude-cli-bridge

Custom n8n node for the [claude-cli-bridge](../../bridges/claude-cli-bridge). Wraps the bridge's `/ask` endpoint as a native "Claude CLI Bridge" node instead of a generic HTTP Request node.

## Why

The bridge is already callable from n8n via an HTTP Request node. This package exists for workflows that want:
- A typed UI (Prompt / Model / Attach PDF fields) instead of hand-built JSON bodies
- A reusable credential (`Claude CLI Bridge API` → base URL) shared across workflows/nodes
- A single node abstraction so the double-wrapped-JSON quirk and PDF base64 encoding don't have to be re-implemented per workflow

## Install (community node, self-hosted n8n)

```bash
npm install n8n-nodes-claude-cli-bridge
```

Or for local development against this repo, point n8n's custom extensions dir at this package and build it:

```bash
cd connectors/n8n-nodes/n8n-nodes-claude-cli-bridge
npm install
npm run build
```

Then in n8n: **Settings → Community Nodes → Install**, or set `N8N_CUSTOM_EXTENSIONS` to include this package's parent directory before starting n8n.

## Credential

**Claude CLI Bridge API**
- `Base URL` — e.g. `http://localhost:3456`, or `http://host.docker.internal:3456` when n8n runs in Docker and the bridge runs on the host.

## Node: Claude CLI Bridge

| Field | Description |
|---|---|
| Prompt | Text sent to `claude -p` |
| Model | Optional `--model` override |
| Attach PDF | If enabled, reads a binary input field, base64-encodes it, and sends it as `pdf_base64` |
| Input Binary Field | Name of the binary property holding the PDF (default `data`) |
| Timeout (ms) | HTTP request timeout from n8n's side |

Output is the bridge's raw response: `{ success, output, error }`.
