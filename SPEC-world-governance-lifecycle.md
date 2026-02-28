# World Governance Lifecycle — Specification

**Status:** Draft
**Author:** NeuroVerse governance team
**Date:** 2026-02-28
**Scope:** Defines the full governance lifecycle: bootstrap, approval, runtime integrity, and proactive drift detection.

---

## 1. Problem Statement

The current bootstrap flow is:

```
.md files → /world bootstrap → world.json → engine enforces
```

If a third-party skill (or any external actor) modifies `.md` files and triggers `/world bootstrap`, the governance engine silently compiles and activates the new rules. This means:

- An invariant can be removed without the user knowing.
- A guard threshold can be weakened.
- A new rule can grant permissions that didn't exist before.
- A role's `cannotDo` list can be emptied.

Prompt injections rely on stealth. The fix is not preventing edits — it's preventing **silent activation**.

Beyond bootstrap, the system has no runtime awareness of its own integrity. A tampered `world.json`, a stale pending file, or drifted `.md` sources are all invisible until the user manually checks. The engine must proactively surface these conditions.

---

## 2. Threat Model

| Threat | Vector | Current Defense | Proposed Defense |
|--------|--------|----------------|-----------------|
| Malicious skill edits `.md` files | Skill contains instructions to modify governance source | None | Diff + approval gate |
| Skill triggers `/world bootstrap` after editing | Automated recompile activates poisoned rules | None | Pending state — old world stays active |
| Skill weakens invariant conditions | e.g. changes `contains "rm -rf"` to `contains "xyzzy"` | None | Structural diff highlights condition changes |
| Skill removes guards entirely | `.md` rewrite omits guard section | None | Diff shows removals as `REMOVED` entries |
| Runtime tampering of `world.json` | Direct file edit bypasses bootstrap | None | World hash verification on every evaluate() |
| Injection inside compiled world | Text like "ignore previous invariants" in a field value | Condition engine only evaluates structured fields | Compiler schema validation + UI sanitization |
| Stale pending world forgotten | User bootstraps, forgets to approve | None | Proactive pending reminder on every tool call |
| Source drift undetected | `.md` files change, user doesn't re-bootstrap | Drift checked on /new only | Proactive drift alert on every tool call |

---

## 3. Core Principle

> **No world change takes effect without explicit human approval.**

The system treats world changes like database schema migrations:
1. Generate candidate.
2. Diff against active.
3. Present changes.
4. Wait for approval.
5. Activate.

---

## 4. Governance Lifecycle

### 4.1 Activation Lifecycle

```
Bootstrap → Pending → Diff → Approve → Activate
```

This is the deliberate path. Every world change flows through it. No exceptions.

### 4.2 Runtime Integrity Lifecycle

```
Runtime → Integrity Check → Alert → Human Action
```

This is the heartbeat. The plugin runs on every tool call. Before returning any governance verdict, the engine validates system health.

### 4.3 Combined State Machine

```
                    ┌──────────────────────────────┐
                    │        BOOTSTRAP              │
                    │   .md → compile → candidate   │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────▼───────────────────┐
                    │        PENDING                │
                    │   world.pending.json exists   │
                    │   Old world still enforced    │
                    └──────────┬───────────────────┘
                               │
                 ┌─────────────┼─────────────┐
                 │             │             │
          ┌──────▼──────┐  ┌──▼────┐  ┌─────▼──────┐
          │  /world diff │  │approve│  │  reject    │
          │  (display)   │  │       │  │  (discard) │
          └─────────────┘  └──┬────┘  └────────────┘
                               │
                    ┌──────────▼───────────────────┐
                    │        ACTIVE                 │
                    │   world.json enforced         │
                    │   world.meta.json stores hash │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────▼───────────────────┐
                    │    RUNTIME HEARTBEAT          │
                    │    Every evaluate() call:     │
                    │    1. Verify world hash        │
                    │    2. Check mdHashes drift     │
                    │    3. Detect pending world     │
                    │    4. Validate world state     │
                    │    5. Run governance pipeline  │
                    └──────────────────────────────┘
                               │
                    ┌──────────▼───────────────────┐
                    │    ALERT (if issues found)    │
                    │    Attached to verdict.alerts │
                    │    User sees on next action   │
                    └──────────────────────────────┘
```

---

## 5. World States

A world file can be in one of three states:

| State | File | Enforced | Description |
|-------|------|----------|-------------|
| **ACTIVE** | `world.json` | Yes | Currently enforced by the engine |
| **PENDING** | `world.pending.json` | No | Proposed changes awaiting approval |
| **ARCHIVED** | `world.history/<version>.json` | No | Previous active worlds, kept for audit |

### 5.1 Fail-Closed State Guards

The engine must handle degenerate states. If any of the following are true, the engine defaults to **BLOCK with system alert**:

| Condition | Engine Response |
|-----------|----------------|
| `world.json` missing but `world.meta.json` exists | BLOCK — world was deleted outside pipeline |
| `world.meta.json` missing but `world.json` exists | First-load migration (see §14) |
| `world.meta.json` hash ≠ computed hash of `world.json` | BLOCK — tampering detected |
| `world.json` fails schema validation | BLOCK — corrupted world |
| `world.json` version field unsupported | BLOCK — incompatible world |

**Fail closed. Not open.** A governance system that becomes permissive under attack is not a governance system.

---

## 6. World Diff

A structured comparison between two world files. Not a text diff — a **semantic diff** that understands governance primitives.

```typescript
interface WorldDiff {
  invariants: {
    added: Invariant[];
    removed: Invariant[];
    modified: { before: Invariant; after: Invariant; changes: string[] }[];
    unchanged: number;
  };
  guards: {
    added: Guard[];
    removed: Guard[];
    modified: { before: Guard; after: Guard; changes: string[] }[];
    unchanged: number;
  };
  rules: {
    added: Rule[];
    removed: Rule[];
    modified: { before: Rule; after: Rule; changes: string[] }[];
    unchanged: number;
  };
  roles: {
    added: Role[];
    removed: Role[];
    modified: { before: Role; after: Role; changes: string[] }[];
    unchanged: number;
  };
  kernel: {
    changed: boolean;
    before: Kernel | null;
    after: Kernel;
  };
  severity: 'none' | 'low' | 'high' | 'critical';
}
```

### 6.1 Severity Classification

The diff engine assigns a severity to the overall changeset:

| Severity | Trigger |
|----------|---------|
| `none` | No structural changes |
| `low` | Only additions (new guards, new rules, stricter invariants) |
| `high` | Modifications to existing rules, condition changes, enforcement level changes |
| `critical` | Any removal of invariants, removal of guards, weakening of conditions, kernel mode change |

The severity determines how the system presents the diff to the user.

---

## 7. Modified Bootstrap Flow

### Current Flow
```
/world bootstrap → parse .md → write world.json → engine loads → enforcing
```

### Proposed Flow
```
/world bootstrap → parse .md → generate candidate → diff against active → branch:

  If no changes:
    → "World is up to date. No changes detected."

  If changes detected:
    → Write world.pending.json
    → Print structured diff
    → Print severity classification
    → "Run /world approve to activate. Run /world reject to discard."
    → Engine continues enforcing OLD world.json

/world approve:
    → Move world.json → world.history/<version>.json
    → Move world.pending.json → world.json
    → Compute and store SHA-256 hash
    → Engine loads new world
    → Print "World activated. <N> changes applied."

/world reject:
    → Delete world.pending.json
    → Print "Pending world discarded. Active world unchanged."
```

### First Bootstrap (No Existing World)

When no `world.json` exists yet, the flow is:

```
/world bootstrap → parse .md → generate candidate → no existing world to diff

  → Write world.pending.json
  → Print full world summary (same as /world laws, but marked as PENDING)
  → "This is your first world. Run /world approve to activate."
```

Even the first world requires approval. No exceptions.

---

## 8. Proactive Drift Detection

### 8.1 The Heartbeat

The plugin runs on **every tool call** via the `before_tool_call` hook. This is the governance heartbeat. Before returning any verdict, the engine performs runtime integrity checks:

```
evaluate(event)
  │
  ├── 1. Verify active world hash
  │     Compare world.json content against stored SHA-256 in world.meta.json
  │     Mismatch → BLOCK + TAMPERED alert
  │
  ├── 2. Verify .md source drift
  │     Compare current mdHashes against stored mdHashes in world metadata
  │     Drift detected → attach SOURCE_DRIFT alert
  │
  ├── 3. Check for pending world
  │     Does world.pending.json exist?
  │     Yes → attach PENDING_UNAPPROVED alert
  │
  ├── 4. Validate world state
  │     Is world.json schema-valid?
  │     Is version supported?
  │     Missing when expected? → BLOCK + WORLD_MISSING alert
  │
  └── 5. Run governance pipeline (invariants → guards → rules → roles → default)
        Return verdict + any accumulated alerts
```

### 8.2 Alert Levels

| Alert | Severity | Engine Behavior | User Message |
|-------|----------|----------------|--------------|
| `TAMPERED` | critical | BLOCK all actions | "World file integrity check failed. Run `/world restore`." |
| `WORLD_MISSING` | critical | BLOCK all actions | "World file was deleted outside the approval pipeline. Run `/world restore`." |
| `WORLD_CORRUPTED` | critical | BLOCK all actions | "World file failed schema validation. Run `/world restore` or `/world bootstrap`." |
| `SOURCE_DRIFT` | warning | Normal enforcement continues | "Governance source files have changed. Run `/world bootstrap` to review." |
| `PENDING_UNAPPROVED` | info | Normal enforcement continues | "Pending governance changes await approval. Run `/world diff` to review." |

### 8.3 Alert Deduplication

Alerts are not repeated on every tool call. The engine tracks which alerts have been surfaced:

- **Critical alerts** (TAMPERED, WORLD_MISSING, WORLD_CORRUPTED): Shown on every tool call. These block execution, so the user must act.
- **Warning alerts** (SOURCE_DRIFT): Shown once per session, or again if the drift set changes.
- **Info alerts** (PENDING_UNAPPROVED): Shown once per session.

### 8.4 Performance

Integrity checks must not degrade the sub-millisecond evaluation target:

- **Hash verification**: Use mtime-based cache. Only re-read and re-hash `world.json` if mtime has changed since last check.
- **MD drift check**: Check mtime of workspace directory. Only re-scan if directory mtime changed.
- **Pending check**: Single `existsSync` call. Negligible cost.

---

## 9. GovernanceAlert — The Alert Type

### 9.1 Type Definition

```typescript
interface GovernanceAlert {
  level: 'critical' | 'warning' | 'info';
  code: 'TAMPERED' | 'WORLD_MISSING' | 'WORLD_CORRUPTED' | 'SOURCE_DRIFT' | 'PENDING_UNAPPROVED';
  message: string;
  action: string;        // what the user should do
  details?: string;      // additional context (e.g. which files drifted)
}
```

### 9.2 Verdict with Alerts

The `GovernanceVerdict` type gains an `alerts` field:

```typescript
interface GovernanceVerdict {
  status: 'ALLOW' | 'PAUSE' | 'BLOCK';
  reason: string;
  ruleId: string | null;
  guard: string | null;
  evidence: string | null;
  alerts?: GovernanceAlert[];
}
```

Alerts are **separate from enforcement**. A verdict can be `ALLOW` with a `SOURCE_DRIFT` warning attached. The host decides how to render alerts (stderr, UI banner, etc). The engine decides what to report.

This is the correct structural separation: governance engine enforces. Alerts notify. They share a transport (the verdict) but serve different purposes.

---

## 10. Commands

### 10.1 `/world diff`

Shows the pending diff, if any.

**When pending exists:**
```
Pending World Changes (severity: CRITICAL)

  INVARIANTS:
    + [no_shell_exec] Agent cannot execute shell commands
    ~ [no_secrets_in_logs] condition changed:
        before: intent contains "password"
        after:  intent contains "pass"
    - [max_leverage] REMOVED

  GUARDS:
    (no changes)

  RULES:
    ~ [no_force_push] enforcement changed: BLOCK → PAUSE

  ROLES:
    + [admin] Admin — can do: *, requires approval: no

  Kernel:
    enforcement: standard → permissive

Run /world approve to activate. Run /world reject to discard.
```

**When no pending exists:**
```
No pending changes. Active world is current.
```

### 10.2 `/world approve`

Activates the pending world. Requires no arguments.

If severity is `critical`, the command prints a warning and requires the user to run `/world approve --confirm`:

```
This changeset is CRITICAL. It removes invariants or weakens enforcement.

  - [max_leverage] REMOVED
  - kernel enforcement: standard → permissive

Run /world approve --confirm to proceed.
```

### 10.3 `/world reject`

Discards the pending world. No confirmation needed.

### 10.4 `/world history`

Lists previous world activations.

```
World History:

  [3] 2026-02-28T14:30:00Z — 2 invariants, 3 guards, 5 rules
      Changed: +1 guard, ~1 rule
  [2] 2026-02-27T09:15:00Z — 2 invariants, 2 guards, 5 rules
      Changed: +1 invariant
  [1] 2026-02-26T11:00:00Z — 1 invariant, 2 guards, 5 rules
      Initial bootstrap

Run /world history <N> to see full details of a version.
```

### 10.5 `/world rollback <N>`

Restores a previous world version. Creates a new pending state that must be approved.

```
/world rollback 2

Restoring world version [2] as pending...

  Pending World Changes (severity: HIGH):
    - [new_guard] REMOVED (was added in version 3)
    ~ [some_rule] enforcement reverted: PAUSE → BLOCK

Run /world approve to activate. Run /world reject to cancel rollback.
```

### 10.6 `/world restore`

Recovers from tampering. Reloads the last approved world from `world.meta.json`'s embedded copy.

```
/world restore

  Restored world to last approved version (v3).
  Hash verified. Enforcement resumed.
```

---

## 11. World Integrity Hash

### 11.1 Hash Computation

When a world is approved and activated, the engine computes a SHA-256 hash of the canonical JSON representation (keys sorted, no whitespace) and stores it alongside the world:

```typescript
interface ActiveWorldRecord {
  world: GovernanceWorld;
  hash: string;           // SHA-256 of canonical JSON
  activatedAt: number;    // timestamp
  activatedBy: string;    // "human" (always — no automated activation)
  version: number;        // incrementing counter
}
```

Stored in `world.meta.json` alongside `world.json`.

### 11.2 Runtime Verification

On every call to `engine.evaluate()`:

1. Check mtime of `world.json`. If unchanged since last check, use cached hash.
2. If mtime changed, re-read and re-compute hash.
3. Compare against stored hash in `world.meta.json`.
4. If mismatch:
   - **Do not enforce the tampered world.**
   - Return a BLOCK verdict with TAMPERED alert.
   - Log the tampering event to audit log.

### 11.3 Recovery from Tampering

```
/world status

  World: TAMPERED
  Expected hash: a1b2c3...
  Current hash:  d4e5f6...

  The world file was modified outside the approval pipeline.
  Run /world restore to reload the last approved version.
  Run /world bootstrap to recompile from .md sources (will require approval).
```

---

## 12. Compiler Schema Constraints

The bootstrap compiler maps `.md` content to typed structures. These constraints are enforced at compile time.

### 12.1 What World Files Can Define

- `invariants` — conditions that always BLOCK
- `guards` — conditions that PAUSE or BLOCK, optionally scoped to tools
- `rules` — contextual triggers with verdict effects
- `roles` — identity-based permission sets
- `kernel` — enforcement mode and override policy
- `metadata` — name, description, source files

### 12.2 What World Files Cannot Define

World files **cannot**:

- Execute code or tools
- Reference external URLs or files
- Modify the engine itself
- Disable the diff/approval pipeline
- Grant meta-permissions (permission to change permissions without approval)
- Modify audit logs
- Change the hash verification system

### 12.3 Condition Value Constraints

Condition values are restricted to:

- Strings (max 500 characters)
- String arrays (max 50 entries, each max 500 characters)
- Numbers (finite, non-NaN)
- Booleans

No nested objects. No functions. No code evaluation.

### 12.4 Input Sanitization

World-derived strings must be treated as **untrusted input** in the rendering layer:

- Escape all world-derived strings before display in UI or logs.
- Do not interpret world content as commands, HTML, or markup.
- The governance engine enforces. The UI sanitizes. Separation of concerns.

This applies to fields like `invariant.description`, `guard.description`, `role.name`, and `metadata.description`. Even with schema constraints, malicious content can pollute logs or UI without sanitization.

---

## 13. Audit Trail

All world lifecycle events are logged to the audit system:

```typescript
interface WorldAuditEntry {
  ts: number;
  type: 'world_event';
  event:
    | 'bootstrap_proposed'    // /world bootstrap generated a pending world
    | 'approved'              // /world approve activated a pending world
    | 'rejected'              // /world reject discarded a pending world
    | 'rollback_proposed'     // /world rollback <N> created a pending rollback
    | 'tampering_detected'    // hash mismatch detected at runtime
    | 'restored'              // /world restore recovered from tampering
    | 'source_drift_detected' // .md files changed (logged once per drift set)
    ;
  severity: 'none' | 'low' | 'high' | 'critical';
  diff_summary: string;      // human-readable summary of changes
  version_before: number;
  version_after: number;
}
```

---

## 14. File Layout

After implementation, the governance directory looks like:

```
.neuroverse/
  world.json              # Active, enforced world
  world.meta.json         # Hash, version, activation record, embedded world copy
  world.pending.json      # Candidate awaiting approval (transient)
  world.history/
    1.json                # Version 1 (initial bootstrap)
    2.json                # Version 2
    3.json                # etc.
  audit.jsonl             # Existing audit log
```

---

## 15. Command Summary

| Command | Description | Requires Approval |
|---------|-------------|-------------------|
| `/world bootstrap` | Compile .md → pending world | No (generates pending) |
| `/world status` | Show engine status + integrity + pending indicator | No |
| `/world laws` | Display active constitution | No |
| `/world diff` | Show pending changes vs active | No |
| `/world approve` | Activate pending world | Yes (is the approval) |
| `/world reject` | Discard pending world | No |
| `/world history` | List previous world versions | No |
| `/world rollback <N>` | Restore version N as pending | No (generates pending) |
| `/world restore` | Recover from tampering | No (restores approved) |
| `/world propose` | Agent recommends amendments | No (generates pending) |
| `/world export` | Export for external tools | No |

---

## 16. Migration Path

For existing users who already have a `world.json`:

1. On first load after upgrade, the engine detects `world.json` exists but `world.meta.json` does not.
2. It treats the existing `world.json` as version 1.
3. It computes and stores the hash.
4. It creates `world.meta.json` with `version: 1, activatedBy: "migration"`.
5. Normal diff/approval flow applies from this point forward.

No existing worlds are invalidated. No action required from users.

---

## 17. Implementation Phases

### Phase 1: Pending World + Approval
- Bootstrap writes to `world.pending.json` instead of `world.json`.
- `/world approve` activates. `/world reject` discards.
- Engine continues enforcing old world during pending state.

### Phase 2: Semantic Diff + Severity
- Structured diff engine compares pending vs active.
- Severity classification (none/low/high/critical).
- Critical changes require `--confirm` flag.

### Phase 3: Hash Enforcement
- SHA-256 hash computed on approval, stored in `world.meta.json`.
- Runtime verification on every `evaluate()` with mtime cache.
- Tampering triggers BLOCK + alert.

### Phase 4: Runtime Drift Detection
- Proactive mdHash drift checks on every tool call.
- Pending world reminders.
- Alert deduplication (once per session for non-critical).
- Alerts attached to verdict via `GovernanceAlert[]`.

---

## 18. Design Decisions

**Why not prevent .md edits directly?**
We can't. Files on disk are writable by any process. The defense must be at the activation layer, not the storage layer.

**Why require approval even for the first bootstrap?**
Establishes the habit. Users should always read their laws before they take effect. Also prevents a malicious skill from racing to bootstrap before the user does.

**Why block everything on tampering instead of falling back to permissive?**
Failing open under attack is the wrong default for a governance system. If the world is tampered, the safe posture is to block and alert, not to silently allow everything.

**Why semantic diff instead of text diff?**
Text diffs are noisy and easy to hide changes in. A structured diff that says "invariant REMOVED" or "condition WEAKENED" is unambiguous. Security through clarity.

**Why store history as separate files instead of git?**
Not all environments have git. The plugin should be self-contained. Git-based history is a fine optional enhancement but not a dependency.

**Why Option A (alerts on verdict) instead of prepending to reason?**
The governance engine enforces. Alerts notify. These are separate concerns. Mixing enforcement messages with system health notifications creates ambiguity and makes both harder to parse. A clean `alerts` field is extensible, machine-readable, and keeps the verdict semantics pure.

**Why fail closed on missing/corrupted state?**
A governance system that becomes permissive when its own state is compromised is not a governance system. If `world.json` is deleted, the correct response is BLOCK, not "no rules loaded, allow everything." The safe default is always denial.

**Why check integrity on every tool call?**
Because the plugin already runs on every tool call. The marginal cost is near-zero (mtime check + existsSync). The benefit is continuous integrity assurance. You don't check your locks once a day — you check them every time you open the door.

**Why sanitize world-derived strings?**
Even with schema constraints, someone could embed content designed to confuse or manipulate rendering layers. The governance engine treats world content as data, not instructions. The UI layer must do the same.
