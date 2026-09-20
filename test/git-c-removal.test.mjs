import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  generatePermissions, generateCodex, compileClaudePermission, decisionFor,
  assertClaudeAllowPatterns, validatePolicy, buildProject, PROJECT_FILES, UNIQ_FORMS,
} from '../lib/generate.mjs';
import { initProject, readCore } from '../lib/system.mjs';
import { temporary, put, mixedClaudeSettings, policy } from './helpers.mjs';

const core = readCore();
const permissions = generatePermissions(core);
const prefixes = ['', 'rtk ', 'rtk proxy '];
const direct = permission => permission.slice(5, -1).replace(/^(?:rtk (?:proxy )?)+/u, '');
function verdict(command, settings = permissions) {
  for (const [key, decision] of [['deny', 'forbidden'], ['ask', 'prompt'], ['allow', 'allow']]) {
    if (settings[key].some(rule => compileClaudePermission(rule)(command))) return decision;
  }
}
const legacy = claudePattern => ({
  claudePattern, engines: ['claude'], decision: 'allow', riskClass: 'read-only',
  justification: 'Ancienne exception à refuser.', match: ['git -C /x status'], notMatch: ['git push'],
});

test('retrait git -C : seules 66 allow et 927 ask sont retirées, Codex inchangé octet pour octet', () => {
  // Empreintes prises avant édition sur main f5a5f59b9b83e97c01c8cc294513ccc14f36e9c0.
  // La seconde conserve toutes les permissions hors git -C, gardes et ordre compris.
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  assert.equal(sha256(generateCodex(core)), 'd50d02b1cecb536e694dcf7ff8a7f27a5e5fa877347035824cceba7ef6b97ea8');
  assert.equal(sha256(JSON.stringify(permissions)), 'eb0b1aa552e52b6cf028a5155e1088c2e7c8fde21f6b278b7bf564324d1e5cb9');
  assert.deepEqual(Object.fromEntries(Object.entries(permissions).map(([key, values]) => [key, values.length])), { allow: 327, ask: 912, deny: 944 });
  for (const values of Object.values(permissions)) {
    assert.equal(values.some(permission => /^git -C(?: |:|$)/u.test(direct(permission))), false);
  }
});

test('git -C courant ou malveillant : aucune décision du socle, miroirs et chemins dynamiques compris', () => {
  const commands = [
    'status', 'diff --stat', 'log --oneline', 'show HEAD', 'rev-parse HEAD', 'ls-files',
    'grep needle', 'merge-tree HEAD feature', 'branch --list', 'worktree list',
    'add src/file', 'add --edit', 'commit -m message', 'commit --gpg-sign=key', 'fetch --prune origin',
    'push origin status', 'branch --list -D status', 'worktree remove list',
    'remote set-url origin status', '-c name=value status', '--exec-path=program status',
    '--config-env=key=VARIABLE status', 'diff --output=report', 'diff --ext', 'grep --op=program needle',
    'fetch --upload-pack=program', 'fetch --upl=program',
    'difftool --extcmd=/tmp/evil status', "submodule foreach 'rm -rf src' status",
    "filter-branch --tree-filter 'rm -rf src' log", 'lfs fetch', 'svn fetch', 'replace a commit',
  ];
  for (const prefix of prefixes) for (const worktree of ['/x', '../sibling', '"/worktree with spaces"']) {
    for (const suffix of commands) {
      const command = `${prefix}git -C ${worktree} ${suffix}`;
      assert.equal(verdict(command), undefined, command);
      for (const engine of ['claude', 'codex']) assert.equal(decisionFor(core, command, engine), undefined, command);
    }
  }
});

test('absence de prompt général git -C : une permission précise ajoutée reste utilisable', () => {
  for (const prefix of prefixes) {
    const precise = `Bash(${prefix}git -C /specific-worktree status:*)`;
    const settings = { ...permissions, allow: [...permissions.allow, precise] };
    assertClaudeAllowPatterns(settings);
    assert.equal(verdict(`${prefix}git -C /specific-worktree status --short`, settings), 'allow');
    assert.equal(verdict(`${prefix}git -C /another-worktree status`, settings), undefined);
    assert.equal(verdict(`${prefix}git -C /specific-worktree push origin main`, settings), undefined);
  }
});

test('aucun joker interne allow accepté, même avec des gardes ask ou deny', () => {
  for (const prefix of prefixes) for (const pattern of ['git -C * status', 'git -C * status *', 'git * log', 'uniq * -c']) {
    const entry = legacy(prefix + pattern);
    assert.throws(() => validatePolicy(policy([entry])), /pas de joker interne/u);
    assert.throws(() => generatePermissions(policy([entry])), /pas de joker interne/u);
    const allow = [`Bash(${entry.claudePattern})`];
    for (const key of ['ask', 'deny']) {
      assert.throws(() => assertClaudeAllowPatterns({ allow, [key]: [`Bash(${prefix}git -C:*)`] }), /pas de joker interne/u);
    }
  }
  assertClaudeAllowPatterns({ allow: ['Bash(git status:*)', 'Bash(git status *)', 'Bash(uniq -c)'] });
  for (const prefix of prefixes) for (const form of UNIQ_FORMS) {
    assert.equal(verdict(prefix + form), 'allow');
    assert.equal(verdict(prefix + form + ' input output'), undefined);
  }
});

test('build refuse l’ancienne exception avant toute écriture', t => {
  const root = temporary(t);
  initProject(root);
  const previous = JSON.stringify(mixedClaudeSettings(), null, 2);
  put(root, PROJECT_FILES.claude, previous);
  for (const prefix of prefixes) for (const suffix of ['', ' *']) {
    put(root, PROJECT_FILES.policy, policy([legacy(`${prefix}git -C * status${suffix}`)]));
    assert.throws(() => buildProject(root), /pas de joker interne/u);
    assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.claude), 'utf8'), previous);
    assert.equal(fs.existsSync(path.join(root, PROJECT_FILES.codex)), false);
  }
});

test('copie autonome : même retrait et même refus des jokers, sans Git ni réseau', t => {
  const root = temporary(t);
  initProject(root);
  put(root, PROJECT_FILES.policy, core);
  const build = () => spawnSync(process.execPath, [PROJECT_FILES.generator, 'build'], {
    cwd: root, encoding: 'utf8', env: { PATH: root }, timeout: 5000,
  });
  const result = build();
  assert.equal(result.status, 0, result.stderr);
  const before = fs.readFileSync(path.join(root, PROJECT_FILES.claude), 'utf8');
  assert.deepEqual(JSON.parse(before).permissions, permissions);
  put(root, PROJECT_FILES.policy, policy([legacy('git -C * status')]));
  const invalid = build();
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /pas de joker interne/u);
  assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.claude), 'utf8'), before);
});

test('Git sans -C : add/commit/fetch, options libres et mutations conservent leurs décisions', () => {
  for (const prefix of prefixes) {
    for (const command of ['add src/file', 'add --all', 'add --edit', 'commit -m message', 'commit --amend --no-edit', 'commit --edit', 'commit --gpg-sign=key', 'fetch', 'fetch --prune origin']) {
      assert.equal(verdict(`${prefix}git ${command}`), 'allow');
      assert.equal(decisionFor(core, `${prefix}git ${command}`, 'codex'), 'allow');
    }
    for (const name of ['add', 'commit', 'fetch']) {
      for (const option of ['--output', '--ext-diff', '--upload-pack', '-c', '--exec-path', '--config-env']) {
        for (const suffix of [`${option}=program`, `argument ${option}=program`, `${option} program`, `argument ${option} program`]) {
          assert.equal(verdict(`${prefix}git ${name} ${suffix}`), 'prompt');
          assert.equal(decisionFor(core, `${prefix}git ${name} ${suffix}`, 'codex'), 'allow');
        }
        assert.equal(verdict(`${prefix}git ${name} docs/name${option}.txt`), 'allow');
      }
    }
    for (const command of ['push origin feature', 'pull --ff-only', 'merge main', 'rebase main', 'reset --soft HEAD', 'checkout feature', 'stash push', 'worktree add ../sibling', 'worktree remove ../sibling', 'worktree prune', 'worktree move old new', 'worktree repair', 'worktree lock ../sibling', 'worktree unlock ../sibling']) {
      assert.equal(verdict(`${prefix}git ${command}`) ?? 'prompt', 'prompt');
    }
    for (const command of ['reset --hard HEAD', 'checkout -- file']) assert.equal(verdict(`${prefix}git ${command}`), 'forbidden');
    assert.equal(decisionFor(core, `${prefix}git worktree add ../sibling`, 'codex'), 'allow');
    assert.equal(verdict(`${prefix}git commit -m "documenter --output=file"`), 'prompt');
  }
  for (const name of ['add', 'commit']) {
    const rule = core.entries.find(e => e.pattern?.join(' ') === `git ${name}`);
    assert.match(rule.residualRisk, /--edit.*éditeur configuré/u);
    assert.match(rule.residualRisk, /--gpg-sign.*programme de signature configuré/u);
    assert.match(rule.residualRisk, /préconfigurés par le user/u);
  }
  const fetch = core.entries.find(e => e.pattern?.join(' ') === 'git fetch');
  assert.match(fetch.residualRisk, /--upload-pack.*programme/u);
  assert.match(fetch.residualRisk, /pas être filtrée par préfixe/u);
});
