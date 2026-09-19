import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { initProject, readCore } from '../lib/system.mjs';
import { buildProject, checkProject, checkNativeCodex, PROJECT_FILES } from '../lib/generate.mjs';
import { temporary, put, cli, policy, entry, ROOT, mixedClaudeSettings, withoutBash } from './helpers.mjs';

test('init, init répété et upgrade préservent strictement la source', t => {
  const root = temporary(t);
  assert.equal(cli(root, ['init']).status, 0);
  const source = '{"version":1,"entries":[]}\n';
  put(root, PROJECT_FILES.policy, source);
  const expected = fs.readFileSync(path.join(ROOT, 'lib/generate.mjs'), 'utf8');
  const target = path.join(root, PROJECT_FILES.generator);
  const before = fs.statSync(target).mtimeMs;
  assert.equal(cli(root, ['init']).status, 0);
  assert.equal(fs.statSync(target).mtimeMs, before);
  put(root, PROJECT_FILES.generator, '// ancienne copie');
  initProject(root);
  assert.equal(fs.readFileSync(target, 'utf8'), '// ancienne copie');
  assert.equal(cli(root, ['init', '--upgrade']).status, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), expected);
  assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.policy), 'utf8'), source);
  const upgradedTime = fs.statSync(target).mtimeMs;
  initProject(root, { upgrade: true });
  assert.equal(fs.statSync(target).mtimeMs, upgradedTime);
});
test('build/check, dérive des deux fichiers et conservation des hooks', t => {
  const root = temporary(t);
  initProject(root);
  put(root, PROJECT_FILES.policy, policy([entry()]));
  put(root, PROJECT_FILES.claude, { hooks: { Stop: [] }, permissions: { allow: ['Bash(*)'] } });
  assert.throws(() => checkProject(root), /Écart/);
  buildProject(root);
  assert.equal(checkProject(root).count, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, PROJECT_FILES.claude))).hooks, { Stop: [] });
  for (const file of [PROJECT_FILES.codex, PROJECT_FILES.claude]) {
    const target = path.join(root, file);
    const previous = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, file.endsWith('.rules') ? previous + '# manuel\n' : previous.replace('Bash(gh pr merge:*)', 'Bash(*)'));
    const result = cli(root, ['check']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Écart généré/);
    buildProject(root);
    assert.equal(fs.readFileSync(target, 'utf8'), previous);
  }
});
test('build valide les deux sorties avant toute écriture', t => {
  const root = temporary(t);
  initProject(root);
  put(root, PROJECT_FILES.claude, 'JSON invalide');
  assert.throws(() => buildProject(root));
  assert.equal(fs.existsSync(path.join(root, PROJECT_FILES.codex)), false);
});
test('build préserve les permissions non-Bash et check accepte leurs modifications manuelles', t => {
  const root = temporary(t);
  initProject(root);
  put(root, PROJECT_FILES.policy, readCore());
  const before = mixedClaudeSettings();
  put(root, PROJECT_FILES.claude, before);
  assert.equal(cli(root, ['build']).status, 0);
  const target = path.join(root, PROJECT_FILES.claude);
  const after = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(withoutBash(after), withoutBash(before));
  assert.equal(JSON.stringify(after.permissions).includes('Bash(old-'), false);
  after.permissions.allow.unshift('Read(extra/**)');
  after.permissions.ask.splice(2, 0, 'mcp__new__tool');
  after.permissions.deny.push('Write(extra-protected/**)');
  after.permissions.defaultMode = 'plan';
  const manual = JSON.stringify(after, null, '\t');
  put(root, PROJECT_FILES.claude, manual);
  assert.equal(cli(root, ['check']).status, 0);
  buildProject(root);
  assert.equal(fs.readFileSync(target, 'utf8'), manual);
  for (const key of ['allow', 'ask', 'deny']) {
    const drift = structuredClone(after);
    const index = drift.permissions[key].findIndex(value => value.startsWith('Bash('));
    drift.permissions[key][index] = 'Bash(manual:*)';
    put(root, PROJECT_FILES.claude, drift);
    assert.equal(cli(root, ['check']).status, 1, key);
    buildProject(root);
    assert.equal(checkProject(root).count > 0, true);
    assert.equal(withoutBash(JSON.parse(fs.readFileSync(target, 'utf8'))), withoutBash(after));
  }
});
test('la copie mono-fichier fonctionne hors ligne dans deux dépôts sans outil global', t => {
  for (let i = 0; i < 2; i += 1) {
    const root = temporary(t);
    initProject(root);
    put(root, PROJECT_FILES.policy, policy([entry()]));
    for (const command of ['build', 'check']) {
      const result = spawnSync(process.execPath, [PROJECT_FILES.generator, command], { cwd: root, encoding: 'utf8', env: { PATH: root } });
      assert.equal(result.status, 0, result.stderr);
    }
    const optional = spawnSync(process.execPath, [PROJECT_FILES.generator, 'check', '--codex'], { cwd: root, encoding: 'utf8', env: { PATH: root } });
    assert.equal(optional.status, 0, optional.stderr);
    assert.match(optional.stdout, /absent/);
  }
});
test('Codex natif contrôle tous les exemples sans exécuter les commandes', t => {
  const root = temporary(t);
  initProject(root);
  put(root, PROJECT_FILES.policy, readCore());
  buildProject(root);
  const result = checkNativeCodex(root, PROJECT_FILES.codex, readCore());
  assert.match(result, /commandes vérifiées|absent/);
});
test('les liens symboliques et les options CLI inattendues sont refusés', t => {
  const root = temporary(t);
  const outside = temporary(t);
  initProject(root);
  fs.symlinkSync(outside, path.join(root, '.codex'), 'dir');
  assert.throws(() => buildProject(root), /symbolique/);
  assert.equal(fs.readdirSync(outside).length, 0);
  for (const args of [[], ['build', '--yes'], ['install', '--yes'], ['init', '--force'], ['check', '--codex', '--codex'], ['install', '--target-root']]) {
    const result = cli(root, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage/);
  }
});
