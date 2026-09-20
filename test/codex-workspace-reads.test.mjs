import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { decisionFor, generateCodex, generatePermissions, tokenize, validatePolicy, validateExamples } from '../lib/generate.mjs';
import { replayEvaluator, splitShell } from '../lib/replay.mjs';
import { readCore } from '../lib/system.mjs';
import { policy } from './helpers.mjs';

const core = readCore();
const prefixes = ['', 'rtk ', 'rtk proxy '];
const reads = [['sed', '-n'], ['cat'], ['ls']];
const rules = [...generateCodex(core).matchAll(/pattern=(\[[^\n]+\]),\n\s*decision="(allow|prompt|forbidden)"/gu)]
  .map(([, pattern, decision]) => ({ pattern: JSON.parse(pattern), decision }));
function generatedDecision(command) {
  const argv = tokenize(command);
  const decisions = rules.filter(rule => rule.pattern.every((token, i) => argv[i] === token)).map(rule => rule.decision);
  return ['forbidden', 'prompt', 'allow'].find(decision => decisions.includes(decision));
}

test('sed -n, cat et ls : trois entrées Codex read-only et leurs neuf règles générées', () => {
  for (const pattern of reads) {
    const source = core.entries.find(e => JSON.stringify(e.pattern) === JSON.stringify(pattern) && e.engines?.includes('codex'));
    assert.ok(source, pattern.join(' '));
    assert.deepEqual(source.engines, ['codex']);
    assert.equal(source.decision, 'allow');
    assert.equal(source.riskClass, 'read-only');
    assert.match(source.residualRisk, /sandbox/u);
    assert.match(source.residualRisk, /accepté par le user/u);
    if (pattern[0] === 'sed') {
      assert.match(source.residualRisk, /-i \/ --in-place/u);
      assert.match(source.residualRisk, /sort -o/u);
    } else assert.match(source.residualRisk, /\.env.*sandbox lit déjà/u);
    for (const prefix of [[], ['rtk'], ['rtk', 'proxy']]) {
      assert.deepEqual(rules.filter(rule => JSON.stringify(rule.pattern) === JSON.stringify([...prefix, ...pattern])), [{ pattern: [...prefix, ...pattern], decision: 'allow' }]);
    }
  }
  for (const prefix of prefixes) {
    for (const command of ["sed -n '1,20p' f", 'sed -n 1p -i f', 'sed -n --in-place=.bak 1p f', 'cat g', 'cat .env', 'ls -la d', 'ls -l .env']) {
      assert.equal(generatedDecision(prefix + command), 'allow', prefix + command);
    }
    // Exemples inertes : aucun de ces fichiers n'est lu ou créé par les tests.
    for (const command of ['sed 1p f', 'sed -i 1p f', 'sed -e 1p f', 'sed -nE 1p f', 'sed --quiet 1p f', "awk '{print $1}' f", 'uniq -c', 'find src -type f', 'git branch --list', 'git branch --list --no-list -D branch']) {
      assert.equal(generatedDecision(prefix + command), undefined, prefix + command);
    }
  }
});

test('session Codex : lsof, sed -n, cat et ls sont allow segment par segment, miroirs compris', () => {
  const evaluate = replayEvaluator([core], 'codex');
  for (const prefix of prefixes) {
    const parts = ['lsof -ti :3001', "sed -n '1,20p' f", 'cat g', 'ls d'].map(command => prefix + command);
    const command = parts.join(' && ');
    assert.deepEqual(splitShell(command), parts);
    for (const part of parts) assert.equal(generatedDecision(part), 'allow', part);
    assert.deepEqual(evaluate(command), { verdict: 'allow', unsupported: false });
    assert.deepEqual(evaluate(command + ' && git push'), { verdict: 'prompt', unsupported: false });
    assert.deepEqual(evaluate(command + ' && rm x'), { verdict: 'forbidden', unsupported: false });
    assert.deepEqual(evaluate(command + ' && unknown-command'), { verdict: 'aucune', unsupported: false });
  }
});

test('Claude : permissions sed/cat/ls identiques à main d868063, gardes et miroirs compris', () => {
  // Empreinte prise avant modification sur d8680634d69043f2db0fc10d2b086647e3d0736f.
  // Ne pas la régénérer depuis la politique de cette PR ; disponible aussi en CI superficielle.
  const scoped = Object.fromEntries(Object.entries(generatePermissions(core)).map(([key, values]) => [key,
    values.filter(value => /^Bash\((?:(?:rtk|proxy) )*(?:sed|cat|ls)(?:[: )])/u.test(value)),
  ]));
  assert.deepEqual(Object.fromEntries(Object.entries(scoped).map(([key, values]) => [key, values.length])), { allow: 11, ask: 33, deny: 30 });
  assert.equal(createHash('sha256').update(JSON.stringify(scoped)).digest('hex'), '1d7980fc747bcdf8aca0fb282ff156d5f58c3a10346755132f483f5cf1b02335');
  for (const prefix of prefixes) {
    for (const [command, decision] of [
      ["sed -n '1,20p' f", 'allow'], ['cat g', 'allow'], ['ls -la d', 'allow'],
      ['sed -n 1p docs/example-integration.md', 'allow'],
      ['sed -n -i 1p f', 'prompt'], ['sed -n 1p --in-place=.bak f', 'prompt'],
      ['sed -n 1p .env', 'prompt'], ['cat config/.env.local', 'forbidden'],
      ['ls -l .env', 'allow'],
    ]) assert.equal(decisionFor(core, prefix + command, 'claude'), decision, prefix + command);
  }
});

test('validation Codex sed : préfixe -n exact, moteur explicite et risque des deux options requis', () => {
  const sed = core.entries.find(e => e.pattern?.[0] === 'sed' && e.engines?.[0] === 'codex');
  assert.doesNotThrow(() => validateExamples({ version: 1, commandPrefixes: [['rtk'], ['rtk', 'proxy']], entries: [sed] }));
  for (const prefix of [[], ['rtk'], ['rtk', 'proxy']]) {
    for (const pattern of [['sed'], ['sed', '-i'], ['sed', '-nE'], ['sed', '-n', '-i'], ['sed', '-n', '1p']]) {
      assert.throws(() => validatePolicy(policy([{ ...sed, pattern: [...prefix, ...pattern] }])), /sed -n/u);
    }
  }
  for (const residualRisk of [undefined, 'risque local', 'option -i', 'option --in-place']) {
    const invalid = { ...sed };
    if (residualRisk === undefined) delete invalid.residualRisk;
    else invalid.residualRisk = residualRisk;
    assert.throws(() => validatePolicy(policy([invalid])), /residualRisk/u);
  }
});
