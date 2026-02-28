# World Diff & Approval Pipeline — Specification

**Status:** Draft
**Author:** NeuroVerse governance team
**Date:** 2026-02-28
**Scope:** Prevents silent governance changes by requiring human approval for all world mutations.

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

---

## 2. Threat Model

| Threat | Vector | Current Defense | Proposed Defense |
|--------|--------|----------------|-----------------|
| Malicious skill edits `.md` files | Skill contains instructions to modify governance source | None | Diff + approval gate |
| Skill triggers `/world bootstrap` after editing | Automated recompile activates poisoned rules | None | Pending state — old world stays active |
| Skill weakens invariant conditions | e.g. changes `contains "rm -rf"` to `contains "xyzzy"` | None | Structural diff highlights condition changes |
| Skill removes guards entirely | `.md` rewrite omits guard section | None | Diff shows removals as `REMOVED` entries |
| Runtime tampering of `world.json` | Direct file edit bypasses bootstrap | None | World hash verification on every evaluate() |
| Injection inside compiled world | Text like "ignore previous invariants" in a field value | Condition engine only evaluates structured fields | Compiler schema validation (already exists, formalize) |

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

## 4. New Concepts

### 4.1 World States

A world file can be in one of three states:

| State | File | Enforced | Description |
|-------|------|----------|-------------|
| **ACTIVE** | `world.json` | Yes | Currently enforced by the engine |
| **PENDING** | `world.pending.json` | No | Proposed changes awaiting approval |
| **ARCHIVED** | `world.history/<ts>.json` | No | Previous active worlds, kept for audit |

### 4.2 World Diff

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

### 4.3 Severity Classification

The diff engine assigns a severity to the overall changeset:

| Severity | Trigger |
|----------|---------|
| `none` | No structural changes |
| `low` | Only additions (new guards, new rules, stricter invariants) |
| `high` | Modifications to existing rules, condition changes, enforcement level changes |
| `critical` | Any removal of invariants, removal of guards, weakening of conditions, kernel mode change |

The severity determines how the system presents the diff to the user.

---

## 5. Modified Bootstrap Flow

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
    → Move world.json → world.history/<ts>.json
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

## 6. New Commands

### 6.1 `/world diff`

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

### 6.2 `/world approve`

Activates the pending world. Requires no arguments.

If severity is `critical`, the command prints a warning and requires the user to run `/world approve --confirm`:

```
This changeset is CRITICAL. It removes invariants or weakens enforcement.

  - [max_leverage] REMOVED
  - kernel enforcement: standard → permissive

Run /world approve --confirm to proceed.
```

### 6.3 `/world reject`

Discards the pending world. No confirmation needed.

### 6.4 `/world history`

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

### 6.5 `/world rollback <N>`

Restores a previous world version. Creates a new pending state that must be approved.

```
/world rollback 2

Restoring world version [2] as pending...

  Pending World Changes (severity: HIGH):
    - [new_guard] REMOVED (was added in version 3)
    ~ [some_rule] enforcement reverted: PAUSE → BLOCK

Run /world approve to activate. Run /world reject to cancel rollback.
```

---

## 7. World Integrity Hash

### 7.1 Hash Computation

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

### 7.2 Runtime Verification

On every call to `engine.evaluate()`:

1. Read `world.json` from disk (or use cached + mtime check).
2. Compute hash of current file content.
3. Compare against stored hash in `world.meta.json`.
4. If mismatch:
   - **Do not enforce the tampered world.**
   - Return a special verdict:

```typescript
const TAMPERED: GovernanceVerdict = {
  status: 'BLOCK',
  reason: 'World file integrity check failed. File was modified outside approval pipeline. All actions blocked until resolved.',
  ruleId: 'system:integrity',
  guard: null,
  evidence: 'hash mismatch',
};
```

5. Log the tampering event to audit log.

### 7.3 Recovery from Tampering

```
/world status

  World: TAMPERED
  Expected hash: a1b2c3...
  Current hash:  d4e5f6...

  The world file was modified outside the approval pipeline.
  Run /world restore to reload the last approved version.
  Run /world bootstrap to recompile from .md sources (will require approval).
```

`/world restore` copies the last approved world from `world.meta.json`'s embedded copy back to `world.json` and restores integrity.

---

## 8. Compiler Schema Constraints

The bootstrap compiler already maps `.md` content to typed structures. Formalize these constraints:

### 8.1 What World Files Can Define

- `invariants` — conditions that always BLOCK
- `guards` — conditions that PAUSE or BLOCK, optionally scoped to tools
- `rules` — contextual triggers with verdict effects
- `roles` — identity-based permission sets
- `kernel` — enforcement mode and override policy
- `metadata` — name, description, source files

### 8.2 What World Files Cannot Define

World files **cannot**:

- Execute code or tools
- Reference external URLs or files
- Modify the engine itself
- Disable the diff/approval pipeline
- Grant meta-permissions (permission to change permissions without approval)
- Modify audit logs
- Change the hash verification system

These are enforced at compile time. The compiler rejects any `.md` content that would produce fields outside the `GovernanceWorld` schema.

### 8.3 Condition Value Constraints

Condition values are restricted to:

- Strings (max 500 characters)
- String arrays (max 50 entries, each max 500 characters)
- Numbers (finite, non-NaN)
- Booleans

No nested objects. No functions. No code evaluation.

---

## 9. Audit Trail

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
    ;
  severity: 'none' | 'low' | 'high' | 'critical';
  diff_summary: string;      // human-readable summary of changes
  version_before: number;
  version_after: number;
}
```

---

## 10. File Layout

After implementation, the governance directory looks like:

```
.neuroverse/
  world.json              # Active, enforced world
  world.meta.json         # Hash, version, activation record
  world.pending.json      # Candidate awaiting approval (transient)
  world.history/
    1.json                # Version 1 (initial bootstrap)
    2.json                # Version 2
    3.json                # etc.
  audit.log               # Existing audit log
```

---

## 11. Command Summary

| Command | Description | Requires Approval |
|---------|-------------|-------------------|
| `/world bootstrap` | Compile .md → pending world | No (generates pending) |
| `/world status` | Show engine status + pending indicator | No |
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

## 12. Migration Path

For existing users who already have a `world.json`:

1. On first load after upgrade, the engine detects `world.json` exists but `world.meta.json` does not.
2. It treats the existing `world.json` as version 1.
3. It computes and stores the hash.
4. It creates `world.meta.json` with `version: 1, activatedBy: "migration"`.
5. Normal diff/approval flow applies from this point forward.

No existing worlds are invalidated. No action required from users.

---

## 13. Design Decisions

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
