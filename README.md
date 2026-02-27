# NeuroVerse Governance — OpenClaw Plugin

Deterministic governance runtime for OpenClaw agents.

This plugin converts your existing `.md` agent files into a structured `world.json` and enforces guardrails on tool execution.

No AI calls during enforcement. No network requests. Same world + same event = same verdict.

## Install

```bash
openclaw plugins install @neuroverse/governance
```

Or for local development:

```bash
openclaw plugins install -l .
```

### VPS / Cloud Server

The plugin must be installed **where your OpenClaw Gateway is running** — not on your local machine. If OpenClaw runs on a VPS, install the plugin there:

```bash
ssh your-vps
openclaw plugins install @neuroverse/governance
```

### Docker

For Docker-based deployments, add the plugin to your image or mount it at runtime:

**Option A — Install in your Dockerfile:**

```dockerfile
FROM openclaw/gateway:latest
RUN openclaw plugins install @neuroverse/governance
```

**Option B — Mount as a volume:**

```bash
docker run -v /path/to/neuroverse-governance:/app/plugins/neuroverse-governance \
  openclaw/gateway:latest
```

After either method, restart OpenClaw so the plugin loads:

```bash
docker restart openclaw-gateway
```

### Docker Compose

```yaml
services:
  openclaw:
    image: openclaw/gateway:latest
    volumes:
      - ./plugins/neuroverse-governance:/app/plugins/neuroverse-governance
      - ./.neuroverse:/app/.neuroverse  # persist audit logs and world.json
```

**Important:** The `.neuroverse/` directory contains your `world.json`, audit logs, and proposals. Mount it as a volume so governance state persists across container restarts.

## Quick Start

Inside your OpenClaw workspace:

```
/world bootstrap
```

This reads:

- `system.md`
- `tools.md`
- `constitution.md`
- `guardrails.md`
- `personality.md`
- `MEMORY.md` / `memory.md`

And generates:

```
.neuroverse/world.json
```

Governance is now active.

## What Happens at Runtime

Every tool call is evaluated through a deterministic pipeline:

1. **Invariants** — hard BLOCK, never overridable
2. **Guards** — PAUSE or BLOCK, scoped to tools
3. **Rules** — context-aware verdict (e.g. production requires review)
4. **Role constraints** — cannotDo = BLOCK, requiresApproval = PAUSE
5. **Default** — ALLOW

Example:

```
[governance] PAUSE  rm -rf /data
             guard: destructive_shell_requires_approval
             Allow? [y]es once / [a]lways / [n]o:
```

- **y** — allow this once
- **a** — allow for this guard for the rest of the session
- **n** — block it

## Commands

| Command | Description |
|---------|-------------|
| `/world bootstrap` | Generate `world.json` from your `.md` files |
| `/world status` | View governance metrics, drift detection, audit stats |
| `/world propose` | Generate amendment proposals from drift patterns |
| `/world approve <id>` | Approve a proposed amendment |
| `/world export` | Export for use in other NeuroVerse tools |

Also available as CLI commands via `openclaw world <subcommand>`.

## Constitution Drift Detection

When your `.md` files change, the plugin detects it:

- `/world status` shows which files have drifted
- On `/new` (session reset), you're prompted: "Regenerate constitution? [y/n]"
- No silent mutation — governance only updates when you say so

## Audit Log

All verdicts are logged to:

```
.neuroverse/audit.jsonl
```

Append-only. One JSON object per line. Every PAUSE is paired with a decision record.

```jsonl
{"ts":1709000000,"id":"ev-001","tool":"shell","intent":"ls","status":"ALLOW","ruleId":null}
{"ts":1709000001,"id":"ev-002","tool":"shell","intent":"rm -rf /data","status":"BLOCK","ruleId":"invariant:no-destructive-ops","evidence":"rm -rf"}
```

## World File Structure

```json
{
  "version": "1.0.0",
  "kernel": {
    "enforcementMode": "standard",
    "defaultVerdict": "allow",
    "evaluationOrder": ["invariants", "guards", "rules"],
    "sessionOverridesAllowed": true
  },
  "invariants": [],
  "guards": [],
  "rules": [],
  "roles": [],
  "metadata": {}
}
```

## Configuration

In your OpenClaw plugin config:

| Option | Type | Description |
|--------|------|-------------|
| `worldPath` | string | Path to world.json (default: `.neuroverse/world.json`) |
| `enforcement` | string | `strict`, `standard`, or `permissive` |
| `observeFirst` | boolean | Start in observe mode (ALLOW all, record patterns) |
| `verbose` | boolean | Log all verdicts including ALLOW |
| `autoAllow` | boolean | Auto-approve all PAUSE decisions (for CI/headless) |
| `driftTracking` | boolean | Enable background drift monitoring |
| `environment` | string | Override environment detection |

## Agent Tool

The plugin registers a `world_proposal_create` tool that agents can call to propose governance amendments. The human must approve with `/world approve <id>`.

## License

Apache 2.0
