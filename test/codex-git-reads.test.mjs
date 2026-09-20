import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionFor, expandEntries, generateCodex } from '../lib/generate.mjs';
import { replayEvaluator, splitShell } from '../lib/replay.mjs';
import { readCore } from '../lib/system.mjs';

const core = readCore();
const prefixes = ['', 'rtk ', 'rtk proxy '];

test('lectures Git Codex : neuf préfixes explicites, risques acceptés et miroirs', () => {
  const reads = [
    ['git status', '--short'], ['git diff', '--check'], ['git log', '--oneline -5'],
    ['git show', 'HEAD:README.md'], ['git rev-parse', '--short HEAD'], ['git ls-files', '--cached'],
    ['git grep', 'needle'], ['git worktree list', '--porcelain'], ['git merge-tree', 'HEAD HEAD'],
  ];
  const generated = generateCodex(core);
  for (const [command, args] of reads) {
    const rule = core.entries.find(e => e.pattern?.join(' ') === command && e.engines?.includes('codex'));
    assert.ok(rule, command);
    assert.equal(rule.decision, 'allow');
    assert.equal(rule.riskClass, command === 'git merge-tree' ? 'local-reversible' : 'read-only');
    assert.match(rule.residualRisk, /--ext-diff/u);
    assert.match(rule.residualRisk, /--output/u);
    for (const prefix of prefixes) {
      assert.ok(generated.includes(`pattern=${JSON.stringify((prefix + command).split(' '))},\n    decision="allow"`));
      assert.equal(decisionFor(core, `${prefix}${command} ${args}`), 'allow');
    }
  }
  const grep = core.entries.find(e => e.pattern?.join(' ') === 'git grep' && e.engines?.includes('codex'));
  assert.match(grep.residualRisk, /-O \/ --open-files-in-pager/u);
  assert.match(grep.residualRisk, /programme.*sans configuration préalable/u);
  for (const prefix of prefixes) {
    for (const command of ['git diff --ext-diff', 'git diff --output=report', 'git log HEAD --output=report', 'git show HEAD --output=report', 'git grep -Oprogram needle', 'git grep needle --open-files-in-pager=program']) {
      assert.equal(decisionFor(core, prefix + command), 'allow');
      assert.equal(decisionFor(core, prefix + command, 'claude'), 'forbidden');
    }
  }
});

test('branch --list reste sans règle Codex, même avec --no-list et une mutation', () => {
  for (const prefix of prefixes) {
    for (const command of ['git branch --list', 'git branch --list --no-list -D feature', 'git branch -D feature', 'sed 1p file', "awk '{print $1}' file", 'uniq -c']) {
      assert.equal(decisionFor(core, prefix + command), undefined, prefix + command);
    }
    assert.equal(decisionFor(core, prefix + 'git branch --list --no-list -D feature', 'claude'), 'prompt');
  }
  for (const rule of expandEntries(core).filter(e => (e.engines ?? ['codex', 'claude']).includes('codex'))) {
    const argv = rule.pattern?.filter(token => !['rtk', 'proxy'].includes(token));
    assert.ok(!argv || !['awk', 'uniq'].includes(argv[0]), JSON.stringify(argv));
    if (argv?.[0] === 'sed') assert.deepEqual(argv, ['sed', '-n']);
    assert.notEqual(argv?.slice(0, 2).join(' '), 'git branch');
  }
});

test('session composée Codex : rg, git diff et lsof sont allow segment par segment', () => {
  const command = 'rg --files src && git diff --check && lsof -ti :3001';
  const segments = ['rg --files src', 'git diff --check', 'lsof -ti :3001'];
  assert.deepEqual(splitShell(command), segments);
  for (const segment of segments) assert.equal(decisionFor(core, segment), 'allow');
  const evaluate = replayEvaluator([core], 'codex');
  assert.deepEqual(evaluate(command), { verdict: 'allow', unsupported: false });
  assert.deepEqual(evaluate('rg --files src 2>/dev/null && git diff --check 2>&1 && lsof -ti :3001 >/dev/null'), { verdict: 'allow', unsupported: false });
  assert.deepEqual(evaluate(command + ' && git push'), { verdict: 'prompt', unsupported: false });
  assert.deepEqual(evaluate(command + ' && rm x'), { verdict: 'forbidden', unsupported: false });
});
