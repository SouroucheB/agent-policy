import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import test from 'node:test';
import { initProject, TOOLS_TEMPLATE } from '../lib/system.mjs';
import { PROJECT_FILES, validateTools } from '../lib/generate.mjs';
import { temporary, put, ROOT } from './helpers.mjs';

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const PRIVATE_LINE = 'PRIVATE_FIXTURE=never-printed';
const NOTE = 'Base locale partagée : coordonner les migrations entre worktrees.';
const tools = (worktree = {}) => ({
  version: 1, envWrappers: [],
  worktree: { privateFiles: ['.env', '.env.local'], install: [['npm', 'ci'], ['test', '-f', 'node_modules/marker']], notes: [NOTE], ...worktree },
});
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...GIT_ENV },
  });
}
// Dépôt de test avec un npm factice : il vérifie que son cache reste dans le worktree créé.
function fixture(t, { layer = tools(), ignore = '.env\n.env.local\n', npmStatus = 0 } = {}) {
  const repo = temporary(t);
  const bin = temporary(t);
  initProject(repo);
  put(repo, PROJECT_FILES.tools, layer);
  put(repo, '.gitignore', `${ignore}.worktrees/\n.agent-tmp/\nnode_modules/\n`);
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'fixture');
  git(repo, 'remote', 'add', 'origin', repo);
  fs.writeFileSync(path.join(bin, 'npm'), [
    '#!/usr/bin/env bash', 'set -eu', '[[ "$1" == ci && "$#" -eq 1 ]]',
    'case "$npm_config_cache" in "$PWD"/.agent-tmp/bootstrap-*/npm-cache) ;; *) exit 9 ;; esac',
    `mkdir -p node_modules && touch node_modules/marker && exit ${npmStatus}`, '',
  ].join('\n'), { mode: 0o755 });
  return { repo, bin };
}
function secrets(repo) {
  fs.writeFileSync(path.join(repo, '.env'), `${PRIVATE_LINE}-one\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(repo, '.env.local'), `${PRIVATE_LINE}-two\n`, { mode: 0o600 });
}
function worktreeNew({ repo, bin }, args, cwd = repo) {
  const result = spawnSync(process.execPath, [path.join(cwd, PROJECT_FILES.worktreeNew), ...args], {
    cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(`${result.stdout}${result.stderr}`.includes('never-printed'), false, 'aucun secret affiché');
  return result;
}

test('worktree-new : configuration privée absente ou non ignorée, aucun worktree créé', t => {
  const setup = fixture(t);
  const missing = worktreeNew(setup, ['example']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /\.env absent du checkout principal ; aucun worktree créé/u);
  assert.equal(fs.existsSync(path.join(setup.repo, '.worktrees')), false);
  assert.equal(worktreeNew(setup, []).status, 2);
  for (const subject of ['../escape', 'Example', '-x', 'a/b']) {
    const invalid = worktreeNew(setup, [subject]);
    assert.equal(invalid.status, 1, subject);
    assert.match(invalid.stderr, /Usage/u);
  }
  const visible = fixture(t, { ignore: '.env\n' });
  secrets(visible.repo);
  const result = worktreeNew(visible, ['example']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.env\.local doit être ignoré par Git avant sa copie/u);
  assert.equal(fs.existsSync(path.join(visible.repo, '.worktrees')), false);
});

test('worktree-new : fichiers privés copiés en 0600, installation dans le worktree, notes du dépôt', t => {
  const setup = fixture(t);
  secrets(setup.repo);
  const result = worktreeNew(setup, ['example']);
  assert.equal(result.status, 0, result.stderr);
  const target = path.join(setup.repo, '.worktrees/example');
  assert.equal(fs.readFileSync(path.join(target, '.env.local'), 'utf8'), `${PRIVATE_LINE}-two\n`);
  for (const name of ['.env', '.env.local']) assert.equal(fs.statSync(path.join(target, name)).mode & 0o777, 0o600);
  assert.equal(git(target, 'ls-files', '.env', '.env.local'), '');
  assert.equal(git(target, 'branch', '--show-current').trim(), 'chore/example');
  assert.equal(fs.existsSync(path.join(target, 'node_modules/marker')), true);
  assert.equal(fs.readdirSync(path.join(target, '.agent-tmp')).some(name => name.startsWith('bootstrap-')), true);
  assert.match(result.stdout, new RegExp(`\\[worktree\\] ${NOTE}`, 'u'));
  assert.match(result.stdout, /Prêt : .*\.worktrees\/example\n\[worktree\] Branche : chore\/example/u);
  const again = worktreeNew(setup, ['example']);
  assert.notEqual(again.status, 0, 'un chantier existant reste intact');
  assert.match(again.stderr, /Emplacement déjà utilisé/u);
  // Depuis un worktree lié : le nouveau chantier reste sous le checkout principal.
  const nested = worktreeNew(setup, ['second'], target);
  assert.equal(nested.status, 0, nested.stderr);
  assert.equal(fs.existsSync(path.join(setup.repo, '.worktrees/second/.env')), true);
});

test('worktree-new : un échec d’installation conserve le worktree et l’annonce', t => {
  const setup = fixture(t, { npmStatus: 1 });
  secrets(setup.repo);
  const result = worktreeNew(setup, ['broken']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Installation en échec : npm ci \(1\)\n\[worktree\] Amorçage incomplet ; travail conservé dans .*\.worktrees\/broken \(chore\/broken\)/u);
  assert.equal(fs.existsSync(path.join(setup.repo, '.worktrees/broken/.env')), true);
});

test('worktree-new : couche du dépôt vide ou invalide', t => {
  const empty = fixture(t, { layer: tools({ privateFiles: [], install: [], notes: [] }) });
  const result = worktreeNew(empty, ['bare']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(empty.repo, '.worktrees/bare/.agent-tmp')), false);
  const invalid = fixture(t, { layer: tools({ privateFiles: ['../secret'] }) });
  const refused = worktreeNew(invalid, ['other']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Outils : worktree\.privateFiles invalide/u);
  assert.equal(fs.existsSync(path.join(invalid.repo, '.worktrees')), false);
});

test('tools.json : modèle créé par init, jamais écrasé, validé avant toute écriture', t => {
  const root = temporary(t);
  initProject(root);
  assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.tools), 'utf8'), TOOLS_TEMPLATE);
  assert.doesNotThrow(() => validateTools(JSON.parse(TOOLS_TEMPLATE)));
  put(root, PROJECT_FILES.tools, tools());
  initProject(root, { upgrade: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, PROJECT_FILES.tools), 'utf8')), tools());
  for (const invalid of [
    { ...tools(), version: 2 }, { ...tools(), extra: true }, { version: 1, envWrappers: [] },
    tools({ privateFiles: ['/abs/.env'] }), tools({ privateFiles: ['.git/config'] }), tools({ privateFiles: ['a\\b'] }),
    tools({ privateFiles: ['.env', '.env'] }), tools({ install: [[]] }), tools({ install: ['npm ci'] }),
    tools({ install: [['npm', '']] }), tools({ notes: ['deux\nlignes'] }), { ...tools(), envWrappers: [''] },
  ]) {
    assert.throws(() => validateTools(invalid), /Outils/u, JSON.stringify(invalid));
    const fresh = temporary(t);
    put(fresh, PROJECT_FILES.tools, invalid);
    assert.throws(() => initProject(fresh), /Outils/u);
    assert.equal(fs.existsSync(path.join(fresh, PROJECT_FILES.policy)), false);
  }
});

test('agent-tmp.sh : création seule, label fermé, aucune purge', t => {
  const { repo } = fixture(t);
  const script = path.join(repo, PROJECT_FILES.agentTmp);
  const run = (args, cwd = repo, env = {}) => spawnSync('bash', [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...env } });
  const created = run(['create', 'gate-target']);
  assert.equal(created.status, 0, created.stderr);
  const directory = created.stdout.trim();
  assert.match(directory, new RegExp(`^${repo.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/\\.agent-tmp/gate-target-[0-9]{14}-[0-9]+$`, 'u'));
  assert.equal(fs.statSync(directory).isDirectory(), true);
  // Un ancien dossier n'est jamais supprimé ici : la purge à sept jours est unique, hors dépôt.
  const old = path.join(repo, '.agent-tmp/old-run');
  fs.mkdirSync(old);
  fs.utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));
  assert.equal(run(['create', 'other']).status, 0);
  assert.equal(fs.existsSync(old), true);
  for (const args of [['prune'], ['create'], ['create', 'a/b'], ['create', 'a b'], ['create', 'x', 'y'], []]) {
    assert.equal(run(args).status, 2, args.join(' '));
  }
  const outside = temporary(t);
  const refused = run(['create', 'x'], outside, { GIT_CEILING_DIRECTORIES: path.dirname(outside) });
  assert.notEqual(refused.status, 0);
  assert.equal(fs.existsSync(path.join(outside, '.agent-tmp')), false);
});

test('scripts de worktree déposés sans contenu propre à un dépôt ; une seule purge, hors paquet', t => {
  const root = temporary(t);
  initProject(root);
  for (const [deposited, packaged] of [[PROJECT_FILES.worktreeNew, 'lib/worktree-new.mjs'], [PROJECT_FILES.agentTmp, 'lib/agent-tmp.sh']]) {
    const text = fs.readFileSync(path.join(root, deposited), 'utf8');
    assert.equal(text, fs.readFileSync(path.join(ROOT, packaged), 'utf8'));
    assert.doesNotMatch(text, /coproos|pdfjs|pdf\.worker|supabase|npm ci|(?:^|[^A-Za-z])\.env|\/Users\//iu, deposited);
  }
  for (const name of fs.readdirSync(path.join(ROOT, 'lib'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'lib', name), 'utf8'), /-mtime|RETENTION|retention|prune_stale/u, name);
  }
});
