import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  GIT_OPTION_PREFIXES, optionGuardPatterns,
  generatePermissions, compileClaudePermission, decisionFor,
} from '../lib/generate.mjs';
import { readCore } from '../lib/system.mjs';

const core = readCore();
const permissions = generatePermissions(core);
const groups = ['deny', 'ask', 'allow'].map(key => permissions[key].map(compileClaudePermission));
const verdict = command => ['forbidden', 'prompt', 'allow'][groups.findIndex(matchers => matchers.some(match => match(command)))];
const mirrors = ['', 'rtk ', 'rtk proxy '];
const optionLists = JSON.parse(fs.readFileSync(new URL('./fixtures/git-long-options.json', import.meta.url), 'utf8'));

test('table Git : chaque préfixe est le plus court unique dans la liste versionnée du parseur', () => {
  assert.equal(optionLists.gitVersion, 'git version 2.50.1 (Apple Git-155)');
  for (const row of GIT_OPTION_PREFIXES) {
    assert.ok(row.reason.length > 0);
    if (!row.optionSet) {
      assert.equal(row.prefix, null);
      assert.ok(['--exec-path', '--config-env'].includes(row.option));
      continue;
    }
    const options = optionLists.options[row.optionSet];
    assert.ok(options.includes(row.option), row.option);
    const shortened = Array.from({ length: row.option.length - 3 }, (_, i) => row.option.slice(0, i + 3));
    const shortest = shortened.find(prefix => options.filter(option => option.startsWith(prefix)).length === 1) ?? null;
    assert.equal(row.prefix, shortest, row.option);
    if (!shortest) {
      assert.equal(row.option, '--output');
      for (const prefix of shortened) for (const suffix of ['new', 'old', 'context']) {
        assert.ok(`--output-indicator-${suffix}`.startsWith(prefix));
      }
    }
  }
});

test('inventaire : toutes les options longues Git gardées sont traitées par la table', () => {
  const recorded = new Set(GIT_OPTION_PREFIXES.flatMap(row => [row.option, row.prefix].filter(Boolean)));
  for (const entry of core.entries) for (const guard of [...(entry.claudeAsk ?? []), ...(entry.claudeDeny ?? [])]) {
    if (!guard.pattern.startsWith('git ')) continue;
    const root = entry.pattern?.join(' ');
    const suffix = root && guard.pattern.startsWith(`${root} `) ? guard.pattern.slice(root.length) : guard.pattern;
    for (const [, option] of suffix.matchAll(/ (--[a-z][a-z-]*)(?=[=* ]|$)/gu)) {
      assert.ok(recorded.has(option), `Option non inventoriée : ${option}`);
    }
  }
});

test('abréviations Git sans -C : gardes conservées ; avec -C : aucune règle', () => {
  for (const row of GIT_OPTION_PREFIXES.filter(row => row.prefix)) {
    for (const command of row.commands) for (const mirror of mirrors) for (const middle of ['', '-C /x ']) {
      const fullDecision = row.optionSet === 'branch' || command === 'fetch' ? 'prompt' : 'forbidden';
      if (!middle) {
        assert.equal(verdict(`${mirror}git ${middle}${command} docs/name${row.prefix}.md`), 'allow');
      }
      for (let length = row.prefix.length; length <= row.option.length; length += 1) {
        const abbreviation = row.option.slice(0, length);
        const expected = middle ? undefined : abbreviation === row.option ? fullDecision : 'prompt';
        for (const before of ['', 'argument ']) for (const after of ['', '=program', ' program']) {
          const text = `${mirror}git ${middle}${command} ${before}${abbreviation}${after}`;
          assert.equal(verdict(text), expected, text);
        }
      }
    }
  }
});

test('les cinq exemples signalés sont prompt sans -C, sans règle avec -C, miroirs compris', () => {
  for (const mirror of mirrors) for (const middle of ['', '-C /x ']) for (const suffix of [
    'fetch --upl=/tmp/evil /tmp/repo', 'grep --op=vim TODO',
    'diff --ext', 'log --ext -p', 'show --ext',
  ]) {
    const text = `${mirror}git ${middle}${suffix}`;
    assert.equal(verdict(text), middle ? undefined : 'prompt', text);
    assert.equal(decisionFor(core, text, 'claude'), middle ? undefined : 'prompt');
  }
});

test('les options voisines légitimes restent allow, même après des arguments et sous RTK', () => {
  for (const mirror of mirrors) for (const middle of ['', '-C /x ']) for (const before of ['', 'argument ']) {
    for (const [command, options] of [
      ['fetch', ['--update-head-ok', '--update-shallow', '--unshallow', '--update-h']],
      ['grep', ['--only-matching', '--on']],
      ['diff', ['--exit-code', '--exi', '--output-indicator-new=X', '--output-indicator-old=X', '--output-indicator-context=X']],
      ['log', ['--exit-code', '--output-indicator-new=X']],
      ['show', ['--exit-code', '--output-indicator-new=X']],
    ]) for (const option of options) {
      const text = `${mirror}git ${middle}${command} ${before}${option}`;
      assert.equal(verdict(text), middle ? undefined : 'allow', text);
    }
  }
  for (const mirror of mirrors) for (const option of ['--format=format', '--column', '--contains', '--merged', '--sort=refname']) {
    assert.equal(verdict(`${mirror}git branch ${option}`), 'allow');
  }
});

test('--output est borné : aucun indicateur capturé, aucune décision complète affaiblie', () => {
  for (const key of ['allow', 'ask', 'deny']) {
    assert.equal(permissions[key].some(permission => / --output\*\)$/u.test(permission)), false);
  }
  for (const mirror of mirrors) for (const middle of ['', '-C /x ']) for (const before of ['', 'argument ']) {
    for (const [command, expected] of [['diff', 'forbidden'], ['fetch', 'prompt'], ['commit', 'prompt']]) {
      for (const suffix of ['', '=/tmp/x', ' /tmp/x']) {
        const text = `${mirror}git ${middle}${command} ${before}--output${suffix}`;
        assert.equal(verdict(text), middle ? undefined : expected, text);
      }
      assert.equal(verdict(`${mirror}git ${middle}${command} ${before}--output-indicator-new=X`), middle ? undefined : 'allow');
    }
  }
});

test('une garde d’abréviation Git sans -C ne peut manquer ni devenir deny', () => {
  for (const row of GIT_OPTION_PREFIXES.filter(row => row.prefix)) for (const command of row.commands) {
    const original = core.entries.find(entry => entry.pattern?.join(' ') === `git ${command}` && entry.engines?.includes('claude') !== false);
    for (const pattern of optionGuardPatterns(`git ${command}`, row.prefix)) {
      const mutant = structuredClone(core);
      const entry = mutant.entries[core.entries.indexOf(original)];
      const guard = entry.claudeAsk.find(candidate => candidate.pattern === pattern);
      assert.ok(guard, pattern);
      entry.claudeAsk = entry.claudeAsk.filter(candidate => candidate !== guard);
      assert.throws(() => generatePermissions(mutant), /garde Claude obligatoire/, pattern);
      entry.claudeAsk.push(guard);
      (entry.claudeDeny ??= []).push(guard);
      assert.throws(() => generatePermissions(mutant), /jamais deny/, pattern);
    }
  }
});

test('éditeur/signature de confiance : --edit et --gpg-sign ne reçoivent aucune nouvelle garde', () => {
  for (const mirror of mirrors) for (const middle of ['', '-C /x ']) {
    for (const [command, option] of [['add', '--edit'], ['commit', '--edit'], ['commit', '--gpg-sign=key']]) {
      assert.equal(verdict(`${mirror}git ${middle}${command} ${option}`), middle ? undefined : 'allow');
    }
  }
});
