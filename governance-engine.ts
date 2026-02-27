/**
 * Governance Engine — Deterministic decision pipeline
 *
 * Evaluates tool calls against world rules in strict order:
 *   1. Session allowlist → ALLOW silently if guard already approved
 *   2. Invariants → any hit = BLOCK (immediate, no override)
 *   3. Guards → condition engine + tool filter → PAUSE or BLOCK
 *   4. Rules → trigger evaluation → verdict override
 *   5. Role constraints → cannotDo = BLOCK, requiresApproval = PAUSE
 *   6. Default → ALLOW
 *
 * Same world + same event = same verdict. Always.
 * No AI. No network calls. Sub-millisecond per evaluation.
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { evaluateCondition } from './condition-engine';
import type {
  GovernanceWorld,
  GovernanceVerdict,
  ToolCallEvent,
  EngineConfig,
  EngineStatus,
} from './types';

// ────────────────────────────────────────────────────────────────────────
// Default verdict (spec §4)
// ────────────────────────────────────────────────────────────────────────

const DEFAULT_ALLOW: GovernanceVerdict = {
  status: 'ALLOW',
  reason: 'No rules matched — default allow',
  ruleId: null,
  guard: null,
  evidence: null,
};

const NO_WORLD: GovernanceVerdict = {
  status: 'ALLOW',
  reason: 'No world file loaded',
  ruleId: null,
  guard: null,
  evidence: null,
};

// ────────────────────────────────────────────────────────────────────────
// Engine
// ────────────────────────────────────────────────────────────────────────

export class GovernanceEngine {
  private config: EngineConfig;
  private world: GovernanceWorld | null = null;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  // ── World Loading ──────────────────────────────────────────────

  loadWorld(): void {
    if (!existsSync(this.config.worldPath)) {
      this.world = null;
      return;
    }
    try {
      const raw = readFileSync(this.config.worldPath, 'utf-8');
      this.world = JSON.parse(raw);
    } catch {
      this.world = null;
    }
  }

  getWorld(): GovernanceWorld | null {
    return this.world;
  }

  setWorld(world: GovernanceWorld): void {
    this.world = world;
  }

  saveWorld(): void {
    if (this.world) {
      writeFileSync(this.config.worldPath, JSON.stringify(this.world, null, 2));
    }
  }

  getStatus(): EngineStatus {
    return {
      worldLoaded: this.world !== null,
      invariantCount: this.world?.invariants?.length ?? 0,
      guardCount: this.world?.guards?.length ?? 0,
      ruleCount: this.world?.rules?.length ?? 0,
      roleCount: this.world?.roles?.length ?? 0,
      enforcement: this.config.enforcement,
      observeOnly: this.config.observeOnly,
    };
  }

  // ── Decision Pipeline (spec §3) ───────────────────────────────

  /**
   * Evaluate a tool call event against the loaded world.
   * Returns a deterministic verdict: ALLOW, PAUSE, or BLOCK.
   */
  evaluate(event: ToolCallEvent): GovernanceVerdict {
    if (!this.world) return NO_WORLD;

    // Observe-only: run pipeline but always return ALLOW
    if (this.config.observeOnly) {
      const wouldBe = this.runPipeline(event);
      if (wouldBe.status !== 'ALLOW') {
        return {
          status: 'ALLOW',
          reason: `[OBSERVE] Would have been ${wouldBe.status}: ${wouldBe.reason}`,
          ruleId: wouldBe.ruleId,
          guard: wouldBe.guard,
          evidence: wouldBe.evidence,
        };
      }
      return DEFAULT_ALLOW;
    }

    return this.runPipeline(event);
  }

  /**
   * The actual ordered pipeline. This is the core of governance.
   */
  private runPipeline(event: ToolCallEvent): GovernanceVerdict {
    const world = this.world!;

    // 1. Session allowlist — checked in index.ts before calling evaluate
    //    (sessionOverrides on the event). We check here too for defense in depth.
    if (event.sessionOverrides.length > 0) {
      // Will be used by guards step — don't short-circuit entirely
      // because invariants can never be overridden
    }

    // 2. Invariants — always evaluated, never overridable
    const invariantVerdict = this.checkInvariants(event, world.invariants);
    if (invariantVerdict) return invariantVerdict;

    // 3. Guards — scoped, condition-based
    const guardVerdict = this.checkGuards(event, world.guards);
    if (guardVerdict) {
      // Check if this guard was session-overridden
      if (
        world.kernel.sessionOverridesAllowed &&
        guardVerdict.ruleId &&
        event.sessionOverrides.includes(guardVerdict.ruleId)
      ) {
        return {
          ...DEFAULT_ALLOW,
          reason: `Session override for ${guardVerdict.ruleId}`,
        };
      }
      return guardVerdict;
    }

    // 4. Rules — contextual triggers with effects
    const ruleVerdict = this.checkRules(event, world.rules);
    if (ruleVerdict) return ruleVerdict;

    // 5. Role constraints
    const roleVerdict = this.checkRoles(event, world.roles);
    if (roleVerdict) return roleVerdict;

    // 6. Default → ALLOW
    return DEFAULT_ALLOW;
  }

  // ── Pipeline Steps ─────────────────────────────────────────────

  /**
   * Step 2: Invariants. Non-toggleable. Non-overridable. Hard BLOCK.
   */
  private checkInvariants(
    event: ToolCallEvent,
    invariants: GovernanceWorld['invariants'],
  ): GovernanceVerdict | null {
    if (!invariants?.length) return null;

    for (const inv of invariants) {
      // Scope check
      if (inv.scope.length > 0 && !inv.scope.includes(event.type)) continue;

      const result = evaluateCondition(inv.condition, event);
      if (result.matched) {
        return {
          status: 'BLOCK',
          reason: inv.description,
          ruleId: `invariant:${inv.id}`,
          guard: null,
          evidence: result.evidence,
        };
      }
    }

    return null;
  }

  /**
   * Step 3: Guards. Scoped + tool-filtered. Can PAUSE or BLOCK.
   */
  private checkGuards(
    event: ToolCallEvent,
    guards: GovernanceWorld['guards'],
  ): GovernanceVerdict | null {
    if (!guards?.length) return null;

    for (const guard of guards) {
      // Scope check
      if (guard.scope.length > 0 && !guard.scope.includes(event.type)) continue;

      // Tool filter — if appliesTo is set, only match those tools
      if (guard.appliesTo.length > 0) {
        const toolLower = event.tool.toLowerCase();
        if (!guard.appliesTo.some(t => t.toLowerCase() === toolLower)) continue;
      }

      const result = evaluateCondition(guard.condition, event);
      if (result.matched) {
        return {
          status: guard.enforcement === 'block' ? 'BLOCK' : 'PAUSE',
          reason: guard.description ?? guard.id,
          ruleId: `guard:${guard.id}`,
          guard: guard.id,
          evidence: result.evidence,
        };
      }
    }

    return null;
  }

  /**
   * Step 4: Rules. Contextual triggers with verdict effects.
   */
  private checkRules(
    event: ToolCallEvent,
    rules: GovernanceWorld['rules'],
  ): GovernanceVerdict | null {
    if (!rules?.length) return null;

    for (const rule of rules) {
      const result = evaluateCondition(rule.trigger, event);
      if (result.matched) {
        const status = rule.effect.verdict.toUpperCase() as 'ALLOW' | 'PAUSE' | 'BLOCK';
        if (status !== 'ALLOW') {
          return {
            status,
            reason: rule.description ?? rule.id,
            ruleId: `rule:${rule.id}`,
            guard: null,
            evidence: result.evidence,
          };
        }
      }
    }

    return null;
  }

  /**
   * Step 5: Role constraints. cannotDo = BLOCK, requiresApproval = PAUSE.
   */
  private checkRoles(
    event: ToolCallEvent,
    roles: GovernanceWorld['roles'],
  ): GovernanceVerdict | null {
    if (!roles?.length || !event.role) return null;

    const role = roles.find(r => r.id === event.role || r.name.toLowerCase() === event.role?.toLowerCase());
    if (!role) return null;

    // Check cannotDo — hard BLOCK
    const toolLower = event.tool.toLowerCase();
    if (role.cannotDo.some(action => toolLower.includes(action.toLowerCase()))) {
      return {
        status: 'BLOCK',
        reason: `Role "${role.name}" cannot perform "${event.tool}"`,
        ruleId: `role:${role.id}`,
        guard: null,
        evidence: `tool "${event.tool}" in cannotDo list`,
      };
    }

    // Check requiresApproval — PAUSE
    if (role.requiresApproval) {
      return {
        status: 'PAUSE',
        reason: `Role "${role.name}" requires approval for all actions`,
        ruleId: `role:${role.id}`,
        guard: null,
        evidence: `role requires approval`,
      };
    }

    return null;
  }

  // ── Amendment Application ──────────────────────────────────────

  /**
   * Apply an approved amendment to the world.
   */
  applyAmendment(proposal: {
    type: 'add_guard' | 'modify_threshold' | 'add_role' | 'add_invariant';
    suggestion: string;
    reason: string;
  }): void {
    if (!this.world) return;

    switch (proposal.type) {
      case 'add_invariant':
        this.world.invariants.push({
          id: `inv-${Date.now().toString(36)}`,
          description: proposal.reason,
          scope: ['tool_call'],
          condition: {
            field: 'intent',
            operator: 'contains',
            value: proposal.suggestion.toLowerCase(),
          },
          enforcement: 'block',
        });
        break;

      case 'add_guard':
        this.world.guards.push({
          id: `guard-${Date.now().toString(36)}`,
          description: proposal.reason,
          scope: ['tool_call'],
          appliesTo: [],
          condition: {
            field: 'intent',
            operator: 'contains',
            value: proposal.suggestion.toLowerCase(),
          },
          enforcement: 'pause',
          requiresApproval: true,
        });
        break;

      case 'add_role':
        this.world.roles.push({
          id: `role-${Date.now().toString(36)}`,
          name: proposal.suggestion,
          canDo: [],
          cannotDo: [],
          requiresApproval: false,
        });
        break;

      case 'modify_threshold':
        // Convert guard enforcement from pause→block or block→pause
        const targetGuard = this.world.guards.find(
          g => g.id === proposal.suggestion || g.description === proposal.suggestion,
        );
        if (targetGuard) {
          targetGuard.enforcement = targetGuard.enforcement === 'pause' ? 'block' : 'pause';
        }
        break;
    }
  }
}
