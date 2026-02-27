/**
 * test-governance.js — Standalone governance engine test
 *
 * Tests the four verdict paths:
 *   1. Invariant  → BLOCK  (destructive shell command)
 *   2. Guard      → PAUSE  (production database write)
 *   3. Role       → BLOCK  (junior role forbidden action)
 *   4. Default    → ALLOW  (safe, unmatched operation)
 *
 * Run: node test-governance.js
 */

const { GovernanceEngine } = require('./dist/governance-engine');

// ── Test World ────────────────────────────────────────────────────────

const testWorld = {
  version: '1.0.0',
  kernel: {
    enforcementMode: 'strict',
    defaultVerdict: 'allow',
    evaluationOrder: ['invariants', 'guards', 'rules'],
    sessionOverridesAllowed: false,
  },
  invariants: [
    {
      id: 'no-rm-rf',
      description: 'Never allow rm -rf on root paths',
      scope: ['tool_call'],
      condition: { field: 'intent', operator: 'contains', value: 'rm -rf /' },
      enforcement: 'block',
    },
  ],
  guards: [
    {
      id: 'prod-db-write',
      description: 'Production database writes require approval',
      scope: ['tool_call'],
      appliesTo: ['database'],
      condition: { field: 'intent', operator: 'contains', value: 'production' },
      enforcement: 'pause',
      requiresApproval: true,
    },
  ],
  rules: [
    {
      id: 'block-drop-table',
      description: 'DROP TABLE is always blocked',
      trigger: { field: 'intent', operator: 'contains', value: 'DROP TABLE' },
      effect: { verdict: 'block' },
    },
  ],
  roles: [
    {
      id: 'junior',
      name: 'Junior Developer',
      canDo: ['read', 'lint'],
      cannotDo: ['deploy', 'shell'],
      requiresApproval: false,
    },
  ],
  metadata: {
    name: 'test-world',
    bootstrappedFrom: [],
    bootstrappedAt: Date.now(),
  },
};

// ── Helpers ───────────────────────────────────────────────────────────

function makeEvent(overrides) {
  return {
    type: 'tool_call',
    tool: 'shell',
    intent: 'echo hello',
    args: {},
    sessionOverrides: [],
    ...overrides,
  };
}

let passed = 0;
let failed = 0;

function assert(name, verdict, expectedStatus) {
  const ok = verdict.status === expectedStatus;
  const icon = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${icon}] ${name}`);
  console.log(`         Status: ${verdict.status}  Reason: ${verdict.reason}`);
  if (verdict.evidence) {
    console.log(`         Evidence: ${verdict.evidence}`);
  }
  if (!ok) {
    console.log(`         Expected: ${expectedStatus}, Got: ${verdict.status}`);
    failed++;
  } else {
    passed++;
  }
  console.log();
}

// ── Run Tests ─────────────────────────────────────────────────────────

const engine = new GovernanceEngine({
  worldPath: '/tmp/test-world.json',
  enforcement: 'strict',
  observeOnly: false,
});

engine.setWorld(testWorld);

console.log('');
console.log('═══════════════════════════════════════════════════════');
console.log('  NeuroVerse Governance Engine — Test Suite');
console.log('═══════════════════════════════════════════════════════');
console.log('');

// Test 1: Invariant BLOCK
assert(
  'Invariant blocks rm -rf /',
  engine.evaluate(makeEvent({ intent: 'rm -rf /data' })),
  'BLOCK',
);

// Test 2: Guard PAUSE
assert(
  'Guard pauses production database write',
  engine.evaluate(makeEvent({ tool: 'database', intent: 'write to production table' })),
  'PAUSE',
);

// Test 3: Rule BLOCK
assert(
  'Rule blocks DROP TABLE',
  engine.evaluate(makeEvent({ tool: 'database', intent: 'DROP TABLE users' })),
  'BLOCK',
);

// Test 4: Role BLOCK (cannotDo)
assert(
  'Role blocks junior from shell access',
  engine.evaluate(makeEvent({ tool: 'shell', intent: 'list files', role: 'junior' })),
  'BLOCK',
);

// Test 5: Default ALLOW
assert(
  'Default allows safe unmatched operation',
  engine.evaluate(makeEvent({ tool: 'editor', intent: 'open file readme.md' })),
  'ALLOW',
);

// Test 6: Invariant overrides session override (invariants can never be bypassed)
assert(
  'Invariant cannot be session-overridden',
  engine.evaluate(makeEvent({
    intent: 'rm -rf /etc',
    sessionOverrides: ['invariant:no-rm-rf'],
  })),
  'BLOCK',
);

// ── Summary ───────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('═══════════════════════════════════════════════════════');
console.log('');

process.exit(failed > 0 ? 1 : 0);
