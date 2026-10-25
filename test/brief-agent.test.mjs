import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { initProject } from '../lib/system.mjs';
import { PROJECT_FILES, VERSION } from '../lib/generate.mjs';
import { temporary, put, ROOT } from './helpers.mjs';

const source = fs.readFileSync(path.join(ROOT, 'lib/brief-implementer.md'), 'utf8');

test('sous-agent brief-implementer : frontmatter Claude et outils sans délégation', () => {
  const [, frontmatter, body] = /^---\n([\s\S]+?)\n---\n([\s\S]+)$/u.exec(source) ?? [];
  assert.ok(frontmatter, 'frontmatter en tête de fichier');
  const fields = Object.fromEntries(frontmatter.split('\n').map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
  assert.deepEqual(Object.keys(fields), ['name', 'description', 'tools']);
  assert.equal(fields.name, 'brief-implementer');
  assert.match(fields.description, /agent-policy brief/u);
  assert.deepEqual(fields.tools.split(', '), ['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write', 'Bash']);
  assert.equal(body.includes(`brief-implementer v${VERSION} `), true);
});

test('sous-agent brief-implementer : règles imposées par la DoD 5', () => {
  for (const rule of [
    /Lire le brief en entier/u, /fiche du sujet/u, /déclencheurs du dépôt/u,
    /Aucun cast : ni `as T` \(seul `as const` est admis\), ni `<T>x`, ni `x!`\. Aucun `any`/u,
    /Tests colocalisés selon la convention du dépôt/u,
    /Valider par `tsc`/u, /tests ciblés des fichiers touchés/u, /Ne jamais lancer la gate complète/u,
    /Ne pas commiter/u, /Finir par un rapport/u, /\*\*Fichiers touchés\*\*/u, /\*\*Commandes et résultats\*\*/u, /\*\*Restes\*\*/u,
  ]) assert.match(source, rule);
  // Outillage commun : aucun nom propre à un dépôt consommateur.
  assert.doesNotMatch(source, /CoproOS|supabase|test:gate|docs\/artifacts/iu);
});

test('init dépose le sous-agent ; init le conserve, --upgrade l’actualise', t => {
  const root = temporary(t);
  initProject(root);
  const target = path.join(root, PROJECT_FILES.briefAgent);
  assert.equal(PROJECT_FILES.briefAgent, '.claude/agents/brief-implementer.md');
  assert.equal(fs.readFileSync(target, 'utf8'), source);
  put(root, PROJECT_FILES.briefAgent, 'ancienne copie\n');
  initProject(root);
  assert.equal(fs.readFileSync(target, 'utf8'), 'ancienne copie\n');
  initProject(root, { upgrade: true });
  assert.equal(fs.readFileSync(target, 'utf8'), source);
});
