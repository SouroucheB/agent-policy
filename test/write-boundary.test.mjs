import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { initProject, readCore } from '../lib/system.mjs';
import { buildProject, checkProject, generateCodex, generatePermissions, PROJECT_FILES } from '../lib/generate.mjs';
import { WRITE_GUARD_FILE, WRITE_GUARD_HOOK, generateWriteGuardSettings, assertWriteGuardPostcondition } from '../lib/write-boundary.mjs';
import { temporary, put, mixedClaudeSettings, ROOT } from './helpers.mjs';

function run(root, tool, input, options = {}) {
  return spawnSync(process.execPath, [path.join(root, WRITE_GUARD_FILE)], {
    cwd: root, input: JSON.stringify({ cwd: root, tool_name: tool, tool_input: input }),
    encoding: 'utf8', timeout: 5000,
    env: { PATH: root, HOME: path.join(root, '..', 'fake-home'), CLAUDE_PROJECT_DIR: root }, ...options,
  });
}
function bash(root, command, expected) {
  const result = run(root, 'Bash', { command });
  assert.equal(result.status, expected, `${command}: ${result.stderr}`);
  assert.equal(result.stdout, '');
}

test('garde autonome : reprise des cas CoproOS, sans exécuter les commandes', t => {
  const root = temporary(t);
  initProject(root);
  assert.equal(run(root, 'Write', { file_path: path.join(root, '.agent-tmp/run/report.json') }).status, 0);
  assert.equal(run(root, 'Edit', { file_path: '/private/tmp/coproos.json' }).status, 2);
  assert.equal(run(root, 'Write', { file_path: path.join(root, '..', 'outside.json') }).status, 2);
  for (const command of [
    'mv .agent-tmp/a /Users/example/.local/state/coproos/a', 'node /private/tmp/scratch.mjs',
    'echo audit > /private/tmp/coproos-audit.txt', 'git config --global user.name test',
    'npm install -g typescript', 'node -e "require(\"node:fs\").writeFileSync(\"/tmp/x\", \"x\")"',
  ]) bash(root, command, 2);
  bash(root, 'npm run test:hooks', 0);
  bash(root, 'cat /Users/example/.local/state/coproos/read-only.json', 0);
  fs.symlinkSync('/private/tmp', path.join(root, 'external'));
  assert.equal(run(root, 'Write', { file_path: path.join(root, 'external/blocked.json') }).status, 2);
});

test('Write/Edit/MultiEdit : créations, modifications, traversées, symlinks et cwd', t => {
  const root = temporary(t);
  const outside = temporary(t);
  initProject(root);
  fs.symlinkSync(outside, path.join(root, 'external'));
  fs.symlinkSync(path.join(outside, 'absent'), path.join(root, 'dangling'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.symlinkSync(path.join(root, 'docs'), path.join(root, 'internal'));
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    for (const file_path of ['docs/new.md', 'internal/new.md', `${root}/docs/new.md`]) assert.equal(run(root, tool, { file_path }).status, 0, file_path);
    for (const file_path of ['../outside.txt', `${outside}/new.txt`, 'external/new.txt', 'dangling/new.txt', 'external/../new.txt', '~/new.txt', '$HOME/new.txt']) {
      assert.equal(run(root, tool, { file_path }).status, 2, file_path);
    }
    assert.equal(run(root, tool, {}).status, 2);
    const payload = { tool_name: tool, cwd: outside, tool_input: { file_path: 'relative.txt' } };
    assert.equal(run(root, tool, {}, { input: JSON.stringify(payload) }).status, 2);
  }
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('Bash : mutations et exécutions externes, relatives, RTK et redirections', t => {
  const root = temporary(t);
  const outside = temporary(t);
  initProject(root);
  fs.symlinkSync(outside, path.join(root, 'external'));
  for (const prefix of ['', 'rtk ', 'rtk proxy ']) {
    for (const command of ['rm ../x', 'mv a ../x', 'cp a external/x', 'mkdir -p ../x', 'touch external/x', 'node ../x.mjs', 'bash ../x.sh', 'sed -i x ../x', 'git -C .. add x', 'npm --prefix=../other run test']) {
      bash(root, prefix + command, 2);
    }
  }
  for (const command of [
    'echo audit > ../report.txt', 'printf x >> external/report.txt', 'echo x &> ../report.txt',
    'tee ../report.txt', 'dd if=local of=../report.txt', 'cp --target-directory=../out a',
    'cd .. && touch x', 'cd ..; npm run test', 'cat README.md | tee ../report.txt',
    'touch "../space name.txt"', 'touch ../space\\ name.txt', 'rm ${HOME}/x',
    'bash -c "touch ../x"', 'bash -c"touch ../x"', 'python3 -c "print(1)"', './external/tool', './external/cat', 'cp -t../out a',
  ]) bash(root, command, 2);
  for (const command of ['touch local.txt', 'mkdir -p docs', 'cp a b', 'rm local.txt', 'npm run test:gate', 'rtk npm run test:gate', 'git add src', 'git commit -m "local change"', 'echo audit > report.txt', 'node scripts/test.mjs']) bash(root, command, 0);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(path.join(root, 'local.txt')), false);
});

test('Bash : lectures externes et redirections bénignes conservées', t => {
  const root = temporary(t);
  initProject(root);
  for (const command of [
    'cat ../README.md', 'ls /private/tmp', 'rg pattern ../src', 'sed -n 1,20p ../file',
    'git -C .. status', 'git -C .. diff --stat', 'cd .. && cat README.md',
    'git -C .. worktree list', 'git -C .. stash list', '/bin/cat ../README.md', '/usr/bin/sort ../file',
    'rtk proxy cat ../file', 'cat ../file 2>&1', 'cat ../file 2>/dev/null',
    'cat ../file >/dev/null', 'cat ../file &>/dev/null', 'cat < ../file',
    'cat ../file | head -20', 'printf "%s" "a > b"',
  ]) bash(root, command, 0);
});

test('entrée invalide et constructions opaques : refus fermé, aucun code évalué', t => {
  const root = temporary(t);
  initProject(root);
  for (const input of ['', '{broken', 'null']) assert.equal(run(root, 'Bash', {}, { input }).status, 2);
  for (const command of ['touch "$DEST/file"', 'echo $(touch ../x)', 'echo `touch ../x`', 'cat <<EOF\nx\nEOF', 'for x in a; do touch ../x; done', 'touch "unterminated']) bash(root, command, 2);
  assert.equal(run(root, 'Read', { file_path: '/outside' }).status, 0);
});

test('init dépose le garde versionné, autonome ; upgrade et répétitions idempotents', t => {
  const root = temporary(t);
  initProject(root);
  const target = path.join(root, WRITE_GUARD_FILE);
  const expected = fs.readFileSync(path.join(ROOT, 'lib/claude-worktree-write-guard.cjs'), 'utf8');
  assert.equal(fs.readFileSync(target, 'utf8'), expected);
  assert.match(expected, /write guard v1\.3\.0/);
  const files = [...Object.values(PROJECT_FILES).filter(file => file !== PROJECT_FILES.codex), WRITE_GUARD_FILE];
  const snapshot = () => files.map(file => [file, fs.readFileSync(path.join(root, file), 'utf8'), fs.statSync(path.join(root, file)).mtimeMs]);
  const initial = snapshot();
  initProject(root);
  initProject(root, { upgrade: true });
  assert.deepEqual(snapshot(), initial);
  put(root, WRITE_GUARD_FILE, '// ancienne copie');
  assert.match(initProject(root), /init --upgrade/);
  assert.equal(fs.readFileSync(target, 'utf8'), '// ancienne copie');
  initProject(root, { upgrade: true });
  assert.equal(fs.readFileSync(target, 'utf8'), expected);
  const upgraded = snapshot();
  initProject(root, { upgrade: true });
  assert.deepEqual(snapshot(), upgraded);
  // No global tool or repository dependency, and the hook can start in a different cwd.
  assert.equal(run(root, 'Write', { file_path: 'local' }, { cwd: path.dirname(root) }).status, 0);
  const fallback = run(root, 'Write', { file_path: '../outside' }, { env: { PATH: root }, cwd: path.dirname(root) });
  assert.equal(fallback.status, 2);
});

test('init conserve les autres hooks, permissions, clés, ordre et texte', t => {
  for (const indent of [2, '\t', undefined]) {
    const root = temporary(t);
    const original = mixedClaudeSettings();
    original.hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node scripts/other.cjs', timeout: 12 }] }];
    original.hooks.PostToolUse = [{ matcher: 'Write', hooks: [{ type: 'command', command: 'notify' }] }];
    const before = JSON.stringify(original, null, indent) + '\n';
    put(root, PROJECT_FILES.claude, before);
    fs.chmodSync(path.join(root, PROJECT_FILES.claude), 0o640);
    initProject(root);
    const after = fs.readFileSync(path.join(root, PROJECT_FILES.claude), 'utf8');
    assertWriteGuardPostcondition(before, after);
    assert.deepEqual(JSON.parse(after).permissions, original.permissions);
    assert.equal(after.replace(/,\s*\{"matcher":"Bash\|Write\|Edit\|MultiEdit","hooks":\[\{"type":"command","command":"node \\"\$CLAUDE_PROJECT_DIR\/scripts\/claude-worktree-write-guard.cjs\\"","timeout":5\}\]\}/u, ''), before);
    assert.equal(fs.statSync(path.join(root, PROJECT_FILES.claude)).mode & 0o777, 0o640);
    buildProject(root);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, PROJECT_FILES.claude))).hooks, JSON.parse(after).hooks);
    assert.equal(checkProject(root).count, 0);
  }
});

test('déclaration CoproOS existante : pas de second garde, aucun changement de settings', t => {
  const root = temporary(t);
  const original = { permissions: { allow: ['Read(src/**)'] }, hooks: { PreToolUse: [WRITE_GUARD_HOOK], PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: '.claude/hooks/notify-notion.sh', timeout: 30 }] }] } };
  const before = JSON.stringify(original, null, '\t') + '\n';
  put(root, PROJECT_FILES.claude, before);
  put(root, WRITE_GUARD_FILE, '// garde existant');
  initProject(root);
  assert.equal(fs.readFileSync(path.join(root, WRITE_GUARD_FILE), 'utf8'), '// garde existant');
  initProject(root, { upgrade: true });
  assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.claude), 'utf8'), before);
  assert.equal(original.hooks.PreToolUse.length, 1);
});

test('seule la déclaration possédée est normalisée, même mêlée à d’autres hooks', () => {
  const other = { type: 'command', command: 'node scripts/other.cjs', timeout: 8 };
  const old = { type: 'command', command: `node ./${WRITE_GUARD_FILE}`, timeout: 1, async: true };
  const before = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [other, old], custom: 'kept' }, { matcher: 'Bash', hooks: [old] }] }, permissions: { deny: ['Bash(rm:*)'] } });
  const result = generateWriteGuardSettings(before);
  assert.deepEqual(JSON.parse(result).hooks.PreToolUse, [{ matcher: 'Write', hooks: [other], custom: 'kept' }, WRITE_GUARD_HOOK]);
  assertWriteGuardPostcondition(before, result);
  assert.equal(generateWriteGuardSettings(result), result);
});

test('post-condition du hook : modifications hors propriété et garde incomplet refusés', () => {
  const before = JSON.stringify(mixedClaudeSettings());
  const result = generateWriteGuardSettings(before);
  for (const mutate of [
    value => value.permissions.allow.push('Bash(*)'), value => { value.permissions.defaultMode = 'plan'; },
    value => { value.model = 'changed'; }, value => { value.hooks.Stop = []; },
    value => value.hooks.PreToolUse[0].hooks.push({ type: 'command', command: 'other' }),
    value => { value.hooks.PreToolUse[0].hooks[0].async = true; },
    value => { value.hooks.PreToolUse[0].matcher = 'Bash'; },
    value => { value.hooks.PreToolUse = []; },
  ]) {
    const changed = JSON.parse(result);
    mutate(changed);
    assert.throws(() => assertWriteGuardPostcondition(before, JSON.stringify(changed)), /Post-condition Claude hook/);
  }
});

test('init échoue avant écriture si le rendu altère un réglage non possédé', t => {
  const root = temporary(t);
  const before = '{"model":"kept","permissions":{"allow":["Read(src/**)"]}}';
  put(root, PROJECT_FILES.claude, before);
  const original = JSON.stringify;
  t.mock.method(JSON, 'stringify', (value, ...args) => {
    const text = original(value, ...args);
    return value === 'hooks' ? '"unexpected":true,"hooks"' : text;
  });
  assert.throws(() => initProject(root), /Post-condition Claude hook/);
  assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.claude), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(root, PROJECT_FILES.policy)), false);
  assert.equal(fs.existsSync(path.join(root, WRITE_GUARD_FILE)), false);
});

test('init valide JSON, hooks actifs et chemins avant toute écriture', t => {
  for (const text of ['{broken', '{"hooks":[]}', '{"hooks":{"PreToolUse":{}}}', '{"disableAllHooks":true}']) {
    const root = temporary(t);
    put(root, PROJECT_FILES.claude, text);
    assert.throws(() => initProject(root));
    assert.equal(fs.existsSync(path.join(root, PROJECT_FILES.policy)), false);
    assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.claude), 'utf8'), text);
  }
  for (const file of [PROJECT_FILES.claude, WRITE_GUARD_FILE]) {
    const root = temporary(t);
    const outside = temporary(t);
    put(outside, 'target', '{}');
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.symlinkSync(path.join(outside, 'target'), path.join(root, file));
    assert.throws(() => initProject(root), /symbolique/);
    assert.equal(fs.existsSync(path.join(root, PROJECT_FILES.policy)), false);
    assert.equal(fs.readFileSync(path.join(outside, 'target'), 'utf8'), '{}');
  }
});

test('init du garde ne modifie ni le socle ni les règles générées des deux moteurs', t => {
  const root = temporary(t);
  const core = readCore();
  const before = [generateCodex(core), generatePermissions(core)];
  initProject(root);
  initProject(root, { upgrade: true });
  assert.deepEqual([generateCodex(readCore()), generatePermissions(readCore())], before);
  assert.equal(fs.existsSync(path.join(root, PROJECT_FILES.codex)), false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(root, PROJECT_FILES.claude))), 'permissions'), false);
});
