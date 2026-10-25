import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import test from 'node:test';
import { initProject } from '../lib/system.mjs';
import { PROJECT_FILES } from '../lib/generate.mjs';
import { CAST_GUARD_FILE, CAST_GUARD_HOOK } from '../lib/hooks.mjs';
import { temporary, put, ROOT } from './helpers.mjs';

// TypeScript vient de la devDependency épinglée de ce dépôt (npm ci), liée dans le dépôt de test.
const TYPESCRIPT = path.join(ROOT, 'node_modules/typescript');
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function git(root, ...args) {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, stdio: 'ignore', env: { ...process.env, ...GIT_ENV },
  });
}
function repository(t, { typescript = true, history = 'commit' } = {}) {
  assert.equal(fs.existsSync(path.join(TYPESCRIPT, 'package.json')), true, 'TypeScript absent : lancer npm ci');
  const root = temporary(t);
  initProject(root);
  put(root, 'src/existing.ts', 'type Foo = { a: number };\nexport const y: unknown = 1;\nexport const x = y as Foo;\n');
  if (history !== 'none') git(root, 'init', '--initial-branch=main');
  if (history === 'commit') {
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'fixture');
  }
  if (typescript) {
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.symlinkSync(TYPESCRIPT, path.join(root, 'node_modules/typescript'), 'dir');
  }
  return root;
}
function write(root, relative, content, tool = 'Edit') {
  put(root, relative, content);
  return spawnSync(process.execPath, [path.join(root, CAST_GUARD_FILE)], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ hook_event_name: 'PostToolUse', cwd: root, tool_name: tool, tool_input: { file_path: path.join(root, relative) }, tool_response: {} }),
    // Le dépôt de test vit sous ce checkout : Git ne doit pas remonter jusqu'à lui.
    env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: root, GIT_CEILING_DIRECTORIES: path.dirname(root), ...GIT_ENV },
  });
}
const existing = 'type Foo = { a: number };\nexport const y: unknown = 1;\nexport const x = y as Foo;\n';

test('cast préexistant : une modification ailleurs dans le fichier passe', t => {
  const root = repository(t);
  for (const tool of ['Edit', 'Write', 'MultiEdit']) {
    const result = write(root, 'src/existing.ts', `${existing}export const z = 2;\n`, tool);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  }
  assert.equal(write(root, 'src/existing.ts', existing.replace('export const y', 'export const yy')).status, 0);
});

test('ajout d’un as T, <T>x ou x! : refus qui cite la ligne', t => {
  const root = repository(t);
  for (const [line, text] of [
    ['export const w = y as Foo;', 'y as Foo'],
    ['export const w = <Foo>y;', '<Foo>y'],
    ['export const w = (globalThis.document)!;', '(globalThis.document)!'],
    ['export const w = y as unknown;', 'y as unknown'],
  ]) {
    const result = write(root, 'src/existing.ts', `${existing}export const z = 2;\n${line}\n`);
    assert.equal(result.status, 2, line);
    assert.match(result.stderr, /Cast TypeScript ajouté dans src\/existing\.ts : 2 assertion\(s\) de type contre 1 dans HEAD/u);
    assert.match(result.stderr, new RegExp(`ligne 5 : ${text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'), result.stderr);
    assert.doesNotMatch(result.stderr, /ligne 3 :/u);
  }
  // Même texte qu'un cast existant : seule l'occurrence en surplus est citée.
  const duplicate = write(root, 'src/existing.ts', `${existing}export const v = y as Foo;\n`);
  assert.equal(duplicate.status, 2);
  assert.match(duplicate.stderr, /ligne 4 : y as Foo/u);
  assert.doesNotMatch(duplicate.stderr, /ligne 3 :/u);
});

test('as const, <const> et opérateurs voisins ne comptent pas', t => {
  const root = repository(t);
  const neutral = [
    'export const list = [1, 2] as const;', 'export const tuple = <const>["a"];', 'export const n = 1 satisfies number;',
    'export const ne = 1 !== 2;', 'export const not = !true;', 'let late!: number; late = 1; export { late };',
  ].join('\n');
  const result = write(root, 'src/existing.ts', `${existing}${neutral}\n`);
  assert.equal(result.status, 0, result.stderr);
});

test('fichier nouveau : comparé à zéro, en .ts comme en .tsx', t => {
  const root = repository(t);
  assert.equal(write(root, 'src/new.ts', 'export const a = 1;\nexport const b = [a] as const;\n', 'Write').status, 0);
  const added = write(root, 'src/deep/new.ts', 'export const a: unknown = 1;\nexport const b = a as number;\n', 'Write');
  assert.equal(added.status, 2);
  assert.match(added.stderr, /src\/deep\/new\.ts : 1 assertion\(s\) de type contre 0 dans HEAD/u);
  assert.match(added.stderr, /ligne 2 : a as number/u);
  const tsx = write(root, 'src/view.tsx', 'export const v = <div>{String(1)}</div>;\nexport const e = document.body!;\n', 'Write');
  assert.equal(tsx.status, 2);
  assert.match(tsx.stderr, /ligne 2 : document\.body!/u);
  assert.equal(write(root, 'src/plain.tsx', 'export const v = <div>ok</div>;\n', 'Write').status, 0);
});

test('cast commité devenu la référence ; hors src, autres extensions et autres outils ignorés', t => {
  const root = repository(t);
  write(root, 'src/existing.ts', `${existing}export const w = y as Foo;\n`);
  git(root, 'commit', '-am', 'second cast');
  assert.equal(write(root, 'src/existing.ts', `${existing}export const w = y as Foo;\nexport const z = 1;\n`).status, 0);
  for (const relative of ['scripts/tool.ts', 'src/legacy.js', 'test/existing.ts', 'srcx/existing.ts']) {
    assert.equal(write(root, relative, 'export const a = (1 as unknown) as number;\n', 'Write').status, 0, relative);
  }
  put(root, 'src/existing.ts', `${existing}export const r = y as Foo;\n`);
  const read = spawnSync(process.execPath, [path.join(root, CAST_GUARD_FILE)], {
    cwd: root, encoding: 'utf8', input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: path.join(root, 'src/existing.ts') } }),
    env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(read.status, 0);
});

test('dépôt sans TypeScript, sans Git ou sans commit : garde inactive', t => {
  for (const options of [{ typescript: false }, { history: 'none' }, { history: 'init' }]) {
    const root = repository(t, options);
    const result = write(root, 'src/existing.ts', `${existing}export const w = y as Foo;\n`);
    assert.equal(result.status, 0, `${JSON.stringify(options)} : ${result.stderr}`);
    assert.equal(result.stderr, '');
  }
});

test('renommage indexé (git mv) : comparé à l’ancien chemin', t => {
  const root = repository(t);
  git(root, 'mv', 'src/existing.ts', 'src/moved.ts');
  assert.equal(write(root, 'src/moved.ts', `${existing}export const z = 2;\n`).status, 0);
  const added = write(root, 'src/moved.ts', `${existing}export const w = y as Foo;\n`);
  assert.equal(added.status, 2);
  assert.match(added.stderr, /src\/moved\.ts : 2 assertion\(s\) de type contre 1 dans HEAD/u);
  assert.match(added.stderr, /ligne 4 : y as Foo/u);
});

test('.mts et .cts contrôlés comme .ts', t => {
  const root = repository(t);
  for (const relative of ['src/module.mts', 'src/common.cts']) {
    const result = write(root, relative, 'export const a: unknown = 1;\nexport const b = a as number;\n', 'Write');
    assert.equal(result.status, 2, relative);
    assert.match(result.stderr, /ligne 2 : a as number/u);
    assert.equal(write(root, relative, 'export const a = [1] as const;\n', 'Write').status, 0, relative);
  }
});

test('entrée opaque refusée ; init déclare la garde en PostToolUse et dépose une copie autonome', t => {
  const root = repository(t);
  for (const input of ['{broken', JSON.stringify({ tool_name: 'Edit', tool_input: {} })]) {
    const result = spawnSync(process.execPath, [path.join(root, CAST_GUARD_FILE)], { cwd: root, encoding: 'utf8', input, env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: root } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Garde des casts : contrôle impossible/u);
  }
  const settings = JSON.parse(fs.readFileSync(path.join(root, PROJECT_FILES.claude), 'utf8'));
  assert.deepEqual(settings.hooks.PostToolUse, [CAST_GUARD_HOOK]);
  assert.equal(fs.readFileSync(path.join(root, CAST_GUARD_FILE), 'utf8'), fs.readFileSync(path.join(ROOT, 'lib/claude-cast-guard.cjs'), 'utf8'));
});
