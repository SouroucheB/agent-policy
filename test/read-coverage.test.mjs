import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UNIQ_FORMS, generatePermissions, generateCodex,
  compileClaudePermission, decisionFor, validatePolicy, validateExamples,
} from '../lib/generate.mjs';
import { readCore } from '../lib/system.mjs';
import { policy } from './helpers.mjs';

const core = readCore();
const permissions = generatePermissions(core);
const groups = ['deny', 'ask', 'allow'].map(key => permissions[key].map(compileClaudePermission));
const verdict = command => ['forbidden', 'prompt', 'allow'][groups.findIndex(matchers => matchers.some(match => match(command)))];
const prefixes = ['', 'rtk ', 'rtk proxy '];

test('gardes : chemins contenant des sous-chaînes d’options sans faux refus, options réelles protégées', () => {
  const fixtures = [
    ['sed -n 1p tests/example-integration.test.ts', 'sed -n -i 1p file', 'prompt'],
    ['sed -n 1p docs/example-immutability.md', 'sed -i.bak -n 1p file', 'prompt'],
    ['sed -n 1p docs/name--in-place.md', 'sed -n --in-place=.bak 1p file', 'prompt'],
    ['rg needle src/name--pre.ts', 'rg needle --pre=program src', 'forbidden'],
    ['git diff -- docs/name--output.md', 'git diff --output=report', 'forbidden'],
    ['git diff -- docs/name--ext-diff.md', 'git diff --ext-diff', 'forbidden'],
    ['git log -- docs/name--upload-pack.md', 'git log --upload-pack=program', 'forbidden'],
    ['git show HEAD:docs/name-config.md', 'git show -c name=value', 'prompt'],
    ['cat docs/report.env.integration.md', 'cat config/.env.local', 'forbidden'],
    ['cp docs/example-tests.md docs/copy.md', 'cp -t/outside docs/file', 'prompt'],
  ];
  for (const prefix of prefixes) for (const [safe, unsafe, expected] of fixtures) {
    assert.equal(verdict(prefix + safe), 'allow', prefix + safe);
    assert.equal(verdict(prefix + unsafe), expected, prefix + unsafe);
  }
  for (const e of core.entries) for (const g of e.claudeDeny ?? []) {
    assert.doesNotMatch(g.pattern, / \*-(?:-|[A-Za-z])/u, g.pattern);
    assert.equal(g.pattern.endsWith(' *.env*'), false, g.pattern);
  }
});

test('gardes ambiguës : comparaison awk, préfixe --pre, noms relatifs en prompt', () => {
  for (const prefix of prefixes) for (const command of [
    "awk '$3 > 5 {print $1}' file", 'rg --pre-glob=*.txt needle src',
    'touch docs/name..backup',
  ]) assert.equal(verdict(prefix + command), 'prompt', prefix + command);
});

test('claudePattern : ciblage Claude et formes fermées uniq uniquement en allow', () => {
  const uniq = core.entries.find(e => e.claudePattern === 'uniq');
  assert.doesNotThrow(() => validateExamples(policy([uniq])));
  for (const engines of [undefined, ['codex'], ['claude', 'codex']]) assert.throws(() => validatePolicy(policy([{ ...uniq, engines }])));
  assert.throws(() => validatePolicy(policy([{ ...uniq, pattern: ['uniq'] }])), /claudePattern/);
  for (const claudePattern of ['git * status', 'uniq *', 'env', 'git -C * push', 'git -C * status']) {
    assert.throws(() => generatePermissions(policy([{ ...uniq, claudePattern }])));
  }
});

test('lectures réseau gh : allow conservés pour les deux moteurs et leurs miroirs', () => {
  for (const prefix of prefixes) for (const command of ['gh pr checks 7', 'gh run view 123']) {
    assert.equal(verdict(prefix + command), 'allow');
    assert.equal(decisionFor(core, prefix + command, 'codex'), 'allow');
  }
});

test('filtres et lectures Claude : couverture du point 3, env et sqlite3 en prompt', () => {
  const commands = [
    'jq . report.json', "awk '{print $1}' file", 'uniq -c', 'cut -d : -f 1 file',
    'tr a b', 'column -t file', 'diff before after', 'comm before after',
    'basename path', 'dirname path', 'realpath path', 'stat path', 'file path',
    'du -sh docs', 'df -h', 'gh run watch 1', 'gh run view 1', 'gh pr checks 1',
    'git merge-tree main feature', 'git worktree list', 'git stash list',
  ];
  for (const prefix of prefixes) {
    for (const command of commands) assert.equal(verdict(prefix + command), 'allow', prefix + command);
    for (const command of ['env', 'env program', 'sqlite3 .agent-tmp/test.db', 'sqlite3 outside.db']) assert.equal(verdict(prefix + command), 'prompt');
    for (const command of ['file -C', 'file --compile', 'file --brief -C', 'file path --compile']) assert.equal(verdict(prefix + command), 'forbidden');
    assert.equal(verdict(prefix + 'file docs/example-C.md'), 'allow');
  }
});

test('awk : toutes les variantes sensibles en ask, jamais en deny ; aucune règle Codex', () => {
  for (const prefix of prefixes) for (const command of [
    `awk 'BEGIN {print 1 > "file"}'`, `awk 'BEGIN {print 1 >> "file"}'`,
    `awk 'BEGIN {print 1 | "command"}'`, `awk 'BEGIN {system("command")}'`,
    `awk 'BEGIN {system ("command")}'`, `awk 'BEGIN {"command" | getline line}'`,
    'awk -f script.awk file', 'awk -v x=1 -fscript.awk file', 'awk -i inplace program file',
    `awk '@include "script.awk"'`, `awk '@load "module"'`, 'awk -l module program file',
    'awk --file=script.awk file', 'awk -E script.awk file',
  ]) {
    assert.equal(verdict(prefix + command), 'prompt', prefix + command);
    assert.equal(decisionFor(core, prefix + command, 'codex'), undefined);
  }
  const awk = core.entries.find(e => e.pattern?.[0] === 'awk');
  assert.equal(awk.claudeDeny, undefined);
  assert.deepEqual(awk.engines, ['claude']);
  assert.throws(() => validatePolicy(policy([{ ...awk, engines: ['codex'] }])), /awk/);
});

test('uniq : seuls les argv fermés sans fichier sont autorisés, aucune règle Codex élargie', () => {
  for (const prefix of prefixes) {
    for (const form of UNIQ_FORMS) {
      assert.equal(verdict(prefix + form), 'allow');
      for (const suffix of [' input', ' input output', ' - input', ' --help']) {
        assert.equal(verdict(prefix + form + suffix) ?? 'prompt', 'prompt', prefix + form + suffix);
      }
    }
    assert.equal(decisionFor(core, prefix + 'uniq'), undefined);
    assert.equal(decisionFor(core, prefix + 'uniq input output'), undefined);
  }
  assert.equal(generateCodex(core).includes('pattern=["uniq"]'), false);
});

test('Codex : huit filtres autorisés avec miroir, sed sans -n et awk toujours confinés', () => {
  for (const prefix of prefixes) {
    for (const command of ['rg foo src', 'grep foo file', 'head file', 'tail file', 'wc file', 'sort file', 'cut -f1 file', 'jq . file']) assert.equal(decisionFor(core, prefix + command), 'allow');
    for (const command of ['sed 1p file', "awk '{print $1}' file", 'cd docs']) assert.equal(decisionFor(core, prefix + command), undefined);
  }
  const rg = core.entries.find(e => e.pattern?.[0] === 'rg' && e.engines?.[0] === 'codex');
  assert.match(rg.residualRisk, /--pre/u);
});
