/**
 * Governance Runtime Types
 *
 * Matches the Plugin Governance Runtime Spec exactly.
 * These types define the universal vocabulary shared across all three players.
 */

// ────────────────────────────────────────────────────────────────────────
// Runtime Event
// ────────────────────────────────────────────────────────────────────────

export interface ToolCallEvent {
  type: 'tool_call';
  tool: string;
  intent: string;
  args: Record<string, unknown>;
  scope?: string;
  role?: string;
  environment?: string;
  sessionOverrides: string[];
}

// ────────────────────────────────────────────────────────────────────────
// Condition Engine
// ────────────────────────────────────────────────────────────────────────

export type ConditionOperator =
  | '=='
  | '!='
  | '>'
  | '<'
  | '>='
  | '<='
  | 'in'
  | 'contains'
  | 'contains_any'
  | 'matches_pattern'
  | 'starts_with'
  | 'ends_with';

export interface Condition {
  field: string;
  operator: ConditionOperator;
  value: string | string[] | number | boolean;
}

export interface ConditionResult {
  matched: boolean;
  evidence: string | null;
}

// ────────────────────────────────────────────────────────────────────────
// World File (world.json)
// ────────────────────────────────────────────────────────────────────────

export interface GovernanceWorld {
  version: '1.0.0';
  kernel: Kernel;
  invariants: Invariant[];
  guards: Guard[];
  rules: Rule[];
  roles: Role[];
  metadata: WorldMetadata;
}

export interface Kernel {
  enforcementMode: 'strict' | 'standard' | 'permissive';
  defaultVerdict: 'allow';
  evaluationOrder: ('invariants' | 'guards' | 'rules')[];
  sessionOverridesAllowed: boolean;
}

export interface Invariant {
  id: string;
  description: string;
  scope: string[];
  condition: Condition;
  enforcement: 'block';
}

export interface Guard {
  id: string;
  description?: string;
  scope: string[];
  appliesTo: string[];
  condition: Condition;
  enforcement: 'pause' | 'block';
  requiresApproval?: boolean;
}

export interface Rule {
  id: string;
  description?: string;
  trigger: Condition;
  effect: {
    verdict: 'pause' | 'block' | 'allow';
  };
}

export interface Role {
  id: string;
  name: string;
  canDo: string[];
  cannotDo: string[];
  requiresApproval: boolean;
}

export interface WorldMetadata {
  name: string;
  bootstrappedFrom: string[];
  bootstrappedAt: number;
  description?: string;
  /** Content hashes of .md files at bootstrap time. Used for drift detection. */
  mdHashes?: Record<string, string>;
}

// ────────────────────────────────────────────────────────────────────────
// Governance Alerts — Proactive drift detection (spec §8–9)
// ────────────────────────────────────────────────────────────────────────

export type AlertCode =
  | 'TAMPERED'
  | 'WORLD_MISSING'
  | 'WORLD_CORRUPTED'
  | 'SOURCE_DRIFT'
  | 'PENDING_UNAPPROVED'
  | 'UNBOUND_AGENT';

export interface GovernanceAlert {
  level: 'critical' | 'warning' | 'info';
  code: AlertCode;
  message: string;
  action: string;
  details?: string;
}

// ────────────────────────────────────────────────────────────────────────
// Verdict
// ────────────────────────────────────────────────────────────────────────

export interface GovernanceVerdict {
  status: 'ALLOW' | 'PAUSE' | 'BLOCK';
  reason: string;
  ruleId: string | null;
  guard: string | null;
  evidence: string | null;
  /** Runtime integrity and drift alerts. Separate from enforcement. */
  alerts?: GovernanceAlert[];
}

// ────────────────────────────────────────────────────────────────────────
// Audit Log
// ────────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  ts: number;
  id: string;
  tool: string;
  intent: string;
  status: 'ALLOW' | 'PAUSE' | 'BLOCK';
  ruleId: string | null;
  evidence?: string | null;
}

export interface AuditDecisionEntry {
  ts: number;
  id: string;
  type: 'decision';
  decision: 'allow-once' | 'allow-always' | 'deny';
  decidedAt: number;
}

// ────────────────────────────────────────────────────────────────────────
// Role Bindings — Agent Identity → Governance Role (environment-specific)
// ────────────────────────────────────────────────────────────────────────

/**
 * Maps an agent identity (from OpenClaw ctx.agentId) to a governance role.
 * Lives in world.meta.json, NOT world.json, because:
 *   - World files are portable and environment-agnostic
 *   - Agent IDs are environment-specific (tied to an OpenClaw instance)
 * Changing bindings is a governed action with severity classification.
 */
export interface RoleBinding {
  agentId: string;
  roleId: string;
  boundAt: number;
  boundBy: 'human' | 'bootstrap' | 'migration';
}

/**
 * Severity of a role binding change. Used for lifecycle governance.
 *   - new_binding:   agent had no role → gets one (low)
 *   - reassignment:  agent changes role at same privilege level (high)
 *   - escalation:    agent moves to higher-privilege role (critical)
 *   - de_escalation: agent moves to lower-privilege role (low)
 *   - removal:       agent loses role binding (high)
 */
export type BindingChangeSeverity =
  | 'new_binding'
  | 'reassignment'
  | 'escalation'
  | 'de_escalation'
  | 'removal';

// ────────────────────────────────────────────────────────────────────────
// World Integrity (spec §11)
// ────────────────────────────────────────────────────────────────────────

export interface ActiveWorldRecord {
  world: GovernanceWorld;
  hash: string;
  activatedAt: number;
  activatedBy: 'human' | 'migration';
  version: number;
  /** Agent-to-role bindings. Environment-specific, not part of the portable world. */
  roleBindings?: RoleBinding[];
}

// ────────────────────────────────────────────────────────────────────────
// World Diff (spec §6)
// ────────────────────────────────────────────────────────────────────────

export interface WorldDiffSection<T> {
  added: T[];
  removed: T[];
  modified: { before: T; after: T; changes: string[] }[];
  unchanged: number;
}

export interface WorldDiff {
  invariants: WorldDiffSection<Invariant>;
  guards: WorldDiffSection<Guard>;
  rules: WorldDiffSection<Rule>;
  roles: WorldDiffSection<Role>;
  kernel: {
    changed: boolean;
    before: Kernel | null;
    after: Kernel;
  };
  severity: 'none' | 'low' | 'high' | 'critical';
}

// ────────────────────────────────────────────────────────────────────────
// World Audit (spec §13)
// ────────────────────────────────────────────────────────────────────────

export interface WorldAuditEntry {
  ts: number;
  type: 'world_event';
  event:
    | 'bootstrap_proposed'
    | 'approved'
    | 'rejected'
    | 'rollback_proposed'
    | 'tampering_detected'
    | 'restored'
    | 'source_drift_detected';
  severity: 'none' | 'low' | 'high' | 'critical';
  diff_summary: string;
  version_before: number;
  version_after: number;
}

// ────────────────────────────────────────────────────────────────────────
// Engine Config
// ────────────────────────────────────────────────────────────────────────

export interface EngineConfig {
  worldPath: string;
  enforcement: 'standard' | 'strict' | 'permissive';
  observeOnly: boolean;
}

export interface EngineStatus {
  worldLoaded: boolean;
  invariantCount: number;
  guardCount: number;
  ruleCount: number;
  roleCount: number;
  enforcement: string;
  observeOnly: boolean;
}
