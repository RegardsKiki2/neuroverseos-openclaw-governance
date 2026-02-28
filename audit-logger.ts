/**
 * Audit Logger — Append-only JSONL governance log
 *
 * Every verdict logged. Every PAUSE paired with a decision.
 * Every entry references a ruleId. /world status reads this for drift metrics.
 *
 * Format: .neuroverseos/audit.jsonl — one JSON object per line.
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { AuditEntry, AuditDecisionEntry, GovernanceVerdict } from './types';

let eventCounter = 0;

function nextEventId(): string {
  eventCounter++;
  return `ev-${String(eventCounter).padStart(3, '0')}`;
}

export class AuditLogger {
  private logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
    const dir = dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Log a governance verdict. Returns the event ID for pairing with decisions.
   * Includes agentId for provenance tracking and severity for audit analysis.
   */
  logVerdict(tool: string, intent: string, verdict: GovernanceVerdict, agentId?: string): string {
    const id = nextEventId();
    const entry: AuditEntry = {
      ts: Date.now(),
      id,
      tool,
      intent,
      status: verdict.status,
      ruleId: verdict.ruleId,
      evidence: verdict.evidence,
      agentId,
      severity: verdict.severity,
    };
    this.append(entry);
    return id;
  }

  /**
   * Log a PAUSE decision (allow-once, allow-always, deny).
   * Paired with the original verdict by event ID.
   */
  logDecision(eventId: string, decision: 'allow-once' | 'allow-always' | 'deny'): void {
    const entry: AuditDecisionEntry = {
      ts: Date.now(),
      id: eventId,
      type: 'decision',
      decision,
      decidedAt: Date.now(),
    };
    this.append(entry);
  }

  /**
   * Read all audit entries (for drift analysis / status command).
   */
  readAll(): Array<AuditEntry | AuditDecisionEntry> {
    if (!existsSync(this.logPath)) return [];
    try {
      const raw = readFileSync(this.logPath, 'utf-8');
      return raw
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /**
   * Count entries by status (for quick stats).
   */
  getCounts(): { total: number; allow: number; pause: number; block: number } {
    const entries = this.readAll().filter(
      (e): e is AuditEntry => !('type' in e && e.type === 'decision'),
    );
    return {
      total: entries.length,
      allow: entries.filter(e => e.status === 'ALLOW').length,
      pause: entries.filter(e => e.status === 'PAUSE').length,
      block: entries.filter(e => e.status === 'BLOCK').length,
    };
  }

  private append(entry: AuditEntry | AuditDecisionEntry): void {
    try {
      appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
    } catch {
      // Silent failure — don't crash enforcement on log write failure
    }
  }
}
