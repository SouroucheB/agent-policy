import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import {
  VERSION, PROJECT_FILES, validatePolicy, validateExamples, safePath, readOptional,
  atomicWrite, generateCodex, generateClaude,
} from './generate.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const GLOBAL_FILES = ['.codex/rules/00-core.rules', '.claude/settings.json', '.codex/rules/default.rules'];

export function initProject(root, { upgrade = false } = {}) {
  const policyText = readOptional(root, PROJECT_FILES.policy);
  if (policyText !== null) validateExamples(validatePolicy(JSON.parse(policyText)));
  const copies = [['lib/generate.mjs', PROJECT_FILES.generator], ['lib/brief.mjs', PROJECT_FILES.brief]]
    .map(([source, relative]) => ({ relative, content: fs.readFileSync(path.join(PACKAGE_ROOT, source), 'utf8'), before: readOptional(root, relative) }));
  if (policyText === null) atomicWrite(root, PROJECT_FILES.policy, '{\n  "version": 1,\n  "entries": []\n}\n', 0o644);
  for (const copy of copies) {
    if (copy.before === null || (upgrade && copy.before !== copy.content)) atomicWrite(root, copy.relative, copy.content, 0o644);
  }
  return copies.some(copy => copy.before !== null && copy.before !== copy.content) && upgrade === false
    ? 'Politique conservée ; utiliser init --upgrade pour actualiser le générateur et la commande brief.'
    : `Initialisé : ${PROJECT_FILES.policy}, générateur et commande brief v${VERSION}.`;
}

export function readCore() {
  const core = validatePolicy(JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'core-policy.json'), 'utf8')), { core: true });
  validateExamples(core);
  return core;
}
export function prepareInstall(root) {
  const core = readCore();
  const previous = GLOBAL_FILES.map(relative => {
    const before = readOptional(root, relative);
    return { relative, before, mode: before === null ? null : fs.statSync(safePath(root, relative)).mode & 0o777 };
  });
  const contents = [generateCodex(core), generateClaude(core, previous[1].before), null];
  return previous.map((file, index) => ({ ...file, after: contents[index] }));
}

// Diff unifié à contexte nul, pour limiter l'affichage des lignes inchangées.
export function unifiedDiff(relative, before, after) {
  if (before === after) return '';
  const oldLines = before?.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const newLines = after?.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const render = (prefix, line) => line.endsWith('\n') ? prefix + line.slice(0, -1) : `${prefix}${line}\n\\ No newline at end of file`;
  // LCS bornée ; les fichiers trop grands sont refusés plutôt que tronqués.
  if (oldLines.length * newLines.length > 4_000_000) throw new Error(`Diff trop volumineux : ${relative}`);
  const rows = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      rows[i][j] = oldLines[i] === newLines[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  const hunks = [];
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) { i += 1; j += 1; continue; }
    const startOld = i;
    const startNew = j;
    const changes = [];
    while ((i < oldLines.length || j < newLines.length) && (i >= oldLines.length || j >= newLines.length || oldLines[i] !== newLines[j])) {
      if (j < newLines.length && (i === oldLines.length || rows[i][j + 1] >= rows[i + 1][j])) { changes.push(render('+', newLines[j])); j += 1; }
      else { changes.push(render('-', oldLines[i])); i += 1; }
    }
    hunks.push(`@@ -${i === startOld ? startOld : startOld + 1},${i - startOld} +${j === startNew ? startNew : startNew + 1},${j - startNew} @@\n${changes.join('\n')}`);
  }
  return `--- ${before === null ? '/dev/null' : relative}\n+++ ${after === null ? '/dev/null' : relative}\n${hunks.join('\n')}\n`;
}
function digest(content) { return createHash('sha256').update(content).digest('hex'); }

export function applyInstall(root, plan) {
  // Refuser une cible modifiée entre l'affichage du diff et la confirmation.
  for (const file of plan) {
    const current = readOptional(root, file.relative);
    if (current !== file.before) throw new Error(`Cible modifiée depuis le diff : ${file.relative}`);
    if (current !== null && (fs.statSync(safePath(root, file.relative)).mode & 0o777) !== file.mode) throw new Error(`Mode modifié depuis le diff : ${file.relative}`);
  }
  const backupRelative = `.agent-policy/backups/${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  const backup = safePath(root, backupRelative);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const manifest = { version: 1, generatorVersion: VERSION, targetRoot: path.resolve(root), files: [] };
  for (const file of plan) {
    if (file.before !== null) atomicWrite(root, `${backupRelative}/${file.relative}`, file.before);
    manifest.files.push({ path: file.relative, existed: file.before !== null, mode: file.mode, sha256: file.before === null ? null : digest(file.before) });
  }
  atomicWrite(root, `${backupRelative}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  // Les sauvegardes complètes précèdent la première modification des cibles.
  const touched = [];
  try {
    for (const file of plan) {
      if (file.before === file.after) continue;
      touched.push(file);
      if (file.after === null) fs.unlinkSync(safePath(root, file.relative));
      else atomicWrite(root, file.relative, file.after, file.mode ?? 0o600);
    }
  } catch (error) {
    const failures = [];
    for (const file of touched.reverse()) {
      try {
        if (file.before === null) fs.rmSync(safePath(root, file.relative), { force: true });
        else atomicWrite(root, file.relative, file.before, file.mode);
      } catch (restoreError) { failures.push(restoreError.message); }
    }
    throw new Error(`Installation échouée : ${error.message}. Sauvegarde : ${backup}.${failures.length ? ` Restauration incomplète : ${failures.join('; ')}` : ' Cibles restaurées.'}`);
  }
  return backup;
}

export async function installCore({ targetRoot = os.homedir(), input = process.stdin, output = process.stdout } = {}) {
  const root = path.resolve(targetRoot);
  const plan = prepareInstall(root);
  const changes = plan.filter(file => file.before !== file.after);
  if (changes.length === 0) { output.write('Socle déjà synchronisé ; aucune écriture.\n'); return null; }
  output.write(`Installation du socle v${VERSION} dans ${root}\n`);
  if (plan[2].before !== null) output.write('Migration : default.rules sera archivé et retiré du dossier actif.\n');
  for (const file of changes) output.write(unifiedDiff(file.relative, file.before, file.after));
  const expected = `INSTALLER ${root}`;
  output.write(`Confirmer exactement « ${expected} » : `);
  const reader = createInterface({ input, output, terminal: false });
  let answer;
  try {
    for await (const line of reader) { answer = line; break; }
  } finally { reader.close(); }
  if (answer !== expected) throw new Error('Installation annulée : confirmation absente ou incorrecte ; aucune cible modifiée.');
  const backup = applyInstall(root, plan);
  output.write(`Socle installé. Sauvegarde : ${backup}\nRedémarrer Codex et Claude Code pour recharger la configuration.\n`);
  return backup;
}
