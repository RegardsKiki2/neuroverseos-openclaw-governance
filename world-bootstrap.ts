/**
 * World Bootstrap — Generate structured world.json from workspace .md files
 *
 * Scans all .md files in the workspace dynamically and produces a
 * world.json matching the governance runtime spec:
 *   kernel + invariants + guards + rules + roles + metadata
 *
 * No filename assumptions — any .md file contributes to the world.
 * This is deterministic extraction — no AI needed.
 * The output matches the GovernanceWorld type exactly.
 */

import { createHash } from 'crypto';
import type { GovernanceWorld, Invariant, Guard, Rule, Role } from './types';

// ────────────────────────────────────────────────────────────────────────
// Constraint Patterns
// ────────────────────────────────────────────────────────────────────────

const CONSTRAINT_PATTERNS = [
  { regex: /must\s+never\s+(.+)/gi, enforcement: 'block' as const },
  { regex: /never\s+(.+)/gi, enforcement: 'block' as const },
  { regex: /forbidden[:\s]+(.+)/gi, enforcement: 'block' as const },
  { regex: /prohibited[:\s]+(.+)/gi, enforcement: 'block' as const },
  { regex: /do\s+not\s+(.+)/gi, enforcement: 'block' as const },
  { regex: /shall\s+not\s+(.+)/gi, enforcement: 'block' as const },
  { regex: /under\s+no\s+circumstances[,:\s]+(.+)/gi, enforcement: 'block' as const },
  { regex: /must\s+always\s+(.+)/gi, enforcement: 'pause' as const },
  { regex: /always\s+(.+)/gi, enforcement: 'pause' as const },
  { regex: /requires?\s+(?:human\s+)?approval[:\s]+(.+)/gi, enforcement: 'pause' as const },
];

const RISK_KEYWORDS = [
  { word: 'cautious', score: 0.3 },
  { word: 'conservative', score: 0.2 },
  { word: 'aggressive', score: 0.7 },
  { word: 'careful', score: 0.3 },
  { word: 'bold', score: 0.8 },
  { word: 'safe', score: 0.2 },
  { word: 'risky', score: 0.7 },
  { word: 'moderate', score: 0.5 },
  { word: 'strict', score: 0.2 },
  { word: 'flexible', score: 0.6 },
  { word: 'permissive', score: 0.7 },
  { word: 'locked down', score: 0.1 },
];

const TOOL_RESTRICTION_PATTERNS = [
  { regex: /(?:do not|never|cannot|must not)\s+(?:use|call|invoke|execute)\s+(?:the\s+)?(\w+)/gi, type: 'block' as const },
  { regex: /(\w+)\s+(?:tool|command|function)\s+(?:is\s+)?(?:blocked|forbidden|prohibited|disabled)/gi, type: 'block' as const },
  { regex: /(\w+)\s+(?:requires?|needs?)\s+(?:approval|review|confirmation)/gi, type: 'pause' as const },
];

const ROLE_PATTERNS = [
  { regex: /you\s+are\s+(?:a|an|the)\s+(.+?)(?:\.|$)/gim },
  { regex: /(?:role|acting as|serving as)[:\s]+(.+?)(?:\.|$)/gim },
  { regex: /(?:agent|bot|assistant)\s+(?:name|id|role)[:\s]+(.+?)(?:\.|$)/gim },
];

// ────────────────────────────────────────────────────────────────────────
// Bootstrap
// ────────────────────────────────────────────────────────────────────────

/**
 * Generate a structured governance world from OpenClaw .md files.
 * Output matches the GovernanceWorld type and the runtime spec exactly.
 */
export function bootstrapWorldFromMarkdown(
  mdFiles: Record<string, string>,
): GovernanceWorld {
  const allText = Object.values(mdFiles).join('\n\n');
  const fileNames = Object.keys(mdFiles);

  // Extract governance structures
  const invariants = extractInvariants(allText);
  const guards = extractGuards(allText);
  const rules = extractRules(allText);
  const roles = extractRoles(mdFiles);

  // Determine enforcement mode from risk tolerance
  const riskTolerance = assessRiskTolerance(allText);
  const enforcementMode: 'strict' | 'standard' | 'permissive' =
    riskTolerance < 0.3 ? 'strict'
      : riskTolerance > 0.6 ? 'permissive'
      : 'standard';

  return {
    version: '1.0.0',
    kernel: {
      enforcementMode,
      defaultVerdict: 'allow',
      evaluationOrder: ['invariants', 'guards', 'rules'],
      sessionOverridesAllowed: enforcementMode !== 'strict',
    },
    invariants,
    guards,
    rules,
    roles,
    metadata: {
      name: extractName(mdFiles),
      bootstrappedFrom: fileNames,
      bootstrappedAt: Date.now(),
      mdHashes: hashMdFiles(mdFiles),
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Extractors
// ────────────────────────────────────────────────────────────────────────

function extractName(mdFiles: Record<string, string>): string {
  // Search all files for a title — first H1 heading or name/title declaration wins
  for (const content of Object.values(mdFiles)) {
    const firstLines = content.split('\n').slice(0, 10);
    for (const line of firstLines) {
      const titleMatch = line.match(/^#\s+(.+)/);
      if (titleMatch) return titleMatch[1].trim();
      const nameMatch = line.match(/(?:name|title|agent)[:\s]+(.+)/i);
      if (nameMatch) return nameMatch[1].trim();
    }
  }
  return 'OpenClaw Agent';
}

/**
 * Extract invariants — non-overridable BLOCK rules.
 * Only "block" level constraints become invariants.
 */
function extractInvariants(text: string): Invariant[] {
  const invariants: Invariant[] = [];
  const seen = new Set<string>();
  let counter = 0;

  for (const { regex, enforcement } of CONSTRAINT_PATTERNS) {
    if (enforcement !== 'block') continue;

    const cloned = new RegExp(regex.source, regex.flags);
    for (const match of text.matchAll(cloned)) {
      const desc = match[1]?.trim();
      if (!desc || desc.length < 5 || desc.length > 200) continue;

      const normalized = desc.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      counter++;
      const patterns = extractKeyPhrases(desc);

      invariants.push({
        id: `no-${slugify(desc.slice(0, 40))}-${counter}`,
        description: desc,
        scope: ['tool_call'],
        condition: {
          field: 'intent',
          operator: patterns.length > 1 ? 'contains_any' : 'contains',
          value: patterns.length > 1 ? patterns : patterns[0] ?? desc.toLowerCase(),
        },
        enforcement: 'block',
      });
    }
  }

  return invariants.slice(0, 15);
}

/**
 * Extract guards — scoped rules that PAUSE or BLOCK.
 * Includes both constraint-derived and tool-restriction-derived guards.
 */
function extractGuards(text: string): Guard[] {
  const guards: Guard[] = [];
  const seen = new Set<string>();
  let counter = 0;

  // From constraint patterns (non-block become guards with pause enforcement)
  for (const { regex, enforcement } of CONSTRAINT_PATTERNS) {
    if (enforcement === 'block') continue; // these became invariants

    const cloned = new RegExp(regex.source, regex.flags);
    for (const match of text.matchAll(cloned)) {
      const desc = match[1]?.trim();
      if (!desc || desc.length < 5 || desc.length > 200) continue;

      const normalized = desc.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      counter++;
      const patterns = extractKeyPhrases(desc);

      guards.push({
        id: `guard-${slugify(desc.slice(0, 40))}-${counter}`,
        description: desc,
        scope: ['tool_call'],
        appliesTo: [],
        condition: {
          field: 'intent',
          operator: patterns.length > 1 ? 'contains_any' : 'contains',
          value: patterns.length > 1 ? patterns : patterns[0] ?? desc.toLowerCase(),
        },
        enforcement: 'pause',
        requiresApproval: true,
      });
    }
  }

  // From tool restriction patterns → tool-specific guards
  for (const { regex, type } of TOOL_RESTRICTION_PATTERNS) {
    const cloned = new RegExp(regex.source, regex.flags);
    for (const match of text.matchAll(cloned)) {
      const tool = match[1]?.trim().toLowerCase();
      if (!tool || tool.length < 2 || tool.length > 30) continue;
      if (seen.has(tool)) continue;
      seen.add(tool);

      counter++;
      guards.push({
        id: `tool-restriction-${tool}-${counter}`,
        description: `Restricted tool: ${tool}`,
        scope: ['tool_call'],
        appliesTo: [tool],
        condition: {
          field: 'tool',
          operator: '==',
          value: tool,
        },
        enforcement: type,
        requiresApproval: type === 'pause',
      });
    }
  }

  return guards.slice(0, 20);
}

/**
 * Extract rules — contextual triggers with verdict effects.
 * These are softer than guards — things like "production requires review".
 */
function extractRules(text: string): Rule[] {
  const rules: Rule[] = [];

  // Production environment rule (common pattern)
  if (/production|prod\s+env/i.test(text)) {
    rules.push({
      id: 'prod-write-requires-review',
      description: 'Production environment requires review',
      trigger: {
        field: 'environment',
        operator: '==',
        value: 'production',
      },
      effect: { verdict: 'pause' },
    });
  }

  // Destructive operations rule (common pattern)
  if (/destruct|dangerous|risky\s+operation/i.test(text)) {
    rules.push({
      id: 'destructive-ops-pause',
      description: 'Destructive operations require approval',
      trigger: {
        field: 'intent',
        operator: 'matches_pattern',
        value: ['rm\\s+-rf', 'drop\\s+table', 'truncate', 'delete.*--force'],
      },
      effect: { verdict: 'pause' },
    });
  }

  // External communication rule
  if (/external|outside|third.?party|api\s+call/i.test(text)) {
    rules.push({
      id: 'external-comms-pause',
      description: 'External communication requires approval',
      trigger: {
        field: 'intent',
        operator: 'contains_any',
        value: ['send email', 'post to', 'publish', 'deploy'],
      },
      effect: { verdict: 'pause' },
    });
  }

  return rules;
}

/**
 * Extract roles from identity/role declarations.
 */
function extractRoles(mdFiles: Record<string, string>): Role[] {
  const roles: Role[] = [];
  const allText = Object.values(mdFiles).join('\n\n');
  const seen = new Set<string>();

  for (const { regex } of ROLE_PATTERNS) {
    const cloned = new RegExp(regex.source, regex.flags);
    for (const match of allText.matchAll(cloned)) {
      const roleName = match[1]?.trim();
      if (!roleName || roleName.length < 3 || roleName.length > 60) continue;

      const normalized = roleName.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      roles.push({
        id: slugify(roleName),
        name: roleName,
        canDo: ['read', 'write', 'shell'],
        cannotDo: [],
        requiresApproval: false,
      });
    }
  }

  // Default role if none found
  if (roles.length === 0) {
    roles.push({
      id: 'executor',
      name: 'Executor',
      canDo: ['read', 'write', 'shell'],
      cannotDo: [],
      requiresApproval: false,
    });
  }

  return roles.slice(0, 10);
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function assessRiskTolerance(text: string): number {
  const lower = text.toLowerCase();
  let totalScore = 0;
  let matchCount = 0;

  for (const { word, score } of RISK_KEYWORDS) {
    if (lower.includes(word)) {
      totalScore += score;
      matchCount++;
    }
  }

  if (matchCount === 0) return 0.5;
  return totalScore / matchCount;
}

/**
 * Extract key phrases from a description for use as condition values.
 */
function extractKeyPhrases(desc: string): string[] {
  return desc
    .toLowerCase()
    .split(/[,;]/)
    .map(s => s.trim())
    .filter(s => s.length > 3);
}

/**
 * Convert a string to a kebab-case slug for use as IDs.
 */
function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

// ────────────────────────────────────────────────────────────────────────
// Content Hashing — Drift Detection
// ────────────────────────────────────────────────────────────────────────

/**
 * SHA-256 hash of file content. Deterministic, fast, collision-resistant.
 */
function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Hash all .md files at bootstrap time. Stored in world.json metadata.
 */
function hashMdFiles(mdFiles: Record<string, string>): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const [name, content] of Object.entries(mdFiles)) {
    hashes[name] = hashContent(content);
  }
  return hashes;
}

/**
 * Compare current .md file contents against stored hashes.
 * Returns list of changed/added/removed files, or empty array if no drift.
 */
export function checkMdDrift(
  workspaceDir: string,
  storedHashes: Record<string, string>,
): { changed: string[]; added: string[]; removed: string[] } {
  const { readdirSync, readFileSync } = require('fs');
  const { join } = require('path');

  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  // Scan workspace for all .md files
  let currentFiles: string[] = [];
  try {
    currentFiles = (readdirSync(workspaceDir) as string[])
      .filter((f: string) => f.toLowerCase().endsWith('.md'));
  } catch {
    // Workspace unreadable — treat all stored hashes as removed
    return { changed, added, removed: Object.keys(storedHashes) };
  }

  const seen = new Set<string>();

  // Check current files against stored hashes
  for (const file of currentFiles) {
    seen.add(file);
    const fullPath = join(workspaceDir, file);
    const hadHash = file in storedHashes;

    try {
      const currentHash = hashContent(readFileSync(fullPath, 'utf-8'));
      if (hadHash) {
        if (currentHash !== storedHashes[file]) {
          changed.push(file);
        }
      } else {
        added.push(file);
      }
    } catch {
      // File unreadable — skip
    }
  }

  // Detect removed files (were hashed before, no longer present)
  for (const file of Object.keys(storedHashes)) {
    if (!seen.has(file)) {
      removed.push(file);
    }
  }

  return { changed, added, removed };
}

/**
 * Quick boolean check: has anything drifted?
 */
export function hasMdDrift(
  workspaceDir: string,
  storedHashes: Record<string, string>,
): boolean {
  const drift = checkMdDrift(workspaceDir, storedHashes);
  return drift.changed.length > 0 || drift.added.length > 0 || drift.removed.length > 0;
}
