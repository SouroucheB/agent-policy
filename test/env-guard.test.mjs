import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { initProject, readCore } from '../lib/system.mjs';
import { decisionFor, generateCodex, PROJECT_FILES } from '../lib/generate.mjs';
import {
  ENV_GUARD_FILE, ENV_GUARD_HOOK, CURSOR_HOOKS, CURSOR_HOOKS_FILE,
  generateCursorHooks, assertCursorHooksPostcondition,
} from '../lib/hooks.mjs';
import { temporary, put } from './helpers.mjs';

const WRAPPERS = ['./scripts/with-env.sh', './scripts/with-supabase-env.sh'];
const PRIVATE_LINE = 'PRIVATE_FIXTURE=never-printed';
function project(t, { wrappers = WRAPPERS } = {}) {
  const root = temporary(t);
  initProject(root);
  put(root, PROJECT_FILES.tools, { version: 1, envWrappers: wrappers, worktree: { privateFiles: [], install: [], notes: [] } });
  // Fichiers inertes : la garde ne doit ni les lire ni afficher leur contenu.
  for (const name of ['.env', '.env.local', 'config/.env.production']) put(root, name, `${PRIVATE_LINE}\n`);
  for (const name of ['src/lib/env.ts', 'scripts/ci-write-local-env.sh', 'report.env.integration.md']) put(root, name, 'x\n');
  return root;
}
function guard(root, payload, env = {}) {
  return spawnSync(process.execPath, [path.join(root, ENV_GUARD_FILE)], {
    cwd: root, input: typeof payload === 'string' ? payload : JSON.stringify({ cwd: root, ...payload }),
    encoding: 'utf8', timeout: 5000, env: { PATH: root, CLAUDE_PROJECT_DIR: root, ...env },
  });
}
function claude(root, tool_name, tool_input) {
  const result = guard(root, { hook_event_name: 'PreToolUse', tool_name, tool_input });
  assert.equal(result.stdout.includes('never-printed') || result.stderr.includes('never-printed'), false);
  return result;
}
const bash = (root, command) => claude(root, 'Bash', { command });

test('Claude : lectures, recherches et chargements .env refusés avec renvoi aux wrappers du dépôt', t => {
  const root = project(t);
  fs.symlinkSync(path.join(root, '.env'), path.join(root, 'notes.txt'));
  for (const file_path of ['.env', '.env.local', 'config/.env.production', path.join(root, '.env'), 'notes.txt']) {
    const result = claude(root, 'Read', { file_path });
    assert.equal(result.status, 2, file_path);
    assert.match(result.stderr, /Lecture de \.env refusée/u);
    assert.match(result.stderr, /\.\/scripts\/with-env\.sh, \.\/scripts\/with-supabase-env\.sh/u);
  }
  for (const command of [
    'cat .env', 'cat .env.local', 'grep X .env', 'grep -n KEY config/.env.production', 'node --env-file=.env server.mjs',
    'npx tsx --env-file=.env.local script.ts', 'source .env', '. .env.local', 'cat < .env', 'cat ".env"', "cat '.env.local'",
    'cat .e""nv', 'cat \\.env', 'cat .env*', 'cat .e*', 'cat .*', 'ls .[e]nv', 'cp .env /tmp/copy', 'echo "$(cat .env)"',
    'rtk proxy cat .env', 'git show HEAD:.env', 'cat {.env,README.md}', 'KEY=.env npm run dev', 'cat "$HOME/.env"',
  ]) assert.equal(bash(root, command).status, 2, command);
  for (const input of [{ pattern: 'KEY', path: '.env' }, { pattern: 'KEY', glob: '**/.env*' }, { pattern: 'KEY', glob: '.e*' }]) {
    assert.equal(claude(root, 'Grep', input).status, 2, JSON.stringify(input));
  }
});

test('Claude : wrappers, scripts npm et fichiers voisins de .env passent', t => {
  const root = project(t);
  for (const command of [
    './scripts/with-env.sh npx tsx scripts/check.ts', './scripts/with-supabase-env.sh npm run db:types', 'npm run dev',
    'cat src/lib/env.ts', 'bash scripts/ci-write-local-env.sh', 'cat report.env.integration.md', 'cat .envrc',
    'rm -rf .next/cache', 'git add .', 'ls .venv/bin', 'rg -n envWrappers agent-policy', 'cd .. && ls',
  ]) assert.equal(bash(root, command).status, 0, command);
  for (const file_path of ['src/lib/env.ts', 'scripts/ci-write-local-env.sh', 'report.env.integration.md', 'src/app/[id]/page.tsx']) {
    assert.equal(claude(root, 'Read', { file_path }).status, 0, file_path);
  }
  assert.equal(claude(root, 'Grep', { pattern: 'KEY', path: 'src', glob: '*.ts' }).status, 0);
  // Outils hors du matcher : la garde ne décide rien.
  for (const tool of ['Write', 'Edit', 'Glob']) assert.equal(claude(root, tool, { file_path: '.env', pattern: '.env*' }).status, 0, tool);
  const silent = bash(root, 'npm run dev');
  assert.equal(silent.stdout, '');
  assert.equal(silent.stderr, '');
});

test('message sans wrapper déclaré et entrée opaque : refus fermé', t => {
  const root = project(t, { wrappers: [] });
  assert.match(bash(root, 'cat .env').stderr, /Aucun wrapper déclaré dans agent-policy\/tools\.json/u);
  fs.rmSync(path.join(root, PROJECT_FILES.tools));
  assert.match(bash(root, 'cat .env').stderr, /Aucun wrapper déclaré/u);
  for (const input of ['', '{broken', 'null']) assert.equal(guard(root, input).status, 2);
  assert.equal(claude(root, 'Bash', {}).status, 2);
  assert.equal(claude(root, 'Read', { file_path: '' }).status, 2);
  assert.equal(claude(root, 'Grep', { pattern: 'x', path: 3 }).status, 2);
});

test('Cursor : beforeReadFile, beforeShellExecution et preToolUse Grep répondent au format Cursor', t => {
  const root = project(t);
  const cursor = (payload, env = { CURSOR_VERSION: '2.0.0' }) => {
    const result = guard(root, payload, env);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const read = cursor({ hook_event_name: 'beforeReadFile', file_path: path.join(root, '.env'), content: 'non lu', attachments: [] });
  assert.equal(read.permission, 'deny');
  assert.match(read.user_message, /with-env\.sh/u);
  assert.equal(Object.hasOwn(read, 'agent_message'), false);
  assert.deepEqual(cursor({ hook_event_name: 'beforeReadFile', file_path: path.join(root, 'src/lib/env.ts'), content: 'x', attachments: [] }), { permission: 'allow' });
  assert.equal(cursor({ hook_event_name: 'beforeReadFile', file_path: path.join(root, 'README.md'), content: 'x', attachments: [{ type: 'file', file_path: path.join(root, '.env.local') }] }).permission, 'deny');
  for (const command of ['cat .env', 'grep X .env', 'source .env', 'node --env-file=.env server.mjs']) {
    const shell = cursor({ hook_event_name: 'beforeShellExecution', command, cwd: root });
    assert.equal(shell.permission, 'deny', command);
    assert.match(shell.agent_message, /wrapper du dépôt/u);
  }
  for (const command of ['./scripts/with-env.sh npm run seed', 'npm run dev']) {
    assert.deepEqual(cursor({ hook_event_name: 'beforeShellExecution', command, cwd: root }), { permission: 'allow' }, command);
  }
  assert.equal(cursor({ hook_event_name: 'preToolUse', tool_name: 'Grep', tool_input: { pattern: 'KEY', path: '.env' } }).permission, 'deny');
  assert.equal(cursor({ hook_event_name: 'preToolUse', tool_name: 'Grep', tool_input: { pattern: 'TODO', path: 'src' } }).permission, 'allow');
  // Hook Claude chargé par Cursor : code 2 pour refuser, réponse Cursor pour autoriser.
  const imported = guard(root, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm run dev' } }, { CURSOR_VERSION: '2.0.0' });
  assert.equal(imported.status, 0);
  assert.deepEqual(JSON.parse(imported.stdout), { permission: 'allow' });
  const refused = guard(root, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat .env' } }, { CURSOR_VERSION: '2.0.0' });
  assert.equal(refused.status, 2);
  assert.equal(JSON.parse(refused.stdout).permission, 'deny');
  const broken = guard(root, '{broken', { CURSOR_VERSION: '2.0.0' });
  assert.equal(broken.status, 2);
  assert.equal(JSON.parse(broken.stdout).permission, 'deny');
});

test('init déclare la garde pour Claude et Cursor, sans toucher aux hooks Cursor existants', t => {
  const root = temporary(t);
  initProject(root);
  const settings = JSON.parse(fs.readFileSync(path.join(root, PROJECT_FILES.claude), 'utf8'));
  assert.deepEqual(settings.hooks.PreToolUse.filter(group => group.hooks[0].command.includes(ENV_GUARD_FILE)), [ENV_GUARD_HOOK]);
  const cursor = JSON.parse(fs.readFileSync(path.join(root, CURSOR_HOOKS_FILE), 'utf8'));
  assert.deepEqual(cursor, {
    version: 1,
    hooks: {
      beforeReadFile: [{ command: `node ${ENV_GUARD_FILE}`, failClosed: true, timeout: 5 }],
      beforeShellExecution: [{ command: `node ${ENV_GUARD_FILE}`, failClosed: true, timeout: 5 }],
      preToolUse: [{ command: `node ${ENV_GUARD_FILE}`, matcher: 'Grep', failClosed: true, timeout: 5 }],
    },
  });
  // Forme des hooks Cursor de CoproOS (2026-10-23), reproduite ici sans lire CoproOS.
  const existing = {
    version: 1,
    hooks: {
      beforeShellExecution: [{ command: 'node .cursor/hooks/shell-policy.mjs', failClosed: true, timeout: 15 }],
      preToolUse: [{ command: 'node .cursor/hooks/write-guard.mjs', matcher: 'Write|Delete', failClosed: true, timeout: 5 }],
    },
  };
  const before = JSON.stringify(existing, null, 2) + '\n';
  put(root, CURSOR_HOOKS_FILE, before);
  initProject(root);
  const after = fs.readFileSync(path.join(root, CURSOR_HOOKS_FILE), 'utf8');
  assertCursorHooksPostcondition(before, after);
  const expected = structuredClone(existing);
  expected.hooks = { beforeReadFile: [CURSOR_HOOKS[0].declaration], ...expected.hooks };
  expected.hooks.beforeShellExecution.push(CURSOR_HOOKS[1].declaration);
  expected.hooks.preToolUse.push(CURSOR_HOOKS[2].declaration);
  assert.deepEqual(JSON.parse(after), expected);
  assert.equal(after.startsWith('{\n  "version": 1,\n  "hooks": {\n    "beforeReadFile": [\n      {\n        "command": "node scripts/agent-env-read-guard.cjs"'), true);
  initProject(root, { upgrade: true });
  assert.equal(fs.readFileSync(path.join(root, CURSOR_HOOKS_FILE), 'utf8'), after);
});

test('hooks Cursor : forme ancienne normalisée, post-condition et refus avant écriture', t => {
  const old = { command: `node ./${ENV_GUARD_FILE}`, timeout: 1 };
  const other = { command: 'node .cursor/hooks/shell-policy.mjs' };
  const before = JSON.stringify({ version: 1, hooks: { beforeShellExecution: [old, other], stop: [{ command: 'notify' }] }, extra: true });
  const result = generateCursorHooks(before);
  assert.deepEqual(JSON.parse(result).hooks.beforeShellExecution, [other, CURSOR_HOOKS[1].declaration]);
  assert.deepEqual(JSON.parse(result).hooks.stop, [{ command: 'notify' }]);
  assert.equal(generateCursorHooks(result), result);
  for (const mutate of [
    value => { value.extra = false; }, value => { value.hooks.stop = []; },
    value => { value.hooks.beforeReadFile[0].failClosed = false; },
    value => { value.hooks.preToolUse[0].matcher = 'Read'; },
    value => value.hooks.beforeShellExecution.push(CURSOR_HOOKS[1].declaration),
    value => { delete value.hooks.beforeReadFile; },
  ]) {
    const changed = JSON.parse(result);
    mutate(changed);
    assert.throws(() => assertCursorHooksPostcondition(before, JSON.stringify(changed)), /Post-condition Cursor hook/);
  }
  for (const text of ['{broken', '{"hooks":{}}', '{"version":2,"hooks":{}}', '{"version":1,"hooks":[]}', '{"version":1,"hooks":{"preToolUse":{}}}']) {
    const root = temporary(t);
    put(root, CURSOR_HOOKS_FILE, text);
    assert.throws(() => initProject(root));
    assert.equal(fs.existsSync(path.join(root, PROJECT_FILES.policy)), false);
    assert.equal(fs.existsSync(path.join(root, ENV_GUARD_FILE)), false);
    assert.equal(fs.readFileSync(path.join(root, CURSOR_HOOKS_FILE), 'utf8'), text);
  }
});

test('Codex : les règles générées refusent la lecture et le chargement de .env, miroirs RTK compris', () => {
  const core = readCore();
  const rules = generateCodex(core);
  for (const prefix of ['', 'rtk ', 'rtk proxy ']) {
    for (const command of [
      'cat .env', 'cat .env.local', 'cat .env README.md', 'head .env', 'tail .env.local', 'source .env', 'source .env.local',
      '. .env', '. .env.local', 'node --env-file=.env server.mjs', 'node --env-file=.env.local server.mjs', 'npx tsx --env-file=.env script.ts',
    ]) {
      assert.equal(decisionFor(core, prefix + command, 'codex'), 'forbidden', prefix + command);
      assert.notEqual(decisionFor(core, prefix + command, 'codex'), 'allow');
    }
    for (const command of ['cat src/lib/env.ts', 'cat scripts/ci-write-local-env.sh', 'cat .envrc']) {
      assert.equal(decisionFor(core, prefix + command, 'codex'), 'allow', prefix + command);
    }
    // Limites des préfixes, documentées dans residualRisk : le fichier .env en position libre.
    for (const command of ['grep X .env', 'cat -n .env']) assert.equal(decisionFor(core, prefix + command, 'codex'), 'allow', prefix + command);
  }
  assert.match(rules, /pattern=\["cat",".env"\],\n {4}decision="forbidden"/u);
  assert.match(rules, /pattern=\["rtk","proxy","node","--env-file=.env"\],\n {4}decision="forbidden"/u);
  for (const entry of core.entries.filter(value => value.pattern?.some(token => /^(?:--env-file=)?\.env/u.test(token)))) {
    assert.deepEqual(entry.engines, ['codex']);
    assert.equal(entry.riskClass, 'shared-local-state');
    assert.match(entry.residualRisk, /garde \.env de Claude et de Cursor/u);
  }
});
