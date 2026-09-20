import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  GIT_C_OPTIONS, GIT_C_COMMANDS, GIT_SUBCOMMANDS, GIT_C_MUTATIONS,
  optionGuardPatterns, generatePermissions, generateCodex, gitCMutationPatterns,
  compileClaudePermission, decisionFor, assertClaudeAllowPatterns, buildProject, PROJECT_FILES,
} from '../lib/generate.mjs';
import { initProject, readCore } from '../lib/system.mjs';
import { temporary, put, mixedClaudeSettings } from './helpers.mjs';

const core = readCore();
const permissions = generatePermissions(core);
const groups = ['deny', 'ask', 'allow'].map(key => permissions[key].map(compileClaudePermission));
const verdict = command => ['forbidden', 'prompt', 'allow'][groups.findIndex(matchers => matchers.some(match => match(command)))];
const prefixes = ['', 'rtk ', 'rtk proxy '];

test('catalogue Git versionné : toute la porcelaine et plomberie de help -a, plus lfs et svn', () => {
  const snapshot = fs.readFileSync(new URL('./fixtures/git-help-all.txt', import.meta.url), 'utf8');
  const commandSections = snapshot.split('User-facing repository, command and file interfaces')[0];
  const native = [...commandSections.matchAll(/^   (\S+) +/gmu)].map(match => match[1]);
  const expected = [...new Set([...native, 'lfs', 'svn'])].sort();
  assert.equal(expected.length, 150);
  assert.deepEqual(GIT_SUBCOMMANDS, expected);
  assert.ok(GIT_C_COMMANDS.every(command => expected.includes(command)));
  assert.deepEqual(GIT_C_MUTATIONS, expected.filter(command => !GIT_C_COMMANDS.includes(command)));
  assert.equal(GIT_C_MUTATIONS.length, 139);
});

test('les six contournements git -C sont prompt, avec leurs deux miroirs RTK', () => {
  for (const prefix of prefixes) for (const command of [
    'git -C /x difftool --extcmd=/tmp/evil status',
    "git -C /x submodule foreach 'rm -rf src' status",
    "git -C /x filter-branch --tree-filter 'rm -rf src' log",
    'git -C /x lfs fetch', 'git -C /x svn fetch', 'git -C /x replace a commit',
  ]) {
    assert.equal(verdict(prefix + command), 'prompt', prefix + command);
    assert.equal(decisionFor(core, prefix + command, 'claude'), 'prompt');
    assert.equal(decisionFor(core, prefix + command, 'codex'), undefined);
  }
});

test('tout mot du catalogue hors allow déclenche ask, en fin ou au milieu, jamais deny', () => {
  for (const prefix of prefixes) for (const command of GIT_C_MUTATIONS) {
    for (const suffix of ['', ' *']) {
      const permission = `Bash(${prefix}git -C * ${command}${suffix})`;
      assert.ok(permissions.ask.includes(permission), permission);
      assert.ok(!permissions.deny.includes(permission), permission);
    }
    for (const example of [
      `git -C /x ${command}`, `git -C /x ${command} argument`,
      `git -C /x ${command} status`, `git -C /x status ${command}`,
      `git -C /x commit -m "documenter ${command} ici"`,
    ]) assert.equal(verdict(prefix + example), 'prompt', prefix + example);
    // Une sous-chaîne ne vaut pas un mot : merge ne doit pas masquer merge-tree.
    assert.equal(verdict(`${prefix}git -C /x diff -- docs/${command}.md`), 'allow');
    assert.equal(verdict(`${prefix}git -C /x commit -m "documenter ${command}-suffixe"`), 'allow');
  }
  for (const prefix of prefixes) {
    assert.equal(verdict(`${prefix}git -C /x merge-tree HEAD feature`), 'allow');
    for (const command of ['branch --list', 'worktree list']) {
      assert.equal(verdict(`${prefix}git -C /x ${command}`), 'prompt');
      assert.equal(verdict(`${prefix}git ${command}`), 'allow');
    }
  }
});

test('chaque garde du catalogue est obligatoire en ask, indépendamment pour chaque miroir', () => {
  for (const prefix of prefixes) for (const pattern of gitCMutationPatterns(`${prefix}git -C`)) {
    const permission = `Bash(${pattern})`;
    const mutant = { ...permissions, ask: permissions.ask.filter(rule => rule !== permission) };
    assert.throws(() => assertClaudeAllowPatterns(mutant), /garde ask obligatoire/, permission);
    mutant.deny = [...permissions.deny, permission];
    assert.throws(() => assertClaudeAllowPatterns(mutant), /garde ask obligatoire/, permission);
    mutant.ask = permissions.ask;
    assert.throws(() => assertClaudeAllowPatterns(mutant), /jamais deny/, permission);
  }
});

test('build refuse une couverture incomplète avant toute écriture', t => {
  const root = temporary(t);
  initProject(root);
  const previous = JSON.stringify(mixedClaudeSettings(), null, 2);
  put(root, PROJECT_FILES.claude, previous);
  for (const pattern of ['git -C * difftool', 'git -C * difftool *', 'git -C * svn', 'git -C * lfs *']) {
    const mutant = structuredClone(core);
    const anchor = mutant.entries.find(e => e.claudePattern === 'git -C * status');
    anchor.claudeAsk = anchor.claudeAsk.filter(guard => guard.pattern !== pattern);
    put(root, PROJECT_FILES.policy, mutant);
    assert.throws(() => buildProject(root), /garde ask obligatoire/, pattern);
    assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.claude), 'utf8'), previous);
    assert.equal(fs.existsSync(path.join(root, PROJECT_FILES.codex)), false);
  }
});

test('le catalogue reste disponible dans la copie autonome, sans exécutable Git ni réseau', t => {
  const root = temporary(t);
  initProject(root);
  put(root, PROJECT_FILES.policy, core);
  const result = spawnSync(process.execPath, [PROJECT_FILES.generator, 'build'], {
    cwd: root, encoding: 'utf8', env: { PATH: root }, timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const generated = JSON.parse(fs.readFileSync(path.join(root, PROJECT_FILES.claude), 'utf8'));
  assert.deepEqual(generated.permissions, permissions);
});

test('parité Claude : add, commit et fetch avec ou sans -C, sans règle Codex pour -C', () => {
  const commands = ['add src/file', 'add --all', 'add --edit', 'commit -m message', 'commit --amend --no-edit', 'commit --edit', 'commit --gpg-sign=key', 'fetch', 'fetch --prune origin'];
  for (const prefix of prefixes) for (const command of commands) {
    const direct = `${prefix}git ${command}`;
    assert.equal(verdict(direct), 'allow', direct);
    assert.equal(decisionFor(core, direct, 'codex'), 'allow', direct);
    for (const worktree of ['/x', '../sibling', '"/worktree with spaces"']) {
      const changed = `${prefix}git -C ${worktree} ${command}`;
      assert.equal(verdict(changed), verdict(direct), changed);
      assert.equal(decisionFor(core, changed, 'claude'), 'allow');
      assert.equal(decisionFor(core, changed, 'codex'), undefined);
    }
  }
  const rules = [...generateCodex(core).matchAll(/pattern=(\[[^\n]+\]),/gu)].map(([, pattern]) => JSON.parse(pattern));
  assert.equal(rules.some(argv => argv.some((token, i) => token === 'git' && argv[i + 1] === '-C')), false);
});

test('options libres : ask Claude identique avec ou sans -C, y compris un argument légitime', () => {
  for (const prefix of prefixes) for (const name of ['add', 'commit', 'fetch']) {
    for (const option of GIT_C_OPTIONS) for (const suffix of [`${option}=program`, `argument ${option}=program`, `${option} program`, `argument ${option} program`]) {
      const direct = `${prefix}git ${name} ${suffix}`;
      const changed = `${prefix}git -C /x ${name} ${suffix}`;
      assert.equal(verdict(direct), 'prompt', direct);
      assert.equal(verdict(changed), 'prompt', changed);
      assert.equal(decisionFor(core, direct, 'codex'), 'allow', direct);
      assert.equal(decisionFor(core, changed, 'codex'), undefined);
    }
    for (const option of GIT_C_OPTIONS) {
      assert.equal(verdict(`${prefix}git ${name} docs/name${option}.txt`), 'allow');
      assert.equal(verdict(`${prefix}git -C /x ${name} docs/name${option}.txt`), 'allow');
      assert.equal(verdict(`${prefix}git -C /x ${option}=program ${name}`), 'prompt');
    }
  }
  for (const prefix of prefixes) for (const middle of ['', '-C /x ']) {
    assert.equal(verdict(`${prefix}git ${middle}commit -m "documenter --upload-pack=program"`), 'prompt');
    assert.equal(verdict(`${prefix}git ${middle}commit -m "documenter --output=file"`), 'prompt');
  }
  // Le retrait des gardes génériques ne retire pas celles de worktree/remote add.
  for (const prefix of prefixes) for (const command of ['git -C /x worktree add /y', 'git -C /x remote add origin target']) {
    assert.equal(verdict(prefix + command), 'prompt');
  }
});

test('gardes git -C obligatoires : aucune suppression ou transformation en deny des options ambiguës', () => {
  for (const pattern of GIT_C_OPTIONS.flatMap(option => optionGuardPatterns('git -C', option))) {
    const mutant = structuredClone(core);
    const anchor = mutant.entries.find(e => e.claudePattern === 'git -C * status');
    const guard = anchor.claudeAsk.find(g => g.pattern === pattern);
    assert.ok(guard);
    anchor.claudeAsk = anchor.claudeAsk.filter(g => g !== guard);
    assert.throws(() => generatePermissions(mutant), /exception git -C gardée/);
    anchor.claudeDeny = [guard];
    assert.throws(() => generatePermissions(mutant), /exception git -C gardée/);
  }
});

test('mutations Claude protégées et exception Codex worktree add conservée', () => {
  for (const prefix of prefixes) for (const command of [
    'push origin feature', 'pull --ff-only', 'merge main', 'rebase main', 'reset --soft HEAD',
    'checkout feature', 'stash push', 'worktree add ../sibling', 'worktree remove ../sibling',
    'worktree prune', 'worktree move old new', 'worktree repair', 'worktree lock ../sibling', 'worktree unlock ../sibling',
  ]) for (const middle of ['', '-C /x ']) {
    // Sans règle explicite, Claude demande l'accord par défaut.
    assert.equal(verdict(`${prefix}git ${middle}${command}`) ?? 'prompt', 'prompt');
  }
  for (const prefix of prefixes) {
    assert.equal(verdict(`${prefix}git worktree add ../sibling`), 'prompt');
    assert.equal(decisionFor(core, `${prefix}git worktree add ../sibling`), 'allow');
    for (const command of ['push', 'pull', 'merge', 'worktree remove sibling']) assert.equal(decisionFor(core, `${prefix}git ${command}`), 'prompt');
    for (const command of ['reset --hard HEAD', 'checkout -- file']) assert.equal(verdict(`${prefix}git ${command}`), 'forbidden');
  }
});

test('risques Git explicitement acceptés : éditeur, signature et upload-pack Codex', () => {
  for (const name of ['add', 'commit']) {
    const rule = core.entries.find(e => e.pattern?.join(' ') === `git ${name}`);
    assert.match(rule.residualRisk, /--edit.*éditeur configuré/u);
    assert.match(rule.residualRisk, /--gpg-sign.*programme de signature configuré/u);
    assert.match(rule.residualRisk, /préconfigurés par le user/u);
  }
  const fetch = core.entries.find(e => e.pattern?.join(' ') === 'git fetch');
  assert.match(fetch.residualRisk, /--upload-pack.*programme/u);
  assert.match(fetch.residualRisk, /pas être filtrée par préfixe/u);
  for (const prefix of prefixes) {
    assert.equal(decisionFor(core, `${prefix}git fetch --upload-pack=program`), 'allow');
    assert.equal(verdict(`${prefix}git fetch --upload-pack=program`), 'prompt');
    assert.equal(verdict(`${prefix}git -C /x fetch origin --upload-pack=program`), 'prompt');
  }
});
