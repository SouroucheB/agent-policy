import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { initProject, readCore } from '../lib/system.mjs';
import { buildProject, checkProject, generateCodex, generatePermissions, PROJECT_FILES } from '../lib/generate.mjs';
import { VERSION } from '../lib/generate.mjs';
import {
  WRITE_GUARD_FILE, WRITE_GUARD_HOOK, ENV_GUARD_FILE, ENV_GUARD_HOOK, CAST_GUARD_FILE, CAST_GUARD_HOOK, CURSOR_HOOKS_FILE,
  generateClaudeHooks, assertClaudeHooksPostcondition,
} from '../lib/hooks.mjs';
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

test('test original CoproOS inchangé exécuté contre le garde déposé, dans un dépôt temporaire', t => {
  const root = temporary(t);
  initProject(root);
  // Copie exacte de scripts/__tests__/claude-worktree-write-guard.spec.mjs, lue dans
  // CoproOS le 2026-10-25 (dernier changement 80bc30ad) ; aucun accès à CoproOS pendant les tests.
  const spec = 'scripts/__tests__/claude-worktree-write-guard.spec.mjs';
  put(root, spec, fs.readFileSync(path.join(ROOT, 'test/fixtures/coproos-write-guard.spec.mjs'), 'utf8'));
  const result = spawnSync(process.execPath, [spec], { cwd: root, encoding: 'utf8', timeout: 15000, env: { PATH: root } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /boundary verified/);
});

test('xargs : libération de port et liste fermée d’options simples', t => {
  const root = temporary(t);
  initProject(root);
  bash(root, 'lsof -ti :9323 | xargs kill -9', 0);
  bash(root, 'lsof -ti :3000 | xargs kill -9 2>/dev/null', 0);
  for (const options of [
    '-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-x',
    '-n 1', '-L 2', '-P 0', '-P 4', '-s 1024', '-E STOP', '-E ""', '-E "END OF INPUT"', '-E -I',
    '-0 -r -t -n 2 -L 1 -P 0 -s 4096 -E STOP -x', '--', '-0 --',
  ]) bash(root, `lsof -ti :3000 | xargs ${options} kill -9`, 0);
  bash(root, 'printf x | xargs cat', 0);
  bash(root, 'printf x | xargs git status --short', 0);
  bash(root, 'printf x | rtk proxy xargs -n 1 kill -9', 0);
});

test('xargs : mutations, interpréteurs et lanceurs restent refusés même avec chemins locaux', t => {
  const root = temporary(t);
  initProject(root);
  for (const command of [
    'find . -name x | xargs rm', 'printf x | xargs sh -c "rm -rf src"',
    'printf x | xargs -I{} cp {} /tmp',
    ...['rm', 'mv', 'cp', 'tee', 'touch', 'mkdir', 'ln', 'dd', 'rsync', 'chmod', 'chown',
      'sh', 'bash', 'zsh', 'node', 'python', 'python3', 'perl', 'ruby', 'php', 'npx', 'tsx',
      'npm', 'yarn', 'pnpm', 'bun', 'deno', 'awk', 'sed', 'source', '.', 'cd', 'xargs'].map(program => `printf x | xargs -0 -n 1 ${program}`),
    'printf x | xargs env rm', 'printf x | xargs command rm', 'printf x | xargs sudo rm',
    'printf x | xargs rtk proxy rm', 'printf x | xargs timeout 1 rm',
    'printf x | xargs git add src', 'printf x | xargs sort -o local.txt',
    'printf x | xargs find . -delete', 'printf x | xargs /bin/rm',
    'printf x | xargs ./scripts/tool.sh', 'printf x | rtk xargs -n 1 cp a b',
  ]) bash(root, command, 2);
});

test('xargs : remplacement, options inconnues ou incomplètes et programme dynamique sont opaques', t => {
  const root = temporary(t);
  initProject(root);
  for (const options of [
    '-J {}', '-J{}', '-I {}', '-I{}', '-i', '-i{}', '--replace', '--replace={}', '--replace {}',
    '-n1', '-L1', '-P2', '-s1024', '-ESTOP', '-0r', '--max-args=1', '--max-args 1',
    '--nul', '-a file', '--arg-file=file', '-d ,', '-p', '--help', '--version', '--process-slot-var=PATH',
    '-n zero', '-n -1', '-n 0', '-L 0', '-P -1', '-s 0', '-n 1.5',
    '-E $FLAGS', '-E *', '-E {STOP,rm}',
    '-- -I{}', '-- --null', '-- --',
  ]) bash(root, `printf x | xargs ${options} kill -9`, 2);
  for (const suffix of ['', '-n', '-L', '-P', '-s', '-E', '-E STOP', '--', '{}', 'ki{ll', 'kill}', '""', '"$PROGRAM"']) {
    bash(root, `printf x | xargs ${suffix}`, 2);
  }
  bash(root, 'echo ls | xargs -I{} {}', 2);
  // Essai macOS ayant établi l’arbitrage -J : le hook analyse le texte seul.
  // Aucun xargs ni printf de cette commande n’est exécuté par ce test.
  const replacement = "printf '%s\\n' /usr/bin/printf | xargs -J /usr/bin/false /usr/bin/false '%s\\n' XARGS_PROGRAM_REPLACED";
  bash(root, replacement, 2);
  bash(root, replacement.replace('| xargs ', '| /usr/bin/xargs '), 2);
});

test('xargs ne contourne ni redirections externes ni refus des autres segments', t => {
  const root = temporary(t);
  initProject(root);
  for (const command of [
    'lsof -ti :3000 | xargs kill -9 > ../report.txt',
    'lsof -ti :3000 | xargs kill -9 2> /tmp/report.txt',
    'lsof -ti :3000 | xargs kill -9 && touch ../report.txt',
    'node ../script.mjs | xargs kill -9',
    'printf x | xargs /tmp/kill -9', 'printf x | xargs "$(echo kill)" -9',
  ]) bash(root, command, 2);
  bash(root, 'lsof -ti :3000 | xargs -- kill -9 2>&1', 0);
  bash(root, 'cd .. && lsof -ti :3000 | xargs kill -9', 0);
});

test('correctifs CoproOS repris : [id] littéral des outils de fichier, Shell, Delete et sortie Cursor', t => {
  const root = temporary(t);
  initProject(root);
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'Delete']) {
    assert.equal(run(root, tool, { file_path: 'src/app/dossiers/[id]/page.tsx' }).status, 0, tool);
    assert.equal(run(root, tool, { path: path.join(root, 'src/app/[slug]/{x}.tsx') }).status, 0, tool);
    for (const file_path of ['/private/tmp/[id]/page.tsx', '~/[id].tsx', '$HOME/x', 'src/$DIR/x', '../[id]/x']) {
      assert.equal(run(root, tool, { file_path }).status, 2, `${tool} ${file_path}`);
    }
  }
  assert.equal(run(root, 'Shell', { command: 'touch ../x' }).status, 2);
  assert.equal(run(root, 'Shell', { command: 'touch local.txt' }).status, 0);
  // Hook Claude chargé par Cursor : réponse au format Cursor, sauf appel imbriqué.
  const cursor = { PATH: root, CLAUDE_PROJECT_DIR: root, CURSOR_VERSION: '2.0.0' };
  const allowed = run(root, 'Bash', { command: 'npm run test:gate' }, { env: cursor });
  assert.equal(allowed.status, 0);
  assert.deepEqual(JSON.parse(allowed.stdout), { permission: 'allow' });
  const denied = run(root, 'Write', { file_path: '../outside.json' }, { env: cursor });
  assert.equal(denied.status, 2);
  assert.equal(JSON.parse(denied.stdout).permission, 'deny');
  assert.match(JSON.parse(denied.stdout).agent_message, /hors du worktree/u);
  const nested = run(root, 'Write', { file_path: '../outside.json' }, { env: { ...cursor, CURSOR_HOOK_NESTED: '1' } });
  assert.equal(nested.status, 2);
  assert.equal(nested.stdout, '');
  const project = run(root, 'Write', { file_path: path.join(root, 'local.json') }, { env: { PATH: root, CURSOR_PROJECT_DIR: root } });
  assert.equal(project.status, 0);
});

// Cache de plugins fictif reproduisant la disposition réelle (claude-security 0.12.0, octo 9.37.3).
function pluginCache(t) {
  const home = temporary(t);
  const plugins = path.join(home, '.claude/plugins');
  const security = path.join(plugins, 'cache/claude-plugins-official/claude-security/0.12.0/scripts');
  const octo = path.join(plugins, 'cache/nyldn-plugins/octo/9.37.3/scripts');
  for (const name of ['write_scan_meta.py', 'save_result.py', 'keep-waiting.sh', 'lib/plugin.py', 'helper.sh']) put(security, name, '# inerte : jamais exécuté par la garde\n');
  for (const name of ['install-hooks.sh', 'orchestrate.sh', 'validate-plugin-assembly.py', 'tool.mjs']) put(octo, name, '# inerte\n');
  put(plugins, 'outside.py', '# hors du cache\n');
  put(home, 'evil.py', '# hors du cache\n');
  fs.symlinkSync(path.join(home, 'evil.py'), path.join(security, 'linked.py'));
  fs.symlinkSync(home, path.join(security, 'escape'));
  return { home, security, octo };
}

test('plugins Claude Code : seuls les points d’entrée déclarés s’exécutent, aucune écriture permise (DoD 16)', t => {
  const root = temporary(t);
  initProject(root);
  const { home, security } = pluginCache(t);
  const env = { PATH: root, HOME: home, CLAUDE_PROJECT_DIR: root };
  const check = (command, expected) => {
    const result = run(root, 'Bash', { command }, { env });
    assert.equal(result.status, expected, `${command}: ${result.stderr}`);
  };
  const script = '~/.claude/plugins/cache/claude-plugins-official/claude-security/0.12.0/scripts';
  const octo = '~/.claude/plugins/cache/nyldn-plugins/octo/9.37.3/scripts';
  for (const command of [
    `python3 ${script}/write_scan_meta.py .agent-tmp/run . --mode changes --effort low --base origin/main --merge-base abc123`,
    `python3 "$HOME/.claude/plugins/cache/claude-plugins-official/claude-security/0.12.0/scripts/save_result.py" .agent-tmp/out.json .agent-tmp/run`,
    `python3 ${path.join(security, 'write_scan_meta.py')}`, `bash ${script}/keep-waiting.sh 10`,
    `rtk proxy python3 ${script}/write_scan_meta.py`, `/usr/bin/python3 ${script}/write_scan_meta.py 2>/dev/null`,
    `python3 ${script}/write_scan_meta.py > .agent-tmp/meta.json && cat .agent-tmp/meta.json`,
    `python3 ${script}/write_scan_meta.py -config -verbose --range abc..def`,
  ]) check(command, 0);
  for (const command of [
    // Écritures dans les plugins et sorties hors worktree : argument, fragment, affectation, redirection.
    `touch ${script}/x`, `cp README.md ${script}/write_scan_meta.py`, 'echo x > ~/.claude/plugins/data.json', `rm ${script}/keep-waiting.sh`,
    `python3 ${script}/write_scan_meta.py --out ${script}/meta.json`, `python3 ${script}/write_scan_meta.py --out=/tmp/meta.json`,
    `python3 ${script}/write_scan_meta.py out:/tmp/x`, `python3 ${script}/write_scan_meta.py a=b,/tmp/x`, `python3 ${script}/write_scan_meta.py -o/tmp/x`,
    `OUT=/tmp/x python3 ${script}/write_scan_meta.py`, `OUT=out:/tmp/x python3 ${script}/write_scan_meta.py`,
    `python3 ${script}/write_scan_meta.py > ~/.claude/plugins/meta.json`, `python3 ${script}/write_scan_meta.py >> /tmp/meta.json`,
    `python3 ${script}/write_scan_meta.py && touch ../x`, `bash ${script}/keep-waiting.sh ../report`,
    // Entrée standard fournie au point d'entrée : son contenu n'est pas contrôlé.
    `echo /tmp/x | bash ${script}/keep-waiting.sh`, `bash ${script}/keep-waiting.sh < /tmp/args`,
    // Autres plugins et scripts non déclarés du cache.
    `bash ${octo}/install-hooks.sh`, `bash ${octo}/orchestrate.sh 'consigne libre'`, `python3 ${octo}/validate-plugin-assembly.py`,
    `python3 ${script}/lib/plugin.py`, `bash ${script}/helper.sh`,
    // Échappements du cache et formes non couvertes.
    'python3 ~/.claude/plugins/cache/../outside.py', `python3 ${script}/../../../../../outside.py`, `python3 ${script}/linked.py`,
    `python3 ${script}/escape/evil.py`, 'python3 ~/.claude/plugins/cache', `python3 ${script}/absent.py`,
    `python3 -u ${script}/write_scan_meta.py`, `python3 -c "print(1)" ${script}/write_scan_meta.py`,
    `perl ${script}/write_scan_meta.py`, `sh ${script}/keep-waiting.sh`, `printf x | xargs python3 ${script}/write_scan_meta.py`,
    `cd ${script} && python3 write_scan_meta.py`, `python3 ${script}/*.py`,
  ]) check(command, 2);
  for (const tool of ['Write', 'Edit', 'MultiEdit']) {
    assert.equal(run(root, tool, { file_path: path.join(security, 'write_scan_meta.py') }, { env }).status, 2, tool);
  }
  assert.equal(fs.readFileSync(path.join(security, 'write_scan_meta.py'), 'utf8'), '# inerte : jamais exécuté par la garde\n');
});

test('plugins Claude Code : un dépôt complète la liste dans tools.json, jamais au-delà', t => {
  const root = temporary(t);
  initProject(root);
  const { home } = pluginCache(t);
  const env = { PATH: root, HOME: home, CLAUDE_PROJECT_DIR: root };
  const octo = '~/.claude/plugins/cache/nyldn-plugins/octo/9.37.3/scripts';
  const status = command => run(root, 'Bash', { command }, { env }).status;
  const tools = pluginScripts => put(root, PROJECT_FILES.tools, { version: 1, envWrappers: [], pluginScripts, worktree: { privateFiles: [], install: [], notes: [] } });
  assert.equal(status(`node ${octo}/tool.mjs`), 2);
  tools(['nyldn-plugins/octo/*/scripts/tool.mjs', 'nyldn-plugins/octo/*/scripts/validate-plugin-assembly.py']);
  assert.equal(status(`node ${octo}/tool.mjs --json`), 0);
  assert.equal(status(`python3 ${octo}/validate-plugin-assembly.py`), 0);
  assert.equal(status(`bash ${octo}/install-hooks.sh`), 2);
  // Une entrée hors grammaire (joker de marketplace, ..) invalide la liste du dépôt entière.
  tools(['*/octo/*/scripts/tool.mjs']);
  assert.equal(status(`node ${octo}/tool.mjs`), 2);
  tools(['nyldn-plugins/octo/../octo/*/scripts/tool.mjs']);
  assert.equal(status(`node ${octo}/tool.mjs`), 2);
});

test('affectations préfixées et interpréteurs nourris par stdin : contrôlés comme des arguments', t => {
  const root = temporary(t);
  initProject(root);
  for (const command of [
    'OUT=/tmp/x node scripts/report.mjs', 'NODE_OPTIONS=--require=/tmp/evil.js node scripts/report.mjs', 'TARGET=../x npm run build',
    "echo 'touch /tmp/x' | bash", 'printf x | python3 -', 'bash < /tmp/script.sh', 'cat /tmp/code.js | node',
  ]) bash(root, command, 2);
  for (const command of [
    'NODE_ENV=test npm run test', 'BASE_URL=http://127.0.0.1:3001 npm run test:e2e', 'TMPDIR=.agent-tmp/run npm run build',
    'OUT=/tmp/x cat README.md', 'git diff | node scripts/check.mjs', 'node --version', 'python3 scripts/tool.py < .agent-tmp/input.json',
  ]) bash(root, command, 0);
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
  assert.equal(expected.includes(`write guard v${VERSION} `), true);
  const files = [...Object.values(PROJECT_FILES).filter(file => file !== PROJECT_FILES.codex), WRITE_GUARD_FILE, ENV_GUARD_FILE, CAST_GUARD_FILE, CURSOR_HOOKS_FILE];
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
    assertClaudeHooksPostcondition(before, after);
    assert.deepEqual(JSON.parse(after).permissions, original.permissions);
    // Seules les trois déclarations sont ajoutées, à l'indentation du tableau qui les reçoit.
    const expected = structuredClone(original);
    expected.hooks.PreToolUse.push(WRITE_GUARD_HOOK, ENV_GUARD_HOOK);
    expected.hooks.PostToolUse.push(CAST_GUARD_HOOK);
    assert.equal(after, JSON.stringify(expected, null, indent) + '\n');
    assert.equal(fs.statSync(path.join(root, PROJECT_FILES.claude)).mode & 0o777, 0o640);
    buildProject(root);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, PROJECT_FILES.claude))).hooks, JSON.parse(after).hooks);
    assert.equal(checkProject(root).count, 0);
  }
});

test('déclaration CoproOS existante : pas de second garde d’écriture, nouvelles gardes ajoutées une fois', t => {
  const root = temporary(t);
  const notify = { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: '.claude/hooks/notify-notion.sh', timeout: 30 }] };
  const original = { permissions: { allow: ['Read(src/**)'] }, hooks: { PreToolUse: [WRITE_GUARD_HOOK], PostToolUse: [notify] } };
  put(root, PROJECT_FILES.claude, JSON.stringify(original, null, '\t') + '\n');
  put(root, WRITE_GUARD_FILE, '// garde existant');
  initProject(root);
  assert.equal(fs.readFileSync(path.join(root, WRITE_GUARD_FILE), 'utf8'), '// garde existant');
  const expected = JSON.stringify({ ...original, hooks: { PreToolUse: [WRITE_GUARD_HOOK, ENV_GUARD_HOOK], PostToolUse: [notify, CAST_GUARD_HOOK] } }, null, '\t') + '\n';
  assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.claude), 'utf8'), expected);
  initProject(root, { upgrade: true });
  initProject(root);
  assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.claude), 'utf8'), expected);
});

test('seules les déclarations possédées sont normalisées, même mêlées à d’autres hooks', () => {
  const other = { type: 'command', command: 'node scripts/other.cjs', timeout: 8 };
  const old = { type: 'command', command: `node ./${WRITE_GUARD_FILE}`, timeout: 1, async: true };
  const oldEnv = { type: 'command', command: `node "\${CLAUDE_PROJECT_DIR}/${ENV_GUARD_FILE}"`, timeout: 5 };
  const oldCast = { type: 'command', command: `node ${CAST_GUARD_FILE}`, timeout: 5 };
  const before = JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Write', hooks: [other, old, oldEnv], custom: 'kept' }, { matcher: 'Bash', hooks: [old] }],
      PostToolUse: [{ matcher: 'Edit', hooks: [oldCast] }],
    },
    permissions: { deny: ['Bash(rm:*)'] },
  });
  const result = generateClaudeHooks(before);
  assert.deepEqual(JSON.parse(result).hooks, {
    PreToolUse: [{ matcher: 'Write', hooks: [other], custom: 'kept' }, WRITE_GUARD_HOOK, ENV_GUARD_HOOK],
    PostToolUse: [CAST_GUARD_HOOK],
  });
  assertClaudeHooksPostcondition(before, result);
  assert.equal(generateClaudeHooks(result), result);
  // Une commande voisine n'est jamais identifiée par une sous-chaîne.
  const neighbour = JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: `node ${ENV_GUARD_FILE} --verbose` }] }] } });
  assert.deepEqual(JSON.parse(generateClaudeHooks(neighbour)).hooks.PreToolUse[0], JSON.parse(neighbour).hooks.PreToolUse[0]);
});

test('post-condition du hook : modifications hors propriété et garde incomplet refusés', () => {
  const before = JSON.stringify(mixedClaudeSettings());
  const result = generateClaudeHooks(before);
  for (const mutate of [
    value => value.permissions.allow.push('Bash(*)'), value => { value.permissions.defaultMode = 'plan'; },
    value => { value.model = 'changed'; }, value => { value.hooks.Stop = []; },
    value => value.hooks.PreToolUse[0].hooks.push({ type: 'command', command: 'other' }),
    value => { value.hooks.PreToolUse[0].hooks[0].async = true; },
    value => { value.hooks.PreToolUse[0].matcher = 'Bash'; },
    value => { value.hooks.PreToolUse = []; },
    value => { value.hooks.PreToolUse[1].matcher = 'Bash|Read'; },
    value => value.hooks.PreToolUse.push(ENV_GUARD_HOOK),
    value => { value.hooks.PostToolUse[0].hooks[0].timeout = 5; },
    value => { delete value.hooks.PostToolUse; },
  ]) {
    const changed = JSON.parse(result);
    mutate(changed);
    assert.throws(() => assertClaudeHooksPostcondition(before, JSON.stringify(changed)), /Post-condition Claude hook/);
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
  for (const file of [PROJECT_FILES.claude, WRITE_GUARD_FILE, ENV_GUARD_FILE, CAST_GUARD_FILE, CURSOR_HOOKS_FILE, PROJECT_FILES.tools]) {
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
