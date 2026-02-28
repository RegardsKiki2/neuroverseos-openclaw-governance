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
 *   /world propose      — Agent recommends governance amendments
 *   /world approve <id> — Human approves a proposed amendment
 *   /world export       — Export for use in other tools
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createInterface } from 'readline';
import { join, resolve } from 'path';
import { bootstrapWorldFromMarkdown, checkMdDrift } from './world-bootstrap';
import { GovernanceEngine } from './governance-engine';
import { DriftMonitor } from './drift-monitor';
import { AuditLogger } from './audit-logger';
import type { ToolCallEvent, GovernanceVerdict } from './types';

// ────────────────────────────────────────────────────────────────────────
// Terminal Prompt — Interactive pause resolution (spec §6)
// ────────────────────────────────────────────────────────────────────────

/**
 * Prompt the developer in the terminal for a pause decision.
 * Blocks until they respond. Returns their choice.
 *
 * Display format matches spec:
 *   [governance] PAUSE  rm -rf /data
 *                guard: destructive_shell_requires_approval
 *                Allow? [y]es once / [a]lways / [n]o: _
 */
function promptForDecision(
  intent: string,
  guardLabel: string,
): Promise<'allow-once' | 'allow-always' | 'deny'> {
  return new Promise((resolvePrompt) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    process.stderr.write(`\n[governance] PAUSE  ${intent}\n`);
    process.stderr.write(`             guard: ${guardLabel}\n`);
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

const MD_CANDIDATES = [
  'system.md', 'personality.md', 'tools.md',
  'MEMORY.md', 'memory.md',
  'constitution.md', 'guardrails.md',
];

function readMdFiles(dir: string): Record<string, string> {
  const mdFiles: Record<string, string> = {};
  for (const file of MD_CANDIDATES) {
    const fullPath = join(dir, file);
    if (existsSync(fullPath)) {
      mdFiles[file] = readFileSync(fullPath, 'utf-8');
    }
  }
  return mdFiles;
}

// ────────────────────────────────────────────────────────────────────────
// Plugin Registration
// ────────────────────────────────────────────────────────────────────────

/**
 * Resolve the persistent storage root.
 * Priority: explicit env var → OpenClaw home → Docker default → local cwd.
 * Plugin must never assume a specific filesystem layout.
 */
function getStorageRoot(): string {
  if (process.env.OPENCLAW_DATA_DIR) {
    return process.env.OPENCLAW_DATA_DIR;
  }
  if (process.env.OPENCLAW_HOME) {
    return process.env.OPENCLAW_HOME;
  }
  // Docker / container environment — /data is the mounted writable volume
  if (process.env.DOCKER || process.env.CONTAINER) {
    return '/data';
  }
  // Local dev fallback
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

  // Workspace content: where .md files live (for bootstrap & drift detection)
  const workspaceDir = api.resolvePath('.');

  // Storage root: where .neuroverse/ persistent data lives
  const storageRoot = getStorageRoot();
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

    // ── BLOCK ──────────────────────────────────────────────
    if (verdict.status === 'BLOCK') {
      api.logger.warn(`[governance] BLOCK  ${govEvent.intent}`);
      api.logger.warn(`             ${verdict.ruleId ?? verdict.reason}`);
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

      // Interactive prompt (spec §6 step 3)
      const guardLabel = verdict.guard ?? verdict.ruleId ?? 'governance rule';
      const decision = await promptForDecision(govEvent.intent, guardLabel);

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

    // Always clear session allowlist on reset
    allowlist.clear();
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
            logger.info('  Expected: system.md, personality.md, tools.md, etc.');
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
    },
    { commands: ['world'] },
  );

  // ── Chat Command: /world ───────────────────────────────────────
  // Registers as a slash command in the agent conversation.
  // Bypasses the LLM — processed directly by the plugin.

  api.registerCommand({
    name: 'world',
    description: 'NeuroVerse governance commands (bootstrap, status, propose, approve, export)',
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
          lines.push('  Expected: system.md, personality.md, tools.md, etc.');
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
  api.logger.info('[NeuroVerse] Governance plugin loaded (v1.0.0)');
  if (existsSync(worldPath)) {
    engine.loadWorld();
    const status = engine.getStatus();
    api.logger.info(
      `[NeuroVerse] World loaded: ${status.invariantCount} invariants, ${status.guardCount} guards, ${status.ruleCount} rules, ${status.roleCount} roles`,
    );
  } else {
    api.logger.info('[NeuroVerse] No world file found. Run /world bootstrap to create one.');
  }
}
