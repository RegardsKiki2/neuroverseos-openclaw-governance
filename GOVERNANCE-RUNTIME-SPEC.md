# Plugin Governance Runtime Spec

Deterministic. Structural. No AI in enforcement.

---

## 1. Runtime Inputs

Normalized event shape for every tool call:

```typescript
{
  type: 'tool_call';
  tool: string;            // 'shell', 'edit', 'write', etc.
  intent: string;          // stated purpose or synthesized summary
  args: Record<string, unknown>;
  scope?: string;          // derived: file path, URL, resource
  role?: string;           // mapped from agentId via world roles
  environment?: string;    // 'development' | 'production' | etc.
  sessionOverrides: string[];  // guard IDs already approved this session
}
```

Scope derived from args: `args.command`, `args.file_path`, `args.url` depending on tool. Environment from workspace config or env vars.

---

## 2. World Artifact (Bootstrap Output)

Single `world.json` matching universal vocabulary:

```typescript
{
  version: '1.0.0';
  kernel: {
    enforcementMode: 'strict' | 'standard' | 'permissive';
    defaultVerdict: 'allow';
    evaluationOrder: ['invariants', 'guards', 'rules'];
    sessionOverridesAllowed: boolean;
  };
  invariants: Invariant[];
  guards: Guard[];
  rules: Rule[];
  roles: Role[];
  metadata: { ... };
}
```

### Invariants

Non-toggleable. Non-overridable. Always evaluated. Hard BLOCK.

```typescript
{
  id: 'no_credential_exposure';
  description: 'Never expose secrets or credentials';
  scope: ['tool_call'];
  condition: {
    field: 'intent';
    operator: 'contains_any';
    value: ['.env', 'AWS_SECRET', 'private_key'];
  };
  enforcement: 'block';
}
```

### Guards

Scoped. Can PAUSE or BLOCK. May allow session overrides.

```typescript
{
  id: 'destructive_shell_requires_approval';
  scope: ['tool_call'];
  appliesTo: ['shell'];
  condition: {
    field: 'intent';
    operator: 'matches_pattern';
    value: ['rm\\s+-rf', 'drop\\s+table', 'truncate'];
  };
  enforcement: 'pause';
  requiresApproval: true;
}
```

### Rules

Contextual triggers with effects.

```typescript
{
  id: 'prod_write_requires_review';
  trigger: {
    field: 'environment';
    operator: '==';
    value: 'production';
  };
  effect: {
    verdict: 'pause';
  };
}
```

### Roles

```typescript
{
  id: 'executor';
  name: 'Executor';
  canDo: ['read', 'write', 'shell'];
  cannotDo: ['deploy', 'delete_branch'];
  requiresApproval: false;
}
```

---

## 3. Decision Pipeline

Deterministic. Ordered. No model calls.

```
event arrives
    │
    ▼
1. Session allowlist
   → if tool+guard already approved → ALLOW
    │
2. Invariants (all, in order)
   → condition engine evaluates each
   → any hit → BLOCK (immediate, no override)
    │
3. Guards (all, in order)
   → condition engine evaluates each
   → check appliesTo filter (tool match)
   → hit → enforcement level (PAUSE or BLOCK)
    │
4. Rules (all, in order)
   → trigger evaluated against event fields
   → hit → apply effect (verdict override)
    │
5. Role constraints
   → check cannotDo (BLOCK)
   → check requiresApproval (PAUSE)
    │
6. Default → ALLOW
```

Same world + same event = same verdict. Always.

---

## 4. Verdict Schema

```typescript
{
  status: 'ALLOW' | 'PAUSE' | 'BLOCK';
  reason: string;              // rule description or default
  ruleId: string | null;       // 'invariant:no-credential-exposure', 'guard:destructive-shell'
  guard: string | null;        // guard label if guard-triggered
  evidence: string | null;     // what in the input matched
}
```

Rule IDs: `{category}:{kebab-id}` — matches SoftShell convention.

---

## 5. Condition Engine

Structured operators. Not substring matching.

| Operator | Behavior |
|----------|----------|
| `==` | Exact match |
| `!=` | Not equal |
| `>` `<` `>=` `<=` | Numeric/string comparison |
| `in` | Value is in array |
| `contains` | Field contains substring |
| `contains_any` | Field contains any of the values |
| `matches_pattern` | Field matches any regex in values |
| `starts_with` | Field starts with value |
| `ends_with` | Field ends with value |

These mirror the Experience Space rule compiler operators. Same vocabulary across all three players.

---

## 6. Approval Mechanism

When verdict is PAUSE:

```
1. Check session allowlist → ALLOW silently if already approved
2. Check autoAllow config → ALLOW with log (CI/headless)
3. Interactive prompt:

   [governance] PAUSE  rm -rf /data
                guard: destructive_shell_requires_approval
                Allow? [y]es once / [a]lways / [n]o: _

4. y → ALLOW, log
   a → ALLOW, add guard ID to session allowlist, log
   n → BLOCK, log
```

Session allowlist keyed by guard ID (not tool name). Resets on restart.

---

## 7. Audit Log

`.neuroverse/audit.jsonl` — append-only, one JSON per line.

```jsonl
{"ts":1709000000,"id":"ev-001","tool":"shell","intent":"ls","status":"ALLOW","ruleId":null}
{"ts":1709000001,"id":"ev-002","tool":"shell","intent":"rm -rf /data","status":"BLOCK","ruleId":"invariant:no-destructive-ops","evidence":"rm -rf"}
{"ts":1709000002,"id":"ev-003","tool":"edit","intent":"Edit .env","status":"PAUSE","ruleId":"guard:credential-access"}
{"ts":1709000002,"id":"ev-003","type":"decision","decision":"allow-once","decidedAt":1709000005}
```

Every verdict logged. Every PAUSE paired with a decision. Every entry references a ruleId. `/world status` reads this for drift metrics.

---

## What Changes

| Component | Current | Target |
|-----------|---------|--------|
| Bootstrap output | Flat `GovernanceWorld` with pattern arrays | Structured world.json with kernel/invariants/guards/rules/roles |
| Condition evaluation | `string.includes(pattern)` | Operator engine (`contains_any`, `matches_pattern`, `==`, etc.) |
| Evaluation order | tool restrictions → guards → default | invariants → guards → rules → roles → default |
| Guard structure | `{ label, patterns[], enforcement }` | `{ id, scope, appliesTo, condition{}, enforcement }` |
| Invariant structure | `{ label, description }` | `{ id, description, scope, condition{}, enforcement: 'block' }` |
| Verdict shape | `{ status, reason, ruleId, guard }` | `{ status, reason, ruleId, guard, evidence }` |
| Audit | None | `.neuroverse/audit.jsonl` |

## What Does NOT Change

- No AI in runtime enforcement
- No network calls during evaluation
- No UI layer
- No philosophical shift
- Deterministic: same world + same event = same verdict
