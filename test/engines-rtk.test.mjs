import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  validatePolicy, validateExamples, expandEntries, generateCodex, generatePermissions, generateClaude,
  decisionFor, matchesClaude, checkNativeCodex, buildProject, checkProject, PROJECT_FILES,
} from '../lib/generate.mjs';
import { readCore, initProject } from '../lib/system.mjs';
import { policy, entry, temporary, put, cli, mixedClaudeSettings, withoutBash, ROOT } from './helpers.mjs';
import { globalRefusals, projectRefusals } from './legacy-refusals.mjs';

const core = readCore();
const prefixes = ['', 'rtk ', 'rtk proxy '];
const permissions = generatePermissions(core);
function claudeDecision(command, settings = permissions) {
  for (const [key, decision] of [['deny', 'forbidden'], ['ask', 'prompt'], ['allow', 'allow']]) {
    if (settings[key].some(permission => permission.startsWith('Bash(') && matchesClaude(permission, command, { shellText: true }))) return decision;
  }
}
const mirrored = entries => ({ version: 1, commandPrefixes: [['rtk'], ['rtk', 'proxy']], entries });

test('engines : sous-ensemble non vide, défaut deux moteurs et doublons limités au moteur', () => {
  for (const engines of [[], ['other'], ['codex', 'codex'], ['claude', null], 'claude', null]) {
    assert.throws(() => validatePolicy(policy([entry({ engines })])), /engines/);
  }
  const split = policy([entry({ engines: ['codex'] }), entry({ engines: ['claude'], decision: 'forbidden' })]);
  assert.doesNotThrow(() => validateExamples(split));
  assert.equal(decisionFor(split, 'gh pr merge 1'), 'prompt');
  assert.equal(decisionFor(split, 'gh pr merge 1', 'claude'), 'forbidden');
  assert.throws(() => validatePolicy(policy([entry(), entry({ engines: ['claude'] })])), /dupliqué/);
  assert.deepEqual(generatePermissions(policy([entry()])), generatePermissions(policy([entry({ engines: ['codex', 'claude'] })])));
  assert.equal(generateCodex(policy([entry()])), generateCodex(policy([entry({ engines: ['claude', 'codex'] })])));
});

test('chaque moteur reçoit uniquement ses entrées et celles sans engines, miroirs compris', () => {
  const source = mirrored([
    entry({ engines: ['claude'] }),
    entry({ engines: ['codex'], pattern: ['git', 'push'], match: ['git push origin main'], notMatch: ['git status'] }),
    entry({ pattern: ['rm'], decision: 'forbidden', match: ['rm file'], notMatch: ['git status'] }),
  ]);
  const codex = generateCodex(source);
  const claude = generatePermissions(source);
  for (const prefix of prefixes) {
    const argv = (prefix + 'gh pr merge').split(' ');
    assert.equal(codex.includes(`pattern=${JSON.stringify(argv)}`), false);
    assert.ok(claude.ask.includes(`Bash(${prefix}gh pr merge:*)`));
    assert.ok(codex.includes(`pattern=${JSON.stringify((prefix + 'git push').split(' '))}`));
    assert.equal(JSON.stringify(claude).includes(`${prefix}git push`), false);
    assert.equal(decisionFor(source, prefix + 'rm file'), 'forbidden');
    assert.equal(claudeDecision(prefix + 'rm file', claude), 'forbidden');
  }
});

test('les exemples sont contrôlés uniquement par les moteurs cibles, y compris les gardes', () => {
  const codexOnly = entry({ engines: ['codex'], match: ["gh 'pr' merge 1"], claudeDeny: [{ pattern: 'gh pr merge *', match: ['not-a-match'], notMatch: ['gh pr merge 1'] }] });
  assert.doesNotThrow(() => validateExamples(mirrored([codexOnly])));
  assert.deepEqual(generatePermissions(mirrored([codexOnly])), { allow: [], ask: [], deny: [] });
  const claudeOnly = entry({ engines: ['claude'], notMatch: ["gh 'pr' merge 1"] });
  assert.doesNotThrow(() => validateExamples(mirrored([claudeOnly])));
  assert.equal(generateCodex(mirrored([claudeOnly])).includes('prefix_rule('), false);
  assert.throws(() => validateExamples(mirrored([{ ...codexOnly, engines: ['codex', 'claude'] }])), /Claude/);
  assert.throws(() => validateExamples(mirrored([{ ...claudeOnly, engines: ['codex', 'claude'] }])), /Codex/);
});

test('commandPrefixes : tokens littéraux uniques, expansion unique et exemples dérivés', () => {
  for (const commandPrefixes of [null, 'rtk', [[]], [['rtk *']], [['rtk', '*']], [['rtk'], ['rtk']], [[null]]]) {
    assert.throws(() => validatePolicy({ ...policy([entry()]), commandPrefixes }), /commandPrefixes/);
  }
  assert.doesNotThrow(() => validatePolicy({ ...policy(), commandPrefixes: [] }));
  const source = mirrored([entry()]);
  const snapshot = JSON.stringify(source);
  const expanded = expandEntries(source);
  assert.equal(expanded.length, 3);
  for (let index = 0; index < prefixes.length; index += 1) {
    assert.deepEqual(expanded[index].pattern, (prefixes[index] + 'gh pr merge').split(' '));
    assert.deepEqual(expanded[index].match, [prefixes[index] + 'gh pr merge 12 --squash']);
    assert.deepEqual(expanded[index].notMatch, [prefixes[index] + 'gh pr view 12']);
  }
  assert.equal(validateExamples(source), 6);
  assert.equal(JSON.stringify(source), snapshot);
  const codex = generateCodex(source);
  assert.ok(codex.includes('not_match=["rtk proxy gh pr view 12"]'));
  assert.equal(codex.includes('pattern=["rtk"]'), false);
  assert.equal(codex.includes('pattern=["rtk","proxy"]'), false);
});

test('miroir RTK : décisions allow, prompt et forbidden préservées dans les deux moteurs', () => {
  for (const prefix of prefixes) {
    for (const [command, decision] of [['git status', 'allow'], ['git push origin main', 'prompt'], ['rm -rf directory', 'forbidden'], ['npm audit fix --force', 'prompt']]) {
      assert.equal(decisionFor(core, prefix + command), decision, prefix + command);
      assert.equal(claudeDecision(prefix + command), decision, prefix + command);
    }
  }
  for (const command of ['rtk', 'rtk proxy', 'rtk run code', 'rtk proxy unknown-command']) {
    assert.equal(decisionFor(core, command), undefined, command);
    assert.equal(claudeDecision(command), undefined, command);
  }
  for (const pattern of [['rtk'], ['rtk', 'proxy'], ['rtk', 'run'], ['rtk', 'summary'], ['rtk', 'bash', '-c'], ['rtk', 'proxy', 'node', '-e'], ['rtk', 'proxy', 'rg']]) {
    assert.throws(() => validatePolicy(policy([entry({ pattern, decision: 'allow', riskClass: 'read-only' })])));
  }
  const unsafePrefix = { ...policy([entry({ pattern: ['git', 'status'], decision: 'allow', riskClass: 'read-only', match: ['git status'], notMatch: ['git push'] })]), commandPrefixes: [['bash', '-c']] };
  assert.throws(() => generateCodex(unsafePrefix), /interpréteur libre/);
});

test('les commandes RTK propres sont autorisées, avec gardes grep/read/diff et sans doublons', () => {
  for (const command of ['rtk grep needle src', 'rtk read README.md', 'rtk ls src', 'rtk diff before.txt after.txt', 'rtk gain', 'rtk discover', 'rtk session']) {
    assert.equal(decisionFor(core, command), 'allow', command);
    assert.equal(claudeDecision(command), 'allow', command);
  }
  for (const prefix of prefixes) {
    for (const command of ['rtk read .env', 'rtk grep needle config/.env.local', 'rtk diff old.txt .env', 'rtk grep needle --pre=command']) assert.equal(claudeDecision(prefix + command), 'forbidden', prefix + command);
    assert.equal(decisionFor(core, prefix + 'rtk grep --pre command needle'), 'forbidden');
  }
  for (const list of Object.values(permissions)) assert.equal(new Set(list).size, list.length);
  // Collision entre un préfixe déclaré et une entrée explicite : même décision, exemples réunis.
  const overlap = mirrored([
    entry({ pattern: ['git', 'push'], match: ['git push origin main'], notMatch: ['git status'] }),
    entry({ pattern: ['rtk', 'git', 'push'], match: ['rtk git push upstream feature'], notMatch: ['rtk git status'] }),
  ]);
  const rules = generateCodex(overlap);
  assert.equal(rules.split('pattern=["rtk","git","push"]').length - 1, 1);
  assert.ok(rules.includes('match=["rtk git push origin main","rtk git push upstream feature"]'));
});

test('lectures Claude autorisées : moteurs séparés et gardes .env/--pre prioritaires sous RTK', () => {
  const commands = ['ls src', 'cat README.md', 'head -n 5 README.md', 'tail -n 5 README.md', 'grep needle README.md', 'wc -l README.md', 'sort names.txt', 'rg needle src', 'sed -n 1p README.md', 'echo message', 'printf message', 'pgrep node', 'xxd README.md', 'dig example.invalid', 'pbpaste', 'which node'];
  for (const prefix of prefixes) {
    for (const command of commands) assert.equal(claudeDecision(prefix + command), 'allow', prefix + command);
    for (const command of ['cat', 'head', 'tail', 'grep needle', 'rg needle', 'sed -n 1p']) {
      for (const file of ['.env', '.env.local', './.envrc', 'config/.env.production', '"config/.env.local"', "'config/.env'", '.env.example']) {
        assert.equal(claudeDecision(`${prefix}${command} ${file}`), 'forbidden', `${prefix}${command} ${file}`);
      }
    }
    for (const command of ['rg --pre command needle', 'rg needle --pre=command', 'sed -n -i 1p file', 'sed -n --in-place 1p file']) assert.equal(claudeDecision(prefix + command), 'forbidden');
    assert.equal(decisionFor(core, prefix + 'rg needle src'), 'prompt');
    assert.equal(decisionFor(core, prefix + 'sed -n 1p file'), 'prompt');
    assert.equal(decisionFor(core, prefix + 'cat README.md'), undefined);
  }
  const codex = generateCodex(core);
  for (const rule of core.entries.filter(entry => entry.engines?.length === 1 && entry.engines[0] === 'claude')) {
    if (['rg', 'sed', 'grep', 'ls'].includes(rule.pattern[0])) continue; // règles Codex distinctes ou commande RTK propre
    for (const prefix of [[], ['rtk'], ['rtk', 'proxy']]) assert.equal(codex.includes(`pattern=${JSON.stringify([...prefix, ...rule.pattern])},`), false);
  }
});

test('validateAllow exige les gardes exactes, réserve rg/sed à Claude et refuse un sed générique', () => {
  for (const name of ['cat', 'head', 'tail', 'grep', 'rg', 'sed']) {
    const source = core.entries.find(entry => entry.pattern?.[0] === name && entry.decision === 'allow');
    for (const guard of source.claudeDeny.filter(guard => name !== 'grep' || guard.pattern.includes('.env'))) {
      const incomplete = { ...source, claudeDeny: source.claudeDeny.filter(candidate => candidate !== guard) };
      assert.throws(() => validatePolicy(policy([incomplete])), /garde Claude obligatoire/);
    }
  }
  for (const name of ['rg', 'sed']) {
    const source = core.entries.find(entry => entry.pattern?.[0] === name && entry.decision === 'allow');
    for (const engines of [undefined, ['codex'], ['claude', 'codex']]) {
      const broader = structuredClone(source);
      if (engines === undefined) delete broader.engines;
      else broader.engines = engines;
      assert.throws(() => validatePolicy(policy([broader])), /rg\/sed/);
    }
    if (name === 'sed') assert.throws(() => validatePolicy(policy([{ ...source, pattern: ['sed'] }])), /sed -n/);
  }
});

test('lsof : trois préfixes de lecture autorisés sans prompt général qui les masque', () => {
  for (const prefix of prefixes) {
    for (const flag of ['-i', '-ti', '-nP']) {
      const command = `${prefix}lsof ${flag} :3000`;
      assert.equal(decisionFor(core, command), 'allow');
      assert.equal(claudeDecision(command), 'allow');
      assert.equal(claudeDecision(`${command} -Db/cache`), 'forbidden');
    }
    assert.equal(decisionFor(core, prefix + 'lsof -D'), 'prompt');
    assert.equal(decisionFor(core, prefix + 'lsof -i:3000'), undefined);
    assert.equal(claudeDecision(prefix + 'lsof -Db/cache'), 'forbidden');
  }
});

test('31 refus historiques et 2 wrappers : gardes directes, rtk et rtk proxy préservées après install simulé', t => {
  const root = temporary(t);
  const before = mixedClaudeSettings();
  before.permissions.deny.push(...[...globalRefusals, ...projectRefusals].map(([pattern]) => `Bash(${pattern})`));
  put(root, '.claude/settings.json', before);
  const result = cli(root, ['install', '--target-root', root], { input: `INSTALLER ${root}\n` });
  assert.equal(result.status, 0, result.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'));
  assert.equal(withoutBash(after), withoutBash(before));
  const project = generatePermissions(mirrored(projectRefusals.map(([pattern, command]) => entry({ pattern: pattern.slice(0, -2).split(' '), decision: 'forbidden', match: [command], notMatch: ['git status'] }))));
  for (const prefix of prefixes) {
    for (const [, command] of globalRefusals) assert.equal(claudeDecision(prefix + command, after.permissions), 'forbidden', prefix + command);
    for (const [, command] of projectRefusals) {
      assert.equal(claudeDecision(prefix + command, after.permissions), undefined);
      assert.equal(claudeDecision(prefix + command, project), 'forbidden');
    }
  }
  assert.equal(cli(root, ['install', '--target-root', root]).status, 0);
});

test('gardes sans argv : le miroir conserve les limites Codex sans inventer de règle', () => {
  for (const prefix of prefixes) {
    for (const command of ['find . -delete', 'perl -pi.bak file', '/bin/program argument', 'head-custom file', 'tail-custom file']) {
      assert.equal(decisionFor(core, prefix + command), undefined);
      assert.equal(claudeDecision(prefix + command), 'forbidden');
    }
  }
  for (const rule of core.entries.filter(entry => entry.pattern === undefined)) {
    const source = mirrored([rule]);
    assert.equal(generateCodex(source).includes('prefix_rule('), false);
    assert.equal(generatePermissions(source).deny.length, rule.claudeDeny.length * 3);
  }
});

test('build/check et la copie autonome appliquent engines, miroirs et post-condition hors ligne', t => {
  const root = temporary(t);
  initProject(root);
  put(root, PROJECT_FILES.policy, core);
  const before = mixedClaudeSettings();
  put(root, PROJECT_FILES.claude, before);
  buildProject(root);
  assert.ok(checkProject(root).count > 1000);
  const result = spawnSync(process.execPath, [PROJECT_FILES.generator, 'check'], { cwd: root, encoding: 'utf8', env: { PATH: root } });
  assert.equal(result.status, 0, result.stderr);
  const output = fs.readFileSync(path.join(root, PROJECT_FILES.claude), 'utf8');
  assert.equal(withoutBash(JSON.parse(output)), withoutBash(before));
  assert.equal(generateClaude(core, output), output);
  put(root, PROJECT_FILES.claude, output.replace('Bash(rtk git status:*)', 'Bash(rtk:*)'));
  assert.throws(() => checkProject(root), /Écart/);
});

test('le contrôle natif Codex exclut les exemples Claude et vérifie les exemples RTK dérivés', t => {
  const root = temporary(t);
  const source = mirrored([
    entry({ pattern: ['git', 'status'], decision: 'allow', riskClass: 'read-only', match: ['git status'], notMatch: ['git push'] }),
    entry({ engines: ['claude'], notMatch: ["gh 'pr' merge 1"] }),
  ]);
  initProject(root);
  put(root, PROJECT_FILES.policy, source);
  buildProject(root);
  assert.match(checkNativeCodex(root, PROJECT_FILES.codex, source), /6 commandes vérifiées|absent/);
});

test('le schéma publié décrit engines et commandPrefixes sans dépendance externe', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'policy.schema.json'), 'utf8'));
  assert.deepEqual(schema.$defs.entry.properties.engines.default, ['codex', 'claude']);
  assert.deepEqual(schema.$defs.entry.properties.engines.items.enum, ['codex', 'claude']);
  assert.equal(schema.$defs.entry.properties.engines.minItems, 1);
  assert.equal(schema.$defs.entry.properties.engines.uniqueItems, true);
  assert.equal(schema.properties.commandPrefixes.items.$ref, '#/$defs/argvPrefix');
  assert.equal(schema.$defs.argvPrefix.minItems, 1);
});
