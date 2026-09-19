import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { applyInstall, prepareInstall, unifiedDiff } from '../lib/system.mjs';
import { temporary, put, cli } from './helpers.mjs';

function fixtures(root) {
  const files = {
    '.codex/rules/00-core.rules': '# ancien socle\n',
    '.codex/rules/default.rules': 'prefix_rule(pattern=["npm", "run"], decision="allow")\n',
    '.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [] }] }, model: 'example', permissions: { allow: ['Bash(*)'] } }, null, 2) + '\n',
  };
  for (const [relative, content] of Object.entries(files)) put(root, relative, content);
  return files;
}
test('install --target-root : diff, confirmation exacte, sauvegardes et migration', t => {
  const root = temporary(t);
  const before = fixtures(root);
  const result = cli(root, ['install', '--target-root', root], { input: `INSTALLER ${root}\n` });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--- \.codex\/rules\/00-core.rules/);
  assert.match(result.stdout, /\+\+\+ \.claude\/settings.json/);
  assert.match(result.stdout, /Migration/);
  assert.ok(result.stdout.indexOf('+++') < result.stdout.indexOf('Confirmer exactement'));
  const backups = fs.readdirSync(path.join(root, '.agent-policy/backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^\d{4}-\d{2}-\d{2}T/);
  const backup = path.join(root, '.agent-policy/backups', backups[0]);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
  for (const [relative, content] of Object.entries(before)) {
    assert.equal(fs.readFileSync(path.join(backup, relative), 'utf8'), content);
    assert.equal(fs.statSync(path.join(backup, relative)).mode & 0o777, 0o600);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json')));
  assert.equal(manifest.files.length, 3);
  assert.equal(manifest.targetRoot, root);
  assert.equal(fs.existsSync(path.join(root, '.codex/rules/default.rules')), false);
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json')));
  assert.deepEqual(settings.hooks, JSON.parse(before['.claude/settings.json']).hooks);
  assert.equal(settings.model, 'example');
  assert.equal(settings.permissions.allow.includes('Bash(*)'), false);
  const again = cli(root, ['install', '--target-root', root]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /déjà synchronisé/);
  assert.equal(fs.readdirSync(path.join(root, '.agent-policy/backups')).length, 1);
});

test('refus, EOF et confirmation générique ne modifient aucun fichier', t => {
  for (const input of ['', 'oui\n', 'INSTALLER /incorrect\n']) {
    const root = temporary(t);
    const before = fixtures(root);
    const result = cli(root, ['install', '--target-root', root], { input });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /annulée/);
    assert.equal(fs.existsSync(path.join(root, '.agent-policy')), false);
    for (const [relative, content] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), content);
  }
});
test('une première installation mémorise aussi les fichiers initialement absents', t => {
  const root = temporary(t);
  const result = cli(root, ['install', '--target-root', root], { input: `INSTALLER ${root}\n` });
  assert.equal(result.status, 0, result.stderr);
  const backup = path.join(root, '.agent-policy/backups', fs.readdirSync(path.join(root, '.agent-policy/backups'))[0]);
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json')));
  assert.ok(manifest.files.every(file => file.existed === false && file.mode === null && file.sha256 === null));
  // Procédure documentée : supprimer uniquement les cibles marquées absentes à l'origine.
  for (const file of manifest.files) fs.rmSync(path.join(root, file.path), { force: true });
  assert.equal(fs.existsSync(path.join(root, '.claude/settings.json')), false);
});
test('restauration exacte depuis la sauvegarde et modes du manifeste', t => {
  const root = temporary(t);
  const before = fixtures(root);
  fs.chmodSync(path.join(root, '.claude/settings.json'), 0o640);
  const backup = applyInstall(root, prepareInstall(root));
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json')));
  for (const file of manifest.files) {
    fs.copyFileSync(path.join(backup, file.path), path.join(root, file.path));
    fs.chmodSync(path.join(root, file.path), file.mode);
  }
  for (const [relative, content] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), content);
  assert.equal(fs.statSync(path.join(root, '.claude/settings.json')).mode & 0o777, 0o640);
});
test('une modification après le diff invalide le consentement', t => {
  const root = temporary(t);
  fixtures(root);
  const plan = prepareInstall(root);
  put(root, '.claude/settings.json', '{}\n');
  assert.throws(() => applyInstall(root, plan), /modifiée depuis le diff/);
  assert.equal(fs.existsSync(path.join(root, '.agent-policy')), false);
});
test('erreur lors de la seconde écriture : restauration des cibles, sauvegarde conservée', t => {
  const root = temporary(t);
  const before = fixtures(root);
  const plan = prepareInstall(root);
  const originalRename = fs.renameSync;
  let failed = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(root, '.claude/settings.json') && failed === false) {
      failed = true;
      throw new Error('échec simulé');
    }
    return originalRename(from, to);
  });
  assert.throws(() => applyInstall(root, plan), /Cibles restaurées/);
  for (const [relative, content] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), content);
  assert.equal(fs.readdirSync(path.join(root, '.agent-policy/backups')).length, 1);
});
test('une erreur de sauvegarde empêche toute modification des cibles', t => {
  const root = temporary(t);
  const before = fixtures(root);
  const plan = prepareInstall(root);
  put(root, '.agent-policy', 'obstacle');
  assert.throws(() => applyInstall(root, plan));
  for (const [relative, content] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), content);
});
test('refus des symlinks et JSON invalide avant confirmation', t => {
  const root = temporary(t);
  const outside = temporary(t);
  fs.symlinkSync(outside, path.join(root, '.claude'), 'dir');
  assert.throws(() => prepareInstall(root), /symbolique/);
  assert.equal(fs.readdirSync(outside).length, 0);
  fs.unlinkSync(path.join(root, '.claude'));
  put(root, '.claude/settings.json', '{broken');
  const result = cli(root, ['install', '--target-root', root], { input: `INSTALLER ${root}\n` });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes('Confirmer'), false);
  assert.equal(fs.existsSync(path.join(root, '.codex')), false);
});
test('diff à contexte nul sans clés inchangées', () => {
  const before = '{\n  "private": "unchanged",\n  "allow": ["old"]\n}\n';
  const after = '{\n  "private": "unchanged",\n  "allow": ["new"]\n}\n';
  const diff = unifiedDiff('settings.json', before, after);
  assert.match(diff, /-  "allow": \["old"\]/);
  assert.match(diff, /\+  "allow": \["new"\]/);
  assert.equal(diff.includes('private'), false);
});
test('le diff montre les espaces finaux et la fin de ligne sans tronquer', () => {
  const diff = unifiedDiff('example', 'old  ', 'old\n');
  assert.match(diff, /-old  \n\\ No newline at end of file/);
  assert.match(diff, /\+old\n/);
});
test('UTF-8 invalide : refuser une sauvegarde qui ne serait pas exacte', t => {
  const root = temporary(t);
  fixtures(root);
  fs.writeFileSync(path.join(root, '.codex/rules/default.rules'), Buffer.from([0xff, 0xfe]));
  assert.throws(() => prepareInstall(root), /UTF-8 invalide/);
  assert.equal(fs.existsSync(path.join(root, '.agent-policy')), false);
});
