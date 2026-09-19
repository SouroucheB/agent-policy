import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assertClaudePostcondition, generateClaude, generatePermissions, matchesClaude, decisionFor, validatePolicy, buildProject } from '../lib/generate.mjs';
import { readCore, initProject, installCore } from '../lib/system.mjs';
import { temporary, put, cli, mixedClaudeSettings, policy, entry } from './helpers.mjs';
import { globalRefusals, projectRefusals } from './legacy-refusals.mjs';

const core = readCore();
const protectedBy = (permissions, command) => [...permissions.deny, ...permissions.ask].some(rule => rule.startsWith('Bash(') && matchesClaude(rule, command, { shellText: true }));

test('install : 31 refus globaux conservés, 2 wrappers pris en charge par une couche simulée', t => {
  assert.equal(globalRefusals.length, 31);
  assert.equal(projectRefusals.length, 2);
  const target = temporary(t);
  const project = temporary(t);
  initProject(project);
  put(project, 'agent-policy/policy.json', policy(projectRefusals.map(([pattern, command]) => entry({
    pattern: pattern.slice(0, -2).split(' '), decision: 'forbidden', riskClass: 'arbitrary-execution', match: [command], notMatch: ['git status'],
  }))));
  buildProject(project);
  const old = mixedClaudeSettings();
  old.permissions.deny.push(...[...globalRefusals, ...projectRefusals].map(([pattern]) => `Bash(${pattern})`));
  put(target, '.claude/settings.json', old);
  const result = cli(target, ['install', '--target-root', target], { input: `INSTALLER ${target}\n` });
  assert.equal(result.status, 0, result.stderr);
  const installed = JSON.parse(fs.readFileSync(path.join(target, '.claude/settings.json'))).permissions;
  const local = JSON.parse(fs.readFileSync(path.join(project, '.claude/settings.json'))).permissions;
  for (const [pattern, command] of globalRefusals) {
    assert.equal(matchesClaude(`Bash(${pattern})`, command, { shellText: true }), true, pattern);
    assert.equal(protectedBy(installed, command), true, pattern);
  }
  for (const [, command] of projectRefusals) {
    assert.equal(protectedBy(installed, command), false, 'le wrapper ne doit pas être dans le socle');
    assert.equal(protectedBy(local, command), true, command);
  }
  assert.equal(cli(target, ['install', '--target-root', target]).status, 0);
});

test('limites Codex : garde seule sans préfixe ni autorisation fictive', () => {
  for (const command of ['find . -delete', 'perl -pi.bak file', '/bin/command', 'head-custom file']) {
    assert.equal(decisionFor(core, command), undefined, command);
    assert.equal(protectedBy(generatePermissions(core), command), true, command);
  }
  for (const rule of core.entries.filter(value => value.pattern === undefined)) {
    assert.equal(rule.decision, 'forbidden');
    assert.ok(rule.residualRisk.length > 0);
    assert.throws(() => validatePolicy(policy([{ ...rule, decision: 'allow' }])));
    const { residualRisk, ...missing } = rule;
    assert.throws(() => validatePolicy(policy([missing])));
  }
});

test('post-condition : refuser les changements de valeur, ordre ou liste hors Bash', () => {
  const before = JSON.stringify(mixedClaudeSettings());
  const generated = generatePermissions(core);
  const rendered = generateClaude(core, before);
  assert.doesNotThrow(() => assertClaudePostcondition(before, rendered, generated));
  for (const mutate of [
    s => { s.permissions.allow.push('Read(unexpected/**)'); },
    s => { s.permissions.deny.reverse(); },
    s => { s.permissions.defaultMode = 'plan'; },
    s => { s.permissions.additionalDirectories.reverse(); },
    s => { s.hooks = {}; },
    s => { const old = s.permissions; s.permissions = { additionalDirectories: old.additionalDirectories, ...old }; },
    s => { s.permissions.ask.push('Bash(unexpected:*)'); },
  ]) {
    const changed = JSON.parse(rendered);
    mutate(changed);
    assert.throws(() => assertClaudePostcondition(before, JSON.stringify(changed), generated), /Post-condition Claude/);
  }
});

test('post-condition : une édition défectueuse fait échouer build et install avant toute écriture', async t => {
  const originalStringify = JSON.stringify;
  let fault = 'non-Bash';
  t.mock.method(JSON, 'stringify', (value, ...args) => {
    const text = originalStringify(value, ...args);
    if (typeof value !== 'string' || value.startsWith('Bash(') === false) return text;
    if (fault === 'non-Bash') return text + ', "Read(unexpected/**)"';
    return text + '], "defaultMode":"plan", "ask":[' + text;
  });
  for (const kind of ['non-Bash', 'clé']) {
    fault = kind;
    const root = temporary(t);
    initProject(root);
    put(root, 'agent-policy/policy.json', policy([entry()]));
    const settings = '{"permissions":{"defaultMode":"default","ask":["Bash(old:*)"]}}';
    put(root, '.claude/settings.json', settings);
    put(root, '.codex/rules/project.rules', '# unchanged\n');
    assert.throws(() => buildProject(root), /Post-condition Claude/);
    assert.equal(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'), settings);
    assert.equal(fs.readFileSync(path.join(root, '.codex/rules/project.rules'), 'utf8'), '# unchanged\n');
    await assert.rejects(installCore({ targetRoot: root }), /Post-condition Claude/);
    assert.equal(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'), settings);
    assert.equal(fs.existsSync(path.join(root, '.agent-policy')), false);
    assert.equal(fs.existsSync(path.join(root, '.codex/rules/00-core.rules')), false);
  }
});
