/**
 * NeuroVerse Governance Plugin for OpenClaw
 *
 * A governance layer that intercepts tool calls and enforces
 * ALLOW / PAUSE / BLOCK verdicts against structured world rules.
 *
 * Performance: Deterministic, local, no model calls. Sub-millisecond
 * per evaluation. Condition engine against world.json rules.
 *
 * Logging: Quiet by default. Only BLOCK and PAUSE print to terminal.
 * Set "verbose": true to see all verdicts including ALLOW.
 *
 * Audit: Every verdict logged to .neuroverse/audit.jsonl.
 *
 * Install:
 *   openclaw plugins install neuroverseos-governance
 *
 * Commands:
 *   /world bootstrap    — Generate world.json from your .md files
 *   /world status       — Show governance status, drift metrics, audit stats
 *   /world laws         — Display the full constitution (invariants, guards, rules, roles)
 *   /world propose      — Agent recommends governance amendments
 *   /world approve <id> — Human approves a proposed amendment
 *   /world export       — Export for use in other tools
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { createInterface } from 'readline';
import { join, resolve } from 'path';
import { bootstrapWorldFromMarkdown, checkMdDrift } from './world-bootstrap';
import { GovernanceEngine } from './governance-engine';
import { DriftMonitor } from './drift-monitor';
import { AuditLogger } from './audit-logger';
import type { ToolCallEvent, GovernanceVerdict, GovernanceAlert, BindingChangeSeverity } from './types';

// ────────────────────────────────────────────────────────────────────────
// Terminal Prompt — Interactive pause resolution (spec §6)
// ────────────────────────────────────────────────────────────────────────

/**
 * Context for governance verdict display.
 * Shows the full picture: who, what, why, evidence.
 */
interface VerdictContext {
  agentId?: string;
  role?: string;
  tool: string;
  scope?: string;
  intent: string;
  guardLabel: string;
  guardDescription?: string;
  evidence?: string | null;
}

/**
 * Prompt the developer in the terminal for a pause decision.
 * Blocks until they respond. Returns their choice.
 *
 * Display format — full agent context:
 *   [governance] PAUSE
 *     agent:    coder-agent-01 (role: executor)
 *     action:   file_write → /etc/passwd
 *     guard:    guard-sensitive-paths
 *               "Blocks writes to system directories"
 *     evidence: path matches /etc/*
 *     Allow? [y]es once / [a]lways / [n]o: _
 */
function promptForDecision(
  ctx: VerdictContext,
): Promise<'allow-once' | 'allow-always' | 'deny'> {
  return new Promise((resolvePrompt) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    process.stderr.write(`\n[governance] PAUSE\n`);
    if (ctx.agentId) {
      const roleSuffix = ctx.role ? ` (role: ${ctx.role})` : ' (unbound)';
      process.stderr.write(`             agent:    ${ctx.agentId}${roleSuffix}\n`);
    }
    const actionTarget = ctx.scope ? ` → ${ctx.scope}` : '';
    process.stderr.write(`             action:   ${ctx.tool}${actionTarget}\n`);
    process.stderr.write(`             guard:    ${ctx.guardLabel}\n`);
    if (ctx.guardDescription) {
      process.stderr.write(`                       "${ctx.guardDescription}"\n`);
    }
    if (ctx.evidence) {
      process.stderr.write(`             evidence: ${ctx.evidence}\n`);
    }
    process.stderr.write(`             Allow? [y]es once / [a]lways / [n]o: `);

    rl.on('line', (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === 'a' || a === 'always') {
        resolvePrompt('allow-always');
      } else if (a === 'n' || a === 'no') {
        resolvePrompt('deny');
      } else {
        resolvePrompt('allow-once');
      }
    });

    rl.on('close', () => {
      resolvePrompt('deny');
    });
  });
}

// ────────────────────────────────────────────────────────────────────────
// Session Allowlist — Keyed by guard ID, not tool name (spec §6)
// ────────────────────────────────────────────────────────────────────────

class SessionAllowlist {
  private guardIds: Set<string> = new Set();

  isAllowed(guardId: string): boolean {
    return this.guardIds.has(guardId);
  }

  add(guardId: string): void {
    this.guardIds.add(guardId);
  }

  getOverrides(): string[] {
    return Array.from(this.guardIds);
  }

  clear(): void {
    this.guardIds.clear();
  }
}

// ────────────────────────────────────────────────────────────────────────
// Event Construction — Normalize OpenClaw hook event to internal shape
// ────────────────────────────────────────────────────────────────────────

/**
 * Derive scope from tool call params.
 */
function deriveScope(tool: string, params: Record<string, unknown>): string | undefined {
  if (params.file_path && typeof params.file_path === 'string') return params.file_path;
  if (params.command && typeof params.command === 'string') return params.command;
  if (params.url && typeof params.url === 'string') return params.url;
  if (params.path && typeof params.path === 'string') return params.path;
  return undefined;
}

/**
 * Build a normalized ToolCallEvent from OpenClaw's before_tool_call event + context.
 *
 * OpenClaw provides:
 *   event: { toolName: string; params: Record<string, unknown> }
 *   ctx:   { agentId?: string; sessionKey?: string; toolName: string }
 */
function buildEvent(
  toolName: string,
  params: Record<string, unknown>,
  agentId: string | undefined,
  allowlist: SessionAllowlist,
  roleMap: Map<string, string>,
  environment?: string,
): ToolCallEvent {
  return {
    type: 'tool_call',
    tool: toolName,
    intent: `${toolName}: ${JSON.stringify(params).slice(0, 100)}`,
    args: params,
    scope: deriveScope(toolName, params),
    role: agentId ? roleMap.get(agentId) : undefined,
    environment,
    sessionOverrides: allowlist.getOverrides(),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Plugin Config
// ────────────────────────────────────────────────────────────────────────

interface PluginConfig {
  worldPath?: string;
  enforcement?: 'standard' | 'strict' | 'permissive';
  observeFirst?: boolean;
  driftTracking?: boolean;
  autoProposals?: boolean;
  verbose?: boolean;
  autoAllow?: boolean;
  environment?: string;
}

// ────────────────────────────────────────────────────────────────────────
// Shared: Read .md files from workspace
// ────────────────────────────────────────────────────────────────────────

function readMdFiles(dir: string): Record<string, string> {
  const mdFiles: Record<string, string> = {};
  try {
    const entries = readdirSync(dir);
    for (const file of entries) {
      if (file.toLowerCase().endsWith('.md')) {
        const fullPath = join(dir, file);
        mdFiles[file] = readFileSync(fullPath, 'utf-8');
      }
    }
  } catch {
    // Directory unreadable — return empty
  }
  return mdFiles;
}

// ────────────────────────────────────────────────────────────────────────
// Plugin Registration
// ────────────────────────────────────────────────────────────────────────

/**
 * Resolve the persistent storage root.
 * Priority: explicit env var → /data if present (Docker) → cwd fallback.
 *
 * In OpenClaw Docker containers /data is always the mounted persistent volume.
 * We detect its *presence* (existsSync), not its permissions (accessSync),
 * because the node process may not yet have write access at register time
 * on certain hosts (e.g. Hostinger), causing a false fallback to process.cwd().
 */
function getStorageRoot(): string {
  // 1. Explicit override — always wins
  if (process.env.OPENCLAW_DATA_DIR) {
    return process.env.OPENCLAW_DATA_DIR;
  }
  // 2. /data exists — standard OpenClaw container volume
  if (existsSync('/data')) {
    return '/data';
  }
  // 3. Local dev fallback
  return process.cwd();
}

export default function register(api: any) {
  // Config: OpenClaw provides plugin-specific config via api.pluginConfig
  const config: PluginConfig = (api.pluginConfig ?? {}) as PluginConfig;
  const verbose = config.verbose ?? false;
  const autoAllow = config.autoAllow ?? false;
  const allowlist = new SessionAllowlist();
  const roleMap = new Map<string, string>();
  const environment = config.environment ?? process.env.NODE_ENV;

  // Storage root: where .neuroverse/ persistent data lives
  const storageRoot = getStorageRoot();

  // Workspace content: where .md files live (for bootstrap & drift detection)
  // OpenClaw workspace is at <dataRoot>/.openclaw/workspace — NOT the container CWD.
  // api.resolvePath('.') returns the container root (e.g. /data), which has no .md files.
  const workspaceDir = resolve(storageRoot, '.openclaw', 'workspace');
  const worldDir = resolve(storageRoot, '.neuroverse');
  const worldPath = config.worldPath
    ? resolve(storageRoot, config.worldPath)
    : join(worldDir, 'world.json');
  const auditPath = join(worldDir, 'audit.jsonl');
  const statePath = join(worldDir, 'state.json');
  const proposalsDir = join(worldDir, 'proposals');

  // Ensure directories
  if (!existsSync(worldDir)) mkdirSync(worldDir, { recursive: true });
  if (!existsSync(proposalsDir)) mkdirSync(proposalsDir, { recursive: true });

  // ── Core Services ──────────────────────────────────────────────

  const engine = new GovernanceEngine({
    worldPath,
    enforcement: config.enforcement ?? 'standard',
    observeOnly: config.observeFirst ?? false,
  });

  // Set workspace dir for runtime md drift detection (spec §8)
  engine.setWorkspaceDir(workspaceDir);

  const audit = new AuditLogger(auditPath);

  let monitor: DriftMonitor | null = null;
  if (config.driftTracking !== false) {
    monitor = new DriftMonitor({ statePath, auditPath, engine });
  }

  // ── Tool Interception Hook (spec §3 pipeline) ─────────────────
  // OpenClaw before_tool_call hook signature (from src/plugins/types.ts):
  //   event: { toolName: string; params: Record<string, unknown> }
  //   ctx:   { agentId?: string; sessionKey?: string; toolName: string }
  //   return: { block?: boolean; blockReason?: string; params?: Record<string, unknown> } | void

  api.on('before_tool_call', async (
    event: { toolName: string; params: Record<string, unknown> },
    ctx: { agentId?: string; sessionKey?: string; toolName: string },
  ) => {
    // 1. Build normalized event (spec §1)
    const govEvent = buildEvent(
      event.toolName,
      event.params,
      ctx.agentId,
      allowlist,
      roleMap,
      environment,
    );

    // 2. Run decision pipeline (spec §3)
    const verdict: GovernanceVerdict = engine.evaluate(govEvent);

    // 3. Audit log every verdict (spec §7)
    const eventId = audit.logVerdict(event.toolName, govEvent.intent, verdict);

    // 4. Track in drift monitor
    monitor?.recordAction(event.toolName, verdict.status, verdict.ruleId ?? undefined);

    // 4.5 Surface proactive alerts (spec §8)
    if (verdict.alerts && verdict.alerts.length > 0) {
      for (const alert of verdict.alerts) {
        const prefix = alert.level === 'critical' ? '!!!'
          : alert.level === 'warning' ? '!'
          : 'i';
        api.logger.warn(`[governance] [${prefix}] ${alert.message}`);
        if (alert.details) {
          api.logger.warn(`             ${alert.details}`);
        }
        api.logger.warn(`             → ${alert.action}`);
      }
    }

    // ── BLOCK ──────────────────────────────────────────────
    if (verdict.status === 'BLOCK') {
      api.logger.warn(`[governance] BLOCK`);
      if (ctx.agentId) {
        const roleSuffix = govEvent.role ? ` (role: ${govEvent.role})` : ' (unbound)';
        api.logger.warn(`             agent:    ${ctx.agentId}${roleSuffix}`);
      }
      const actionTarget = govEvent.scope ? ` → ${govEvent.scope}` : '';
      api.logger.warn(`             action:   ${event.toolName}${actionTarget}`);
      api.logger.warn(`             rule:     ${verdict.ruleId ?? 'default'}`);
      api.logger.warn(`             reason:   ${verdict.reason}`);
      if (verdict.evidence) {
        api.logger.warn(`             evidence: ${verdict.evidence}`);
      }
      return { block: true, blockReason: verdict.reason };
    }

    // ── PAUSE ──────────────────────────────────────────────
    if (verdict.status === 'PAUSE') {
      const guardId = verdict.ruleId ?? '';

      // Check session allowlist first (spec §6 step 1)
      if (guardId && allowlist.isAllowed(guardId)) {
        if (verbose) {
          api.logger.debug?.(`[governance] ALLOW  ${govEvent.intent} (session allowlist: ${guardId})`);
        }
        audit.logDecision(eventId, 'allow-always');
        monitor?.recordAction(event.toolName, 'ALLOW', verdict.ruleId ?? undefined);
        return; // allow — return void
      }

      // Auto-allow mode for CI/headless (spec §6 step 2)
      if (autoAllow) {
        api.logger.info(`[governance] PAUSE  ${govEvent.intent} (auto-allowed)`);
        api.logger.info(`             ${verdict.guard ?? verdict.ruleId}`);
        audit.logDecision(eventId, 'allow-once');
        return; // allow — return void
      }

      // Interactive prompt with full context (spec §6 step 3)
      const guardLabel = verdict.guard ?? verdict.ruleId ?? 'governance rule';
      const decision = await promptForDecision({
        agentId: ctx.agentId,
        role: govEvent.role,
        tool: event.toolName,
        scope: govEvent.scope,
        intent: govEvent.intent,
        guardLabel,
        guardDescription: verdict.reason !== guardLabel ? verdict.reason : undefined,
        evidence: verdict.evidence,
      });

      // Log the decision (spec §7 — every PAUSE paired with a decision)
      audit.logDecision(eventId, decision);

      if (decision === 'allow-always') {
        if (guardId) allowlist.add(guardId);
        process.stderr.write(`[governance] Added ${guardId} to session allowlist\n\n`);
        monitor?.recordOverride();
        return; // allow — return void
      }

      if (decision === 'allow-once') {
        monitor?.recordOverride();
        return; // allow — return void
      }

      // deny
      process.stderr.write(`[governance] Denied\n\n`);
      return { block: true, blockReason: verdict.reason };
    }

    // ── ALLOW ──────────────────────────────────────────────
    if (verbose) {
      api.logger.debug?.(`[governance] ALLOW  ${govEvent.intent}`);
    }
    // allow — return void
  });

  // ── Session Reset Hook — Drift detection on /new ────────────────
  // OpenClaw before_reset hook (from src/plugins/types.ts):
  //   event: { sessionFile?: string; messages?: unknown[]; reason?: string }
  //   ctx:   { agentId?: string; sessionKey?: string }
  //   return: void
  //
  // On /new or /reset, check if .md files have changed since last bootstrap.
  // If drifted, prompt the user: "Regenerate constitution? [y/n]"
  // If yes, re-bootstrap from current .md files before the new session starts.

  api.on('before_reset', async () => {
    // Only check if we have a world with hash baseline
    const world = engine.getWorld();
    const storedHashes = world?.metadata?.mdHashes;
    if (!storedHashes) return;

    const drift = checkMdDrift(workspaceDir, storedHashes);
    const hasDrift = drift.changed.length > 0 || drift.added.length > 0 || drift.removed.length > 0;
    if (!hasDrift) {
      // Clear session allowlist on reset (fresh session = fresh allowlist)
      allowlist.clear();
      return;
    }

    // Report what changed
    const changedSummary: string[] = [];
    if (drift.changed.length > 0) changedSummary.push(`modified: ${drift.changed.join(', ')}`);
    if (drift.added.length > 0) changedSummary.push(`new: ${drift.added.join(', ')}`);
    if (drift.removed.length > 0) changedSummary.push(`removed: ${drift.removed.join(', ')}`);

    process.stderr.write(`\n[NeuroVerse] Markdown files changed since last bootstrap.\n`);
    process.stderr.write(`  ${changedSummary.join('; ')}\n`);

    // Prompt: regenerate?
    const answer = await new Promise<string>((res) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      process.stderr.write(`  Regenerate constitution? [y/n]: `);
      rl.on('line', (line) => { rl.close(); res(line.trim().toLowerCase()); });
      rl.on('close', () => res('n'));
    });

    if (answer === 'y' || answer === 'yes') {
      const mdFiles = readMdFiles(workspaceDir);
      if (Object.keys(mdFiles).length > 0) {
        const newWorld = bootstrapWorldFromMarkdown(mdFiles);
        engine.setWorld(newWorld);
        engine.saveWorld();
        process.stderr.write(`[NeuroVerse] Constitution regenerated. ${newWorld.invariants.length} invariants, ${newWorld.guards.length} guards, ${newWorld.rules.length} rules.\n\n`);
      } else {
        process.stderr.write(`[NeuroVerse] No .md files found. Keeping current constitution.\n\n`);
      }
    } else {
      process.stderr.write(`[NeuroVerse] Keeping current constitution.\n\n`);
    }

    // Always clear session allowlist and alert history on reset
    allowlist.clear();
    engine.clearAlertHistory();
  });

  // ── Background Drift Service ───────────────────────────────────
  if (monitor) {
    api.registerService({
      id: 'neuroverse-drift-monitor',
      start: () => {
        monitor!.start();
        api.logger.info('[NeuroVerse] Drift monitor started');
      },
      stop: () => {
        monitor!.stop();
        api.logger.info('[NeuroVerse] Drift monitor stopped');
      },
    });
  }

  // ── Agent Tool: world_proposal.create ──────────────────────────
  api.registerTool({
    name: 'world_proposal_create',
    description: 'Propose a governance amendment. The human must approve it with /world approve.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['add_guard', 'modify_threshold', 'add_role', 'add_invariant'] },
        reason: { type: 'string', description: 'Why this amendment is needed' },
        suggestion: { type: 'string', description: 'The specific change to make' },
        evidence: { type: 'string', description: 'What behavior triggered this recommendation' },
      },
      required: ['type', 'reason', 'suggestion'],
    },
    handler: async (args: any) => {
      const id = Date.now().toString(36);
      const proposal = { ...args, id, createdAt: Date.now(), source: 'agent' };
      const proposalPath = join(proposalsDir, `${id}.json`);
      writeFileSync(proposalPath, JSON.stringify(proposal, null, 2));

      return {
        text: `Governance amendment proposed (ID: ${id}).\nType: ${args.type}\nReason: ${args.reason}\nThe human must run /world approve ${id} to apply this change.`,
      };
    },
  });

  // ── CLI Commands (gateway CLI: `openclaw world ...`) ───────────
  api.registerCli(
    ({ program, logger }: any) => {
      const worldCmd = program
        .command('world')
        .description('NeuroVerse governance commands');

      // openclaw world bootstrap
      worldCmd
        .command('bootstrap')
        .description('Generate world.json from your .md files')
        .action(async () => {
          logger.info('[NeuroVerse] Reading .md files from workspace...');
          const mdFiles = readMdFiles(workspaceDir);

          for (const file of Object.keys(mdFiles)) {
            logger.info(`  Found ${file}`);
          }

          if (Object.keys(mdFiles).length === 0) {
            logger.info('  No .md files found in workspace.');
            logger.info('  Add any .md files to define your governance rules.');
            return;
          }

          logger.info(`[NeuroVerse] Bootstrapping world from ${Object.keys(mdFiles).length} files...`);

          const world = bootstrapWorldFromMarkdown(mdFiles);
          engine.setWorld(world);
          engine.saveWorld();

          logger.info(`World file created: ${worldPath}`);
          logger.info(`  Kernel: ${world.kernel.enforcementMode} mode`);
          logger.info(`  Invariants: ${world.invariants.length}`);
          logger.info(`  Guards: ${world.guards.length}`);
          logger.info(`  Rules: ${world.rules.length}`);
          logger.info(`  Roles: ${world.roles.length}`);
        });

      // openclaw world status
      worldCmd
        .command('status')
        .description('Show governance status')
        .action(() => {
          if (!existsSync(worldPath)) {
            logger.info('[NeuroVerse] No world file found. Run /world bootstrap first.');
            return;
          }
          const stats = engine.getStatus();
          const auditCounts = audit.getCounts();
          logger.info(`World: ${worldPath}`);
          logger.info(`Enforcement: ${config.enforcement ?? 'standard'}`);
          logger.info(`Invariants: ${stats.invariantCount}, Guards: ${stats.guardCount}, Rules: ${stats.ruleCount}, Roles: ${stats.roleCount}`);
          logger.info(`Verdicts — ALLOW: ${auditCounts.allow}, PAUSE: ${auditCounts.pause}, BLOCK: ${auditCounts.block}`);
        });

      // openclaw world laws
      worldCmd
        .command('laws')
        .description('Display the full constitution')
        .action(() => {
          if (!existsSync(worldPath)) {
            logger.info('[NeuroVerse] No world file found. Run /world bootstrap first.');
            return;
          }
          const world = engine.getWorld();
          if (!world) {
            logger.info('[NeuroVerse] World file could not be loaded.');
            return;
          }

          logger.info(`\n=== THE LAWS OF ${(world.metadata.name ?? 'NeuroVerse').toUpperCase()} ===\n`);
          if (world.metadata.description) logger.info(world.metadata.description);
          logger.info(`Enforcement: ${world.kernel.enforcementMode} | Overrides: ${world.kernel.sessionOverridesAllowed ? 'allowed' : 'disabled'}\n`);

          logger.info(`--- INVARIANTS (${world.invariants.length}) ---`);
          for (const inv of world.invariants) {
            logger.info(`  [${inv.id}] ${inv.description}`);
            logger.info(`    When: ${inv.condition.field} ${inv.condition.operator} ${JSON.stringify(inv.condition.value)}`);
          }

          logger.info(`\n--- GUARDS (${world.guards.length}) ---`);
          for (const guard of world.guards) {
            logger.info(`  [${guard.id}] → ${guard.enforcement.toUpperCase()}${guard.description ? ': ' + guard.description : ''}`);
            logger.info(`    When: ${guard.condition.field} ${guard.condition.operator} ${JSON.stringify(guard.condition.value)}`);
            if (guard.appliesTo.length > 0) logger.info(`    Applies to: ${guard.appliesTo.join(', ')}`);
          }

          logger.info(`\n--- RULES (${world.rules.length}) ---`);
          for (const rule of world.rules) {
            logger.info(`  [${rule.id}] → ${rule.effect.verdict.toUpperCase()}${rule.description ? ': ' + rule.description : ''}`);
            logger.info(`    Trigger: ${rule.trigger.field} ${rule.trigger.operator} ${JSON.stringify(rule.trigger.value)}`);
          }

          logger.info(`\n--- ROLES (${world.roles.length}) ---`);
          for (const role of world.roles) {
            logger.info(`  [${role.id}] ${role.name}`);
            if (role.canDo.length > 0) logger.info(`    Can do: ${role.canDo.join(', ')}`);
            if (role.cannotDo.length > 0) logger.info(`    Cannot do: ${role.cannotDo.join(', ')}`);
            logger.info(`    Requires approval: ${role.requiresApproval ? 'yes' : 'no'}`);
          }
        });
    },
    { commands: ['world'] },
  );

  // ── Chat Command: /world ───────────────────────────────────────
  // Registers as a slash command in the agent conversation.
  // Bypasses the LLM — processed directly by the plugin.

  api.registerCommand({
    name: 'world',
    description: 'NeuroVerse governance commands (bootstrap, status, laws, propose, approve, export)',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const cmdArgs = (ctx.args ?? '').trim();
      const [subcommand, ...rest] = cmdArgs.split(/\s+/);

      // ── /world (no args) or /world help ──
      if (!subcommand || subcommand === 'help') {
        return {
          text: [
            '**NeuroVerse Governance**',
            '',
            '`/world bootstrap` — Generate world.json from your .md files',
            '`/world status` — Show governance status, drift metrics, audit stats',
            '`/world laws` — Read the full constitution (invariants, guards, rules, roles)',
            '`/world bind <agentId> <roleId>` — Bind an agent to a governance role',
            '`/world unbind <agentId>` — Remove an agent\'s role binding',
            '`/world bindings` — Show all agent-to-role bindings',
            '`/world propose` — Agent recommends amendments',
            '`/world approve <id>` — Approve amendment',
            '`/world export` — Export .nv-world.zip',
            '',
            'Your .md files stay. Governance moves to world.json.',
            'Markdown is the interface. The world file is the constitution.',
          ].join('\n'),
        };
      }

      // ── /world bootstrap ──
      if (subcommand === 'bootstrap') {
        const lines: string[] = ['[NeuroVerse] Reading .md files from workspace...'];
        const mdFiles = readMdFiles(workspaceDir);

        for (const file of Object.keys(mdFiles)) {
          lines.push(`  Found ${file}`);
        }

        if (Object.keys(mdFiles).length === 0) {
          lines.push('  No .md files found in workspace.');
          lines.push('  Add any .md files to define your governance rules.');
          return { text: lines.join('\n') };
        }

        lines.push(`\n[NeuroVerse] Bootstrapping world from ${Object.keys(mdFiles).length} files...`);

        const world = bootstrapWorldFromMarkdown(mdFiles);
        engine.setWorld(world);
        engine.saveWorld();

        lines.push(`\nWorld file created: ${worldPath}`);
        lines.push(`  Kernel: ${world.kernel.enforcementMode} mode`);
        lines.push(`  Session overrides: ${world.kernel.sessionOverridesAllowed ? 'allowed' : 'disabled'}`);
        lines.push(`  Invariants: ${world.invariants.length}`);
        lines.push(`  Guards: ${world.guards.length}`);
        lines.push(`  Rules: ${world.rules.length}`);
        lines.push(`  Roles: ${world.roles.length}`);
        lines.push(`\n  Run '/world status' to see governance overview.`);
        return { text: lines.join('\n') };
      }

      // ── /world status ──
      if (subcommand === 'status') {
        if (!existsSync(worldPath)) {
          return { text: '[NeuroVerse] No world file found. Run /world bootstrap first.' };
        }

        const stats = engine.getStatus();
        const driftStats = monitor?.getStats();
        const auditCounts = audit.getCounts();

        const lines: string[] = [
          '\n=== NeuroVerse Governance Status ===\n',
          `World: ${worldPath}`,
          `Enforcement: ${config.enforcement ?? 'standard'}`,
          `Mode: ${config.observeFirst ? 'OBSERVE (recording only)' : 'ENFORCE (active governance)'}`,
          `\nInvariants: ${stats.invariantCount}`,
          `Guards: ${stats.guardCount}`,
          `Rules: ${stats.ruleCount}`,
          `Roles: ${stats.roleCount}`,
          `Role bindings: ${engine.getRoleBindings().length}`,
          `\n--- Audit Log ---`,
          `Total verdicts: ${auditCounts.total}`,
          `  ALLOW: ${auditCounts.allow}`,
          `  PAUSE: ${auditCounts.pause}`,
          `  BLOCK: ${auditCounts.block}`,
        ];

        if (driftStats) {
          lines.push(
            `\n--- Drift Metrics ---`,
            `Total actions: ${driftStats.totalActions}`,
            `Blocks: ${driftStats.blockCount} (${(driftStats.blockRate * 100).toFixed(1)}%)`,
            `Pauses: ${driftStats.pauseCount} (${(driftStats.pauseRate * 100).toFixed(1)}%)`,
            `Allows: ${driftStats.allowCount}`,
            `Override rate: ${(driftStats.overrideRate * 100).toFixed(1)}%`,
          );
          if (driftStats.driftSignals.length > 0) {
            lines.push(`\nDrift signals:`);
            for (const signal of driftStats.driftSignals) {
              lines.push(`  - ${signal}`);
            }
          }
        }

        // ── Markdown Drift Detection ──
        const world = engine.getWorld();
        const storedHashes = world?.metadata?.mdHashes;
        if (storedHashes) {
          const drift = checkMdDrift(workspaceDir, storedHashes);
          const hasDrift = drift.changed.length > 0 || drift.added.length > 0 || drift.removed.length > 0;
          if (hasDrift) {
            lines.push(`\n--- Constitution Drift ---`);
            lines.push(`Markdown files changed since last bootstrap.`);
            if (drift.changed.length > 0) lines.push(`  Modified: ${drift.changed.join(', ')}`);
            if (drift.added.length > 0) lines.push(`  New: ${drift.added.join(', ')}`);
            if (drift.removed.length > 0) lines.push(`  Removed: ${drift.removed.join(', ')}`);
            lines.push(`Governance may be out of sync. Run /world bootstrap to regenerate.`);
          } else {
            lines.push(`\nConstitution: in sync with .md files`);
          }
        } else {
          lines.push(`\nConstitution: no hash baseline (bootstrapped before drift detection was added)`);
          lines.push(`Run /world bootstrap to establish baseline.`);
        }

        return { text: lines.join('\n') };
      }

      // ── /world laws ──
      if (subcommand === 'laws') {
        if (!existsSync(worldPath)) {
          return { text: '[NeuroVerse] No world file found. Run /world bootstrap first.' };
        }

        const world = engine.getWorld();
        if (!world) {
          return { text: '[NeuroVerse] World file could not be loaded.' };
        }

        const lines: string[] = [
          '\n========================================',
          `  THE LAWS OF ${(world.metadata.name ?? 'NeuroVerse').toUpperCase()}`,
          '========================================\n',
        ];

        if (world.metadata.description) {
          lines.push(`${world.metadata.description}\n`);
        }

        lines.push(`Bootstrapped from: ${world.metadata.bootstrappedFrom.join(', ')}`);
        lines.push(`Enforcement mode: ${world.kernel.enforcementMode}`);
        lines.push(`Session overrides: ${world.kernel.sessionOverridesAllowed ? 'allowed' : 'disabled'}`);

        // ── Invariants ──
        lines.push(`\n--- INVARIANTS (${world.invariants.length}) ---`);
        lines.push(`Hard blocks. Cannot be overridden. Ever.\n`);
        if (world.invariants.length === 0) {
          lines.push('  (none)');
        }
        for (const inv of world.invariants) {
          lines.push(`  [${inv.id}]`);
          lines.push(`    ${inv.description}`);
          lines.push(`    When: ${inv.condition.field} ${inv.condition.operator} ${JSON.stringify(inv.condition.value)}`);
          if (inv.scope.length > 0) lines.push(`    Scope: ${inv.scope.join(', ')}`);
          lines.push('');
        }

        // ── Guards ──
        lines.push(`--- GUARDS (${world.guards.length}) ---`);
        lines.push(`Pause or block. Can be session-overridden if allowed.\n`);
        if (world.guards.length === 0) {
          lines.push('  (none)');
        }
        for (const guard of world.guards) {
          lines.push(`  [${guard.id}] → ${guard.enforcement.toUpperCase()}`);
          if (guard.description) lines.push(`    ${guard.description}`);
          lines.push(`    When: ${guard.condition.field} ${guard.condition.operator} ${JSON.stringify(guard.condition.value)}`);
          if (guard.appliesTo.length > 0) lines.push(`    Applies to: ${guard.appliesTo.join(', ')}`);
          if (guard.scope.length > 0) lines.push(`    Scope: ${guard.scope.join(', ')}`);
          if (guard.requiresApproval) lines.push(`    Requires approval: yes`);
          lines.push('');
        }

        // ── Rules ──
        lines.push(`--- RULES (${world.rules.length}) ---`);
        lines.push(`Contextual triggers with verdict effects.\n`);
        if (world.rules.length === 0) {
          lines.push('  (none)');
        }
        for (const rule of world.rules) {
          lines.push(`  [${rule.id}] → ${rule.effect.verdict.toUpperCase()}`);
          if (rule.description) lines.push(`    ${rule.description}`);
          lines.push(`    Trigger: ${rule.trigger.field} ${rule.trigger.operator} ${JSON.stringify(rule.trigger.value)}`);
          lines.push('');
        }

        // ── Roles ──
        lines.push(`--- ROLES (${world.roles.length}) ---`);
        lines.push(`Identity-based constraints.\n`);
        if (world.roles.length === 0) {
          lines.push('  (none)');
        }
        for (const role of world.roles) {
          lines.push(`  [${role.id}] ${role.name}`);
          if (role.canDo.length > 0) lines.push(`    Can do: ${role.canDo.join(', ')}`);
          if (role.cannotDo.length > 0) lines.push(`    Cannot do: ${role.cannotDo.join(', ')}`);
          lines.push(`    Requires approval: ${role.requiresApproval ? 'yes' : 'no'}`);
          lines.push('');
        }

        // ── Role Bindings ──
        const bindings = engine.getRoleBindings();
        lines.push(`--- ROLE BINDINGS (${bindings.length}) ---`);
        lines.push(`Agent identity → governance role. Environment-specific.\n`);
        if (bindings.length === 0) {
          lines.push('  (none — roles are defined but no agents are bound)');
          lines.push('  Run /world bind <agentId> <roleId> to assign.');
        }
        for (const binding of bindings) {
          const role = world.roles.find(r => r.id === binding.roleId);
          const roleName = role ? role.name : '(unknown role)';
          lines.push(`  ${binding.agentId} → [${binding.roleId}] ${roleName}`);
          lines.push(`    Bound by: ${binding.boundBy}`);
        }
        lines.push('');

        lines.push('========================================');
        return { text: lines.join('\n') };
      }

      // ── /world bind <agentId> <roleId> ──
      if (subcommand === 'bind') {
        const [agentId, roleId] = rest;
        if (!agentId || !roleId) {
          return { text: 'Usage: `/world bind <agentId> <roleId>`\n\nExample: `/world bind agent-coder-01 executor`' };
        }

        // Validate roleId exists in the world
        const world = engine.getWorld();
        if (!world) {
          return { text: '[NeuroVerse] No world loaded. Run /world bootstrap first.' };
        }
        const role = world.roles.find(r => r.id === roleId);
        if (!role) {
          const available = world.roles.map(r => `\`${r.id}\` (${r.name})`).join(', ');
          return { text: `[NeuroVerse] Role "${roleId}" not found.\n\nAvailable roles: ${available}` };
        }

        const meta = engine.getMetaRecord();
        if (!meta) {
          return { text: '[NeuroVerse] No meta record. Run /world bootstrap first.' };
        }

        // Classify severity and apply
        const severity = engine.setRoleBinding(agentId, roleId, 'human');
        engine.saveMeta();
        engine.hydrateRoleMap(roleMap);

        const severityLabel: Record<string, string> = {
          new_binding: 'LOW — new binding',
          reassignment: 'HIGH — role reassignment',
          escalation: 'CRITICAL — privilege escalation',
          de_escalation: 'LOW — privilege de-escalation',
          removal: 'HIGH — binding removed',
        };

        const lines: string[] = [
          `[NeuroVerse] Role binding updated.`,
          `  Agent:    ${agentId}`,
          `  Role:     ${role.id} (${role.name})`,
          `  Severity: ${severityLabel[severity] ?? severity}`,
          `  Can do:   ${role.canDo.join(', ') || '(none)'}`,
          `  Cannot do: ${role.cannotDo.join(', ') || '(none)'}`,
          `  Requires approval: ${role.requiresApproval ? 'yes' : 'no'}`,
        ];

        if (severity === 'escalation') {
          lines.push('');
          lines.push('  ⚠ This is a privilege escalation. The agent now has broader permissions.');
        }

        return { text: lines.join('\n') };
      }

      // ── /world unbind <agentId> ──
      if (subcommand === 'unbind') {
        const [agentId] = rest;
        if (!agentId) {
          return { text: 'Usage: `/world unbind <agentId>`' };
        }

        const removed = engine.removeRoleBinding(agentId);
        if (!removed) {
          return { text: `[NeuroVerse] No binding found for agent "${agentId}".` };
        }

        engine.saveMeta();
        engine.hydrateRoleMap(roleMap);

        return {
          text: [
            `[NeuroVerse] Role binding removed.`,
            `  Agent: ${agentId}`,
            `  Status: unbound (deny-by-default — role constraints will not apply)`,
          ].join('\n'),
        };
      }

      // ── /world bindings ──
      if (subcommand === 'bindings') {
        const bindings = engine.getRoleBindings();
        if (bindings.length === 0) {
          return {
            text: [
              '[NeuroVerse] No role bindings configured.',
              '',
              'Agents are unbound. Role constraints are inert.',
              'Run `/world bind <agentId> <roleId>` to assign roles.',
              '',
              'Available roles:',
              ...(engine.getWorld()?.roles.map(r => `  \`${r.id}\` — ${r.name}`) ?? ['  (no world loaded)']),
            ].join('\n'),
          };
        }

        const lines: string[] = [
          '**Agent Role Bindings**',
          '',
        ];

        for (const binding of bindings) {
          const role = engine.getWorld()?.roles.find(r => r.id === binding.roleId);
          const roleName = role ? ` (${role.name})` : ' (role not found in world)';
          const boundDate = new Date(binding.boundAt).toISOString().slice(0, 19);
          lines.push(`  \`${binding.agentId}\` → \`${binding.roleId}\`${roleName}`);
          lines.push(`    Bound by: ${binding.boundBy} at ${boundDate}`);
        }

        return { text: lines.join('\n') };
      }

      // ── /world propose ──
      if (subcommand === 'propose') {
        if (!monitor) {
          return { text: '[NeuroVerse] Drift tracking is disabled. Enable it to generate proposals.' };
        }

        const proposals = monitor.generateProposals();
        if (proposals.length === 0) {
          return { text: '[NeuroVerse] No amendments to propose. Governance is stable.' };
        }

        const lines: string[] = [];
        for (const proposal of proposals) {
          const id = Date.now().toString(36);
          const proposalPath = join(proposalsDir, `${id}.json`);
          writeFileSync(proposalPath, JSON.stringify({ ...proposal, id, createdAt: Date.now() }, null, 2));
          lines.push(`\nProposal ${id}:`);
          lines.push(`  Type: ${proposal.type}`);
          lines.push(`  Reason: ${proposal.reason}`);
          lines.push(`  Suggestion: ${proposal.suggestion}`);
        }
        lines.push(`\nRun '/world approve <id>' to apply a proposal.`);
        return { text: lines.join('\n') };
      }

      // ── /world approve <id> ──
      if (subcommand === 'approve') {
        const id = rest[0];
        if (!id) {
          return { text: 'Usage: /world approve <proposal-id>' };
        }
        const proposalPath = join(proposalsDir, `${id}.json`);
        if (!existsSync(proposalPath)) {
          return { text: `[NeuroVerse] Proposal ${id} not found.` };
        }

        const proposal = JSON.parse(readFileSync(proposalPath, 'utf-8'));
        engine.applyAmendment(proposal);
        engine.saveWorld();

        return { text: `Proposal ${id} approved and applied to world.\n  World file updated: ${worldPath}` };
      }

      // ── /world export ──
      if (subcommand === 'export') {
        if (!existsSync(worldPath)) {
          return { text: '[NeuroVerse] No world file. Run /world bootstrap first.' };
        }
        return {
          text: [
            '[NeuroVerse] Export to .nv-world.zip:',
            '  Use the NeuroVerse configurator at https://www.neuroverseos.com/build/configurator',
            `  Or copy ${worldPath} to use with the Action Space runner.`,
          ].join('\n'),
        };
      }

      return { text: `Unknown subcommand: ${subcommand}. Run /world help for usage.` };
    },
  });

  // ── Startup ────────────────────────────────────────────────────
  api.logger.info('[NeuroVerse] Governance plugin loaded (v1.2.0)');
  if (existsSync(worldPath)) {
    engine.loadWorld();
    engine.loadMeta();
    const status = engine.getStatus();
    api.logger.info(
      `[NeuroVerse] World loaded: ${status.invariantCount} invariants, ${status.guardCount} guards, ${status.ruleCount} rules, ${status.roleCount} roles`,
    );
    const meta = engine.getMetaRecord();
    if (meta) {
      api.logger.info(`[NeuroVerse] Integrity tracking active (v${meta.version}, hash: ${meta.hash.slice(0, 12)}...)`);
    }

    // Hydrate roleMap from meta bindings (agent identity → governance role)
    engine.hydrateRoleMap(roleMap);
    const bindingCount = engine.getRoleBindings().length;
    if (bindingCount > 0) {
      api.logger.info(`[NeuroVerse] Role bindings: ${bindingCount} agent(s) bound to roles`);
    } else {
      api.logger.info(`[NeuroVerse] No role bindings. Agents are unbound. Run /world bind <agentId> <roleId> to assign.`);
    }
  } else {
    api.logger.info('[NeuroVerse] No world file found. Run /world bootstrap to create one.');
  }
}
