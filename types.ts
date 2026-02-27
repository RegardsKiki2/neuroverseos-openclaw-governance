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
// Verdict
// ────────────────────────────────────────────────────────────────────────

export interface GovernanceVerdict {
  status: 'ALLOW' | 'PAUSE' | 'BLOCK';
  reason: string;
  ruleId: string | null;
  guard: string | null;
  evidence: string | null;
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
