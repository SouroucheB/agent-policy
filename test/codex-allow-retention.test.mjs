import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { generateCodex } from '../lib/generate.mjs';
import { readCore } from '../lib/system.mjs';
import { ROOT } from './helpers.mjs';

const baseline = JSON.parse(fs.readFileSync(new URL('./fixtures/codex-allow-main.json', import.meta.url), 'utf8'));
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
// Toute exception doit nommer son argv exact et une justification reprise dans
// le README. Ne jamais actualiser la référence depuis une PR non fusionnée.
const documentedRemovals = [];
const identity = pattern => JSON.stringify(pattern);

function sourceAllow(source) {
  const prefixes = [[], ...(source.commandPrefixes ?? [['rtk'], ['rtk', 'proxy']])];
  return new Set(source.entries
    .filter(entry => entry.pattern && entry.decision === 'allow' && (entry.engines ?? ['codex', 'claude']).includes('codex'))
    .flatMap(entry => prefixes.map(prefix => identity([...prefix, ...entry.pattern]))));
}
function sourceAt(ref) {
  // Lecture Git locale uniquement. Les archives et checkouts superficiels ont
  // toujours la référence versionnée ; aucun fetch n'est lancé par les tests.
  const result = spawnSync('git', ['show', `${ref}:core-policy.json`], { cwd: ROOT, encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return result.status === 0 ? JSON.parse(result.stdout) : null;
}
function generatedAllow(source) {
  const rules = generateCodex(source);
  const parsed = [...rules.matchAll(/pattern=(\[[^\n]+\]),\n\s*decision="(allow|prompt|forbidden)"/gu)];
  assert.equal(parsed.length, rules.split('prefix_rule(').length - 1, 'toutes les règles générées sont lues');
  return new Set(parsed.filter(([, , decision]) => decision === 'allow').map(([, pattern]) => identity(JSON.parse(pattern))));
}
function assertRetained(before, after, removals = documentedRemovals, documentation = readme) {
  const exceptions = new Set();
  for (const removal of removals) {
    assert.ok(Array.isArray(removal.pattern) && removal.pattern.length > 0, 'argv de retrait requis');
    assert.ok(typeof removal.reason === 'string' && removal.reason.trim().length > 0 && documentation.includes(removal.reason), 'justification de retrait requise dans le README');
    const key = identity(removal.pattern);
    assert.ok(before.has(key) && !after.has(key), `exception sans retrait correspondant : ${key}`);
    assert.ok(!exceptions.has(key), `exception dupliquée : ${key}`);
    exceptions.add(key);
  }
  const missing = [...before].filter(key => !after.has(key) && !exceptions.has(key));
  assert.deepEqual(missing, [], `Retraits d'allow Codex non documentés : ${missing.join(', ')}`);
}

test('tous les allow Codex de main sont conservés, sauf retraits nommés et documentés', () => {
  assert.equal(baseline.ref, 'main');
  assert.match(baseline.commit, /^[a-f0-9]{40}$/u);
  const reference = new Set(baseline.allow.map(identity));
  assert.equal(reference.size, 120);
  const pinned = sourceAt(baseline.commit);
  if (pinned) assert.deepEqual(reference, sourceAllow(pinned), 'la référence correspond exactement au commit main cité');
  const main = sourceAt('origin/main') ?? sourceAt('main');
  if (main) for (const pattern of sourceAllow(main)) reference.add(pattern);
  assertRetained(reference, generatedAllow(readCore()));
});

test('le contrôle détecte les deux régressions engines et chacun de leurs miroirs', () => {
  const before = new Set(baseline.allow.map(identity));
  const core = readCore();
  for (const command of ['gh pr checks', 'gh run view']) {
    const mutant = structuredClone(core);
    mutant.entries.find(entry => entry.pattern?.join(' ') === command).engines = ['claude'];
    assert.throws(() => assertRetained(before, generatedAllow(mutant)), /Retraits d'allow Codex non documentés/u);
    for (const prefix of [[], ['rtk'], ['rtk', 'proxy']]) {
      const pattern = [...prefix, ...command.split(' ')];
      const after = generatedAllow(core);
      after.delete(identity(pattern));
      assert.throws(() => assertRetained(before, after), /Retraits d'allow Codex non documentés/u);
      assert.throws(() => assertRetained(before, after, [{ pattern, reason: '' }]), /justification/u);
      assert.throws(() => assertRetained(before, after, [{ pattern, reason: 'absent de la documentation' }], ''), /justification/u);
      const reason = 'Retrait explicite simulé pour vérifier le contrat de documentation.';
      assert.doesNotThrow(() => assertRetained(before, after, [{ pattern, reason }], reason));
    }
  }
});
