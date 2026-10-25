#!/usr/bin/env node
// agent-policy worktree-new v1.4.0 — copie autonome ; actualiser par agent-policy init --upgrade.
// Amorçage explicite de .worktrees/<sujet> sur chore/<sujet> depuis origin/main : fichiers privés
// copiés depuis le checkout principal, puis installation propre au worktree. Les noms de fichiers,
// commandes argv et notes viennent de agent-policy/tools.json ; aucun shell, aucun secret affiché.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTools } from './generate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const USAGE = 'Usage : node scripts/agent-policy/worktree-new.mjs <sujet> (minuscules, chiffres, tirets)';

function fail(message) { throw new Error(message); }
function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}
function git(cwd, ...args) {
  const result = run('git', args, { cwd });
  if (result.status !== 0) fail(`git ${args[0]} : ${result.stderr.trim()}`);
  return result.stdout.trim();
}
function ignored(checkout, name) { return run('git', ['-C', checkout, 'check-ignore', '-q', '--', name]).status === 0; }
function entry(target) {
  try { return fs.lstatSync(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function createWorktree(subject, cwd = process.cwd(), log = console.log) {
  if (typeof subject !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(subject)) fail(USAGE);
  const { worktree } = loadTools(git(cwd, 'rev-parse', '--show-toplevel'));
  const primary = fs.realpathSync(path.dirname(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')));
  const target = path.join(primary, '.worktrees', subject);
  const branch = `chore/${subject}`;
  // Tous les contrôles précèdent la création : une configuration absente ne laisse rien derrière elle.
  for (const name of worktree.privateFiles) {
    const stat = entry(path.join(primary, name));
    if (stat === null) fail(`${name} absent du checkout principal ; aucun worktree créé.`);
    if (!stat.isFile()) fail(`${name} doit être un fichier régulier du checkout principal ; aucun worktree créé.`);
    if (!ignored(primary, name)) fail(`${name} doit être ignoré par Git avant sa copie.`);
  }
  if (entry(target) !== null) fail(`Emplacement déjà utilisé : ${target}`);
  git(primary, 'check-ref-format', '--branch', branch);
  if (run('git', ['-C', primary, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0) fail(`Branche déjà présente : ${branch}`);
  if (entry(path.join(primary, '.worktrees'))?.isSymbolicLink()) fail('.worktrees doit être un dossier persistant du dépôt.');

  git(primary, 'fetch', 'origin', 'main');
  git(primary, 'worktree', 'add', target, '-b', branch, 'origin/main');
  try {
    for (const name of worktree.privateFiles) {
      if (!ignored(target, name)) fail(`${name} doit être ignoré dans la branche créée.`);
      const destination = path.join(target, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, fs.readFileSync(path.join(primary, name)), { mode: 0o600, flag: 'wx' });
      fs.chmodSync(destination, 0o600);
      log(`[worktree] ${name} copié, privé et ignoré par Git.`);
    }
    if (worktree.install.length > 0) {
      // Le cache npm reste dans le worktree, sous un dossier .agent-tmp/bootstrap-* propre.
      const scratch = run('bash', [path.join(HERE, 'agent-tmp.sh'), 'create', 'bootstrap'], { cwd: target });
      if (scratch.status !== 0) fail(`agent-tmp.sh : ${scratch.stderr.trim()}`);
      const env = { ...process.env, npm_config_cache: path.join(scratch.stdout.trim(), 'npm-cache') };
      for (const command of worktree.install) {
        const result = run(command[0], command.slice(1), { cwd: target, env, stdio: ['ignore', 'inherit', 'inherit'] });
        if (result.status !== 0) fail(`Installation en échec : ${command.join(' ')} (${result.status ?? result.signal})`);
      }
    }
  } catch (error) {
    fail(`${error.message}\n[worktree] Amorçage incomplet ; travail conservé dans ${target} (${branch}).`);
  }
  log(`[worktree] Prêt : ${target}`);
  log(`[worktree] Branche : ${branch}`);
  for (const note of worktree.notes) log(`[worktree] ${note}`);
  return { target, branch };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    try { createWorktree(process.argv[2]); }
    catch (error) { console.error(`[worktree] ${error.message}`); process.exitCode = 1; }
  }
}
