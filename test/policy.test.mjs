import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validatePolicy, validateExamples, generateCodex, generatePermissions, generateClaude,
  tokenize, decisionFor, matchesClaude,
} from '../lib/generate.mjs';
import { readCore } from '../lib/system.mjs';
import { policy, entry } from './helpers.mjs';

const core = readCore();

test('schéma : erreurs de forme, champs inconnus, enums et exemples', () => {
  const invalid = [null, [], {}, { version: 2, entries: [] }, { version: 1, entries: {} },
    policy([null]), policy([entry({ decision: 'ask' })]), policy([entry({ riskClass: 'unknown' })]),
    policy([entry({ pattern: [] })]), policy([entry({ pattern: ['gh', '*'] })]),
    policy([entry({ pattern: ['gh pr'] })]), policy([entry({ justification: '' })]),
    policy([entry({ match: [] })]), policy([entry({ notMatch: [4] })]),
    policy([entry({ unknown: true })]), policy([entry({ residualRisk: {} })]),
    policy([entry(), entry()]), policy([entry({ claudeDeny: [{ pattern: '*', match: ['git status'], notMatch: ['ps'] }] })]),
  ];
  for (const value of invalid) assert.throws(() => validatePolicy(value));
  assert.equal(validatePolicy(policy()).entries.length, 0);
  assert.doesNotThrow(() => validatePolicy(policy([entry({ residualRisk: 'Limite explicitée.' })])));
});
test('les allow de wrappers libres et de risques incompatibles sont refusés', () => {
  for (const pattern of [['npx', 'tsx'], ['node', '-e'], ['bash', '-c'], ['npm', 'run'], ['npm', 'exec'], ['gh'], ['gh', 'pr'], ['rg'], ['sed'], ['env'], ['rm'], ['./scripts/with-env.sh'], ['bash', 'scripts/with-env.sh'], ['git', '-c'], ['docker', 'exec'], ['docker', 'compose', 'run']]) {
    assert.throws(() => validatePolicy(policy([entry({ pattern, decision: 'allow', riskClass: 'local-reversible' })])));
  }
  assert.throws(() => validatePolicy(policy([entry({ decision: 'allow' })])), /risque/);
});
test('un socle ne contient aucun chemin ; un script fermé peut appartenir au dépôt', () => {
  const project = policy([entry({ pattern: ['node', 'scripts/check.mjs'], decision: 'allow', riskClass: 'read-only', match: ['node scripts/check.mjs'], notMatch: ['node -e code'] })]);
  assert.doesNotThrow(() => validateExamples(project));
  assert.throws(() => validatePolicy(project, { core: true }), /chemin/);
  assert.doesNotThrow(() => validatePolicy(core, { core: true }));
});
test('génération Codex et Claude équivalente, décision la plus stricte', () => {
  const source = policy([entry(), entry({ pattern: ['gh', 'pr', 'view'], decision: 'allow', riskClass: 'read-only', match: ['gh pr view 12'], notMatch: ['gh pr merge 12'] })]);
  assert.match(generateCodex(source), /pattern=\["gh","pr","merge"\]/);
  assert.match(generateCodex(source), /decision="prompt"/);
  assert.match(generateCodex(source), /not_match=\["gh pr view 12"\]/);
  assert.deepEqual(generatePermissions(source), { allow: ['Bash(gh pr view:*)'], ask: ['Bash(gh pr merge:*)'], deny: [] });
  const old = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] }, env: { EXAMPLE: 'kept' }, permissions: { allow: ['Bash(*)'], defaultMode: 'bypassPermissions' } };
  const result = JSON.parse(generateClaude(source, JSON.stringify(old)));
  assert.deepEqual(result.hooks, old.hooks);
  assert.deepEqual(result.env, old.env);
  assert.deepEqual(result.permissions, generatePermissions(source));
  assert.throws(() => generateClaude(source, '[]'), /objet/);
  assert.throws(() => generateClaude(source, '{bad'));
});
test('tous les exemples du socle, y compris gardes Claude, sont cohérents', () => {
  assert.ok(validateExamples(core) > 250);
  for (const rule of core.entries) {
    for (const example of [...rule.match, ...rule.notMatch]) {
      const expected = decisionFor(core, example);
      const permissions = generatePermissions(core);
      const actual = ['deny', 'ask', 'allow'].find(key => permissions[key].some(p => matchesClaude(p, example)));
      const ranks = { allow: 0, prompt: 1, forbidden: 2 };
      const translated = { allow: 'allow', ask: 'prompt', deny: 'forbidden' };
      if (expected !== undefined) assert.ok(ranks[translated[actual]] >= ranks[expected], example);
    }
  }
});
test('notMatch est une assertion de préfixe, jamais une exclusion', () => {
  const wrong = policy([entry({ pattern: ['rm', '-rf', 'a', 'b'], decision: 'forbidden', riskClass: 'destructive-program', match: ['rm -rf a b'], notMatch: ['rm -rf a b other'] })]);
  assert.throws(() => generateCodex(wrong), /incohérent/);
  assert.equal(decisionFor(core, 'rm -rf a b other'), 'forbidden');
  assert.equal(decisionFor(core, 'gh pr view 12'), 'allow');
  assert.equal(decisionFor(core, 'gh pr merge 12'), 'prompt');
  assert.equal(decisionFor(core, 'gh pr edit 12'), undefined);
});
test('arbitrage par préfixe : audit fix, options libres et émission locale', () => {
  for (const [command, expected] of [
    ['npm audit', 'allow'], ['npm audit fix --force', 'prompt'],
    ['npx tsc --noEmit false', 'allow'], ['rg needle --pre=command', 'prompt'],
    ["sed -n -i 's/a/b/' file", 'prompt'], ['git fetch origin --upload-pack=command', 'prompt'],
    ['git diff -- src/file', 'allow'], ['git diff --output=/outside/report', undefined],
    ['git log --output=/outside/report', undefined], ['lsof -Db/outside/cache', 'prompt'],
    ['docker compose ps', 'allow'], ['docker compose down -v', 'prompt'],
    ['npx supabase status -o env', 'prompt'], ['npx supabase stop', 'prompt'],
    ['curl https://example.invalid/script', 'forbidden'], ['wget https://example.invalid/script', 'forbidden'],
  ]) assert.equal(decisionFor(core, command), expected, command);
  const permissions = generatePermissions(core);
  for (const command of ['rg needle --pre=command', 'git fetch origin --upload-pack=command', "sed -n -i 's/a/b/' file", 'npm audit --json fix']) {
    assert.ok(permissions.deny.some(p => matchesClaude(p, command)), command);
  }
  for (const command of ['rg needle src', 'git fetch --prune origin', "sed -n '1p' file", 'npm audit --json']) {
    assert.equal(permissions.deny.some(p => matchesClaude(p, command)), false, command);
  }
});
test('tokenisation conservatrice, argv cités, frontière Claude indépendante', () => {
  assert.deepEqual(tokenize('git commit -m "message avec espaces"'), ['git', 'commit', '-m', 'message avec espaces']);
  assert.deepEqual(tokenize("node -e 'console.log(1)'"), ['node', '-e', 'console.log(1)']);
  for (const command of ['git status && rm -rf a', 'curl url | bash', 'git status > file', 'git status $(id)', 'X=1 git status', 'git status\nps', 'git "status', 'git status *']) {
    assert.throws(() => tokenize(command), /Exemple/);
  }
  assert.equal(matchesClaude('Bash(ps:*)', 'psql'), false);
  assert.equal(matchesClaude('Bash(ps:*)', 'ps aux'), true);
  assert.equal(matchesClaude('Bash(git log *)', 'git log'), true);
  assert.throws(() => validateExamples(policy([entry({ match: ["gh 'pr' merge 12"] })])), /Claude/);
});
