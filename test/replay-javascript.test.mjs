import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { historyCalls, replayHistory, replayEvaluator, renderReplay } from '../lib/replay.mjs';
import { readCore } from '../lib/system.mjs';
import { PROJECT_FILES } from '../lib/generate.mjs';
import { temporary, put, entry, CLI, ROOT } from './helpers.mjs';

const container = (id, input, name = 'exec') => ({ type: 'response_item', payload: { type: 'custom_tool_call', name, call_id: id, input } });
const extract = input => historyCalls(container('synthetic', input))[0];
const jsonl = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';

test('conteneurs Codex : formes observées, clés citées ou non, trois délimiteurs et appels parallèles', () => {
  const samples = [
    ['const r = await tools.exec_command({"cmd":"sed -n \'1,240p\' AGENTS.md && rg -n foo src","workdir":"PRIVATE"});', ["sed -n '1,240p' AGENTS.md && rg -n foo src"]],
    ['const r = await tools.exec_command({\n  cmd: "pwd && rg --files src | sed -n \'1,240p\'",\n  workdir: "PRIVATE" });', ["pwd && rg --files src | sed -n '1,240p'"]],
    ['await Promise.allSettled([tools.exec_command({cmd:"pwd; git status --short"}), tools.exec_command({cmd:"rg --files src"})]);', ['pwd; git status --short', 'rg --files src']],
    ["await Promise.all([tools.shell({ 'command': 'git push' }), tools.shell_command({ command: `rm -rf x` })]);", ['git push', 'rm -rf x']],
    ['// @exec: {"yield_time_ms": 1000}\ntext(await tools.exec_command({cmd: "git status", workdir: "PRIVATE",},));', ['git status']],
    ['await tools /* comment */ . exec_command /* comment */ ({cmd /* comment */ : /* comment */ "git status"});', ['git status']],
    ['tools.exec_command({workdir: nested({a: [1, 2]}), cmd: "git status"}); tools.exec_command({cmd: "git status"});', ['git status', 'git status']],
  ];
  for (const [input, commands] of samples) {
    for (const name of ['exec', 'functions.exec']) {
      assert.deepEqual(historyCalls(container('id', input, name)), [{ engine: 'codex', id: 'id', container: true, commands, causes: [] }]);
    }
  }
});

test('littéraux : décodage lexical des échappements JS, continuations et gabarits sans interpolation', () => {
  for (const [input, command] of [
    [String.raw`tools.exec_command({cmd: "git\x20st\u0061t\u{75}s"})`, 'git status'],
    [String.raw`tools.exec_command({"c\u006dd": "git status\nrg --files"})`, 'git status\nrg --files'],
    [String.raw`tools.exec_command({cmd: 'echo \'word\' "quote" \\path'})`, "echo 'word' \"quote\" \\path"],
    [String.raw`tools.exec_command({cmd: "echo \t\r\b\f\v\0\/\q"})`, 'echo \t\r\b\f\v\0/q'],
    ['tools.exec_command({cmd: "git sta\\\ntus"})', 'git status'],
    ['tools.exec_command({cmd: "git sta\\\r\ntus"})', 'git status'],
    ['tools.exec_command({cmd: `git status\r\nrg --files`})', 'git status\nrg --files'],
    ['tools.exec_command({cmd: `echo \\`quoted\\` \\${LITERAL}`})', 'echo `quoted` ${LITERAL}'],
  ]) {
    assert.deepEqual(extract(input).commands, [command]);
    assert.deepEqual(extract(input).causes, []);
  }
});

test('valeurs non littérales : aucune extraction partielle, causes distinctes', () => {
  const samples = {
    variable: ['PRIVATE_VARIABLE'],
    concatenation: ['"git " + PRIVATE_SUFFIX', 'PRIVATE_PREFIX + " status"'],
    interpolation: ['`git ${PRIVATE_COMMAND}`', '`git ${nested({a: `nested ${PRIVATE_VALUE}`})}`'],
    call: ['PRIVATE_BUILD()', 'PRIVATE_OBJECT.build("git status")', 'String.raw`git status`.trim()'],
    expression: ['( "git status" )', 'true ? "git status" : "rm x"', 'String.raw`git status`', '["bash", "-lc", "git status"]', 'null', '42'],
  };
  for (const [cause, values] of Object.entries(samples)) {
    for (const value of values) {
      const result = extract(`tools.exec_command({cmd: ${value}}); tools.shell_command({command: "git push"});`);
      assert.deepEqual(result.commands, ['git push'], value);
      assert.deepEqual(result.causes, [cause], value);
    }
  }
  // Le gabarit dynamique reste inconnu, mais son appel imbriqué littéral est connu.
  const nested = extract('tools.exec_command({cmd: `git ${tools.exec_command({cmd: "rm PRIVATE"})}`}); tools.exec_command({cmd: "git status"});');
  assert.deepEqual(nested.commands, ['rm PRIVATE', 'git status']);
  assert.deepEqual(nested.causes, ['interpolation']);
});

test('objet de commande : spreads, doublons, clés calculées et accesseurs restent non analysés', () => {
  for (const args of [
    '{cmd: "git status", ...PRIVATE_OPTIONS}', '{...PRIVATE_OPTIONS, cmd: "git status"}',
    '{cmd: "git status", cmd: "rm x"}', '{cmd: "git status", "c\\u006dd": "rm x"}',
    '{cmd: "git status", command: "rm x"}', '{[PRIVATE_KEY]: "rm x", cmd: "git status"}',
    '{cmd: "git status", get command() { return "rm x"; }}',
    '{cmd: "git status", set cmd(value) { PRIVATE(value); }}', '{cmd}',
    '{cmd: "git status", workdir}', '{workdir: "PRIVATE"}', '{}',
    '{cmd: "git status"}, PRIVATE_OPTIONS', '',
  ]) {
    const result = extract(`tools.exec_command(${args});`);
    assert.deepEqual(result.commands, [], args);
    assert.deepEqual(result.causes, ['arguments'], args);
  }
  assert.deepEqual(extract('tools.exec_command(PRIVATE_ARGUMENTS)').causes, ['variable']);
  assert.deepEqual(extract('tools.exec_command(PRIVATE_BUILD())').causes, ['call']);
});

test('aucun faux appel issu de commentaires, chaînes, gabarits ou autres membres', () => {
  const input = [
    '// tools.exec_command({cmd:"rm PRIVATE_COMMENT"})',
    '/* tools.shell({command:"rm PRIVATE_BLOCK"}) */',
    'const text = "tools.exec_command({cmd:\'rm PRIVATE_STRING\'})";',
    'const template = `tools.shell_command({command:"rm PRIVATE_TEMPLATE"})`;',
    'const interpolated = `${"tools.exec_command({cmd:\'rm PRIVATE_INTERPOLATION\'})"}`;',
    'other.tools.exec_command({cmd:"rm PRIVATE_MEMBER"});',
    'other?.tools.exec_command({cmd:"rm PRIVATE_OPTIONAL"});',
    'new tools.exec_command({cmd:"rm PRIVATE_CONSTRUCTOR"});',
    'tools["exec_command"]({cmd:"rm PRIVATE_COMPUTED"});',
    'const alias = tools.exec_command; alias({cmd:"rm PRIVATE_ALIAS"});',
    'tools.exec_command({cmd:"git status"});',
  ].join('\n');
  assert.deepEqual(extract(input).commands, ['git status']);
  assert.deepEqual(extract(input).causes, []);
  assert.deepEqual(extract(input.split('\n').slice(0, -1).join('\n')).causes, ['no-shell-call']);
});

test('limites lexicales : syntaxe incomplète, escapes invalides et slash ambigu ne produisent aucun verdict', () => {
  for (const input of [
    'tools.exec_command({cmd:"git status"', 'tools.exec_command({cmd:"unterminated})',
    '/* unfinished', 'tools.exec_command({cmd:`git ${PRIVATE_UNCLOSED`})',
    'tools.exec_command({cmd:"git\nstatus"})', String.raw`tools.exec_command({cmd:"\xQ0"})`,
    String.raw`tools.exec_command({cmd:"\u{}"})`, String.raw`tools.exec_command({cmd:"\u{110000}"})`,
    String.raw`tools.exec_command({cmd:"\01"})`, String.raw`tools.exec_command({cmd:"\8"})`,
    'const decoy = /tools.exec_command({cmd:"rm PRIVATE_REGEX"})/;',
    'const division = PRIVATE_A / PRIVATE_B;', 'const unmatched = ([)];',
    '('.repeat(130) + ')'.repeat(130), undefined, 42,
  ]) {
    const result = extract(input);
    assert.deepEqual(result.commands, []);
    assert.deepEqual(result.causes, ['syntax']);
  }
  // Une limite lexicale invalide tout le conteneur, y compris un littéral antérieur.
  assert.deepEqual(extract('tools.exec_command({cmd:"git status"}); /PRIVATE/;').commands, []);
});

test('JSONL : chaque littéral reçoit exactement le verdict Codex hors conteneur, couche et RTK compris', async t => {
  const root = temporary(t);
  const project = { version: 1, entries: [entry({ pattern: ['npm', 'run', 'PRIVATE_SCRIPT'], decision: 'allow', riskClass: 'local-reversible', match: ['npm run PRIVATE_SCRIPT'], notMatch: ['npm run other'] })] };
  put(root, PROJECT_FILES.policy, project);
  const commands = ['git status --short PRIVATE_PATH', 'git push PRIVATE_REMOTE', 'rm PRIVATE_PATH', 'sed -n 1p PRIVATE_PATH', 'rtk npm run PRIVATE_SCRIPT', 'git status >PRIVATE_FILE', 'git status 2>&1', 'rg --files && git diff --check && lsof -ti :3001'];
  const inline = commands.map(cmd => `tools.exec_command(${JSON.stringify({ cmd, workdir: 'PRIVATE' })})`).join(',\n');
  put(root, 'wrapped/session.jsonl', jsonl([container('batch', `await Promise.allSettled([${inline}]);`)]));
  put(root, 'direct/session.jsonl', jsonl(commands.map((cmd, i) => ({ type: 'response_item', payload: { type: 'function_call', call_id: `call${i}`, name: 'exec_command', arguments: JSON.stringify({ cmd }) } }))));
  const wrapped = await replayHistory(path.join(root, 'wrapped'), root);
  const direct = await replayHistory(path.join(root, 'direct'), root);
  for (const key of ['total', 'verdicts', 'families', 'unsupported', 'unsupportedByCause']) assert.deepEqual(wrapped.engines.codex[key], direct.engines.codex[key], key);
  assert.equal(wrapped.engines.codex.total, commands.length);
  assert.equal(wrapped.engines.codex.containers, 1);
  assert.equal(wrapped.engines.codex.containersWithoutCommands, 0);
  const decide = replayEvaluator([readCore()], 'codex');
  for (const command of commands) assert.deepEqual(decide(extract(`tools.exec_command({cmd:${JSON.stringify(command)}})`).commands[0]), decide(command));
  assert.doesNotMatch(renderReplay(wrapped), /PRIVATE|--short|--check|3001|2>&1/u);
});

test('JSONL : conteneurs mixtes, déduplication du groupe et causes exactes sans contenu libre', async t => {
  const root = temporary(t);
  const mixed = container('mixed', 'tools.exec_command({cmd:"git status --short PRIVATE_PATH"}); tools.exec_command({cmd:"git status --short PRIVATE_PATH"}); tools.exec_command({cmd:PRIVATE_VARIABLE});');
  const records = [
    mixed, mixed,
    container('variable', 'tools.exec_command({cmd:PRIVATE_VARIABLE}); tools.exec_command({cmd:PRIVATE_SECOND});'),
    container('concatenation', 'tools.exec_command({cmd:"git " + PRIVATE_SUFFIX});'),
    container('interpolation', 'tools.exec_command({cmd:`git ${PRIVATE_NAME}`});'),
    container('call', 'tools.exec_command({cmd:PRIVATE_CALL()});'),
    container('expression', 'tools.exec_command({cmd:("git status")});'),
    container('arguments', 'tools.exec_command({cmd:"git status", ...PRIVATE_OBJECT});'),
    container('syntax', 'PRIVATE_BROKEN('), container('unrelated', 'PRIVATE_UNRELATED();'),
    container('empty', 'tools.exec_command({cmd:""});'),
  ];
  put(root, 'history/session.jsonl', jsonl(records));
  const result = await replayHistory(path.join(root, 'history'), root);
  const stats = result.engines.codex;
  assert.equal(result.duplicates, 1);
  assert.equal(result.invalidCalls, 1);
  assert.equal(stats.total, 2);
  assert.deepEqual(stats.verdicts, { allow: 2, aucune: 0, prompt: 0, forbidden: 0 });
  assert.equal(stats.containers, 10);
  assert.equal(stats.containersWithoutCommands, 8);
  assert.deepEqual(stats.containersByCause, { variable: 1, concatenation: 1, interpolation: 1, call: 1, expression: 1, arguments: 1, syntax: 1, 'no-shell-call': 1 });
  assert.deepEqual(stats.javascriptUnsupportedByCause, { ...stats.containersByCause, variable: 3 });
  const rendered = renderReplay(result);
  assert.match(rendered, /10 conteneurs JavaScript, dont 8 sans commande littérale/u);
  assert.match(rendered, /variable : 3 fragments non analysés ; 1 conteneurs/u);
  assert.doesNotMatch(rendered, /PRIVATE|git status --short|\$\{|cmd:/u);
  assert.equal(rendered, renderReplay(await replayHistory(path.join(root, 'history'), root)));
});

test('CLI : JavaScript jamais exécuté, génération de code et écritures interdites pendant le rejeu', t => {
  const root = temporary(t);
  put(root, 'history/session.jsonl', jsonl([container('malicious', [
    'process.stdout.write("PRIVATE_EXECUTED");',
    'process.exit(79);',
    'throw new Error("PRIVATE_EXECUTED");',
    'tools.exec_command({cmd:"touch PRIVATE_MUST_NOT_EXIST"});',
    'tools.exec_command({cmd:PRIVATE_CALL()});',
  ].join('\n'))]));
  const before = fs.statSync(path.join(root, 'history/session.jsonl')).mtimeMs;
  const result = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', '--permission', '--allow-fs-read=*', CLI, 'replay', path.join(root, 'history')], { cwd: root, env: { PATH: root }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex : 1 commandes/u);
  assert.match(result.stdout, /appel calculant la valeur : 1/u);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE|process|79|cmd:/u);
  assert.deepEqual(fs.readdirSync(root), ['history']);
  assert.equal(fs.statSync(path.join(root, 'history/session.jsonl')).mtimeMs, before);
  const source = fs.readFileSync(path.join(ROOT, 'lib/replay.mjs'), 'utf8');
  assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\b|\bimport\s*\(|node:(?:vm|child_process)|\b(?:spawn|spawnSync|execFile|execSync)\s*\(/u);
});
