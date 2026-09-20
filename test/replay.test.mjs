import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { historyCalls, splitShell, replayEvaluator, replayHistory, renderReplay, commandFamily } from '../lib/replay.mjs';
import { readCore } from '../lib/system.mjs';
import { PROJECT_FILES } from '../lib/generate.mjs';
import { temporary, put, cli, entry, CLI } from './helpers.mjs';

const core = readCore();
const evaluate = replayEvaluator([core], 'claude');
const claude = (id, command) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const codex = (id, name, args) => ({ type: 'response_item', payload: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) } });
const jsonl = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';

test('cd et composés : chaque segment est évalué, jamais une autorisation du suffixe entier', () => {
  for (const command of [
    'cd /worktree', 'cd /worktree && git status', 'cd ../worktree && git diff --stat',
    'cd /worktree; cat README.md | head -n 5', "cd '/worktree with spaces' && awk '{print $1}' file",
  ]) assert.deepEqual(evaluate(command), { verdict: 'allow', unsupported: false }, command);
  for (const [command, verdict] of [
    ['cd /worktree && git push', 'prompt'], ['cd /worktree && rm -rf x', 'forbidden'],
    ['git status || gh pr merge 1', 'prompt'], ['cd /worktree && unknown command', 'aucune'],
    ['cat README.md\nrm x', 'forbidden'],
  ]) assert.deepEqual(evaluate(command), { verdict, unsupported: false });
  assert.deepEqual(splitShell("awk '{print $1; print $2}' file | head"), ["awk '{print $1; print $2}' file", 'head']);
});

test('le rejeu ne prétend pas interpréter substitutions, redirections ou programmes shell', () => {
  for (const command of ['cat "$(rm x)"', 'echo `program`', 'cat README.md > outside', 'for x in a; do cat x; done', 'cat file &&', 'cat "unterminated', 'cat file & program']) {
    assert.equal(evaluate(command).unsupported, true, command);
    assert.notEqual(evaluate(command).verdict, 'allow', command);
  }
  assert.deepEqual(evaluate('cat <<EOF\ntext\nEOF'), { verdict: 'forbidden', unsupported: true, cause: 'heredoc' });
});

test('redirections bénignes : verdict identique, chaque moteur et chaque segment', () => {
  const redirects = ['2>&1', '2>/dev/null', '>/dev/null', '&>/dev/null', '2> /dev/null', '>\t/dev/null', '&> /dev/null', '>/dev/null 2>&1', '2>&1 >/dev/null'];
  for (const engine of ['claude', 'codex']) {
    const decide = replayEvaluator([core], engine);
    for (const command of ['git status', 'git push', 'rm x', 'unknown argument', 'rtk git diff --check', 'rtk proxy git log --oneline']) {
      for (const redirect of redirects) {
        assert.deepEqual(decide(`${command} ${redirect}`), decide(command), `${engine} ${command} ${redirect}`);
      }
    }
    assert.deepEqual(decide('git status 2>&1 | head -n 5 >/dev/null && git push &>/dev/null'), { verdict: 'prompt', unsupported: false });
    assert.deepEqual(decide('git status >/dev/null || rm x 2>/dev/null'), { verdict: 'forbidden', unsupported: false });
  }
  assert.deepEqual(splitShell('2>/dev/null git 2>&1 status'), ['git status']);
  assert.deepEqual(evaluate('uniq -c 2>&1'), { verdict: 'allow', unsupported: false });
});

test('redirections : frontières de mots, guillemets et échappements préservés', () => {
  for (const [command, parts] of [
    ['git grep "2>&1" README.md 2>&1', ['git grep "2>&1" README.md']],
    ["awk '$3 > 5 {print $1}' file >/dev/null", ["awk '$3 > 5 {print $1}' file"]],
    ['echo file2>/dev/null', ['echo file2']],
    ['git st>/dev/null atus', ['git st atus']],
    ['git st>/dev/null\tatus', ['git st atus']],
    ['echo "2">/dev/null', ['echo "2"']],
    ['echo 2&>/dev/null', ['echo 2']],
    [String.raw`echo 2\>\&1`, [String.raw`echo 2\>\&1`]],
  ]) assert.deepEqual(splitShell(command), parts, command);
  assert.equal(evaluate("awk '$3 > 5 {print $1}' file >/dev/null").verdict, 'prompt');
  for (const command of ['git st>/dev/null atus', 'git status2>/dev/null']) assert.notEqual(evaluate(command).verdict, 'allow');
});

test('quatre causes fermées : autres redirections, substitutions, structures et heredocs', () => {
  const groups = {
    redirection: ['git status > file', 'git status >>/dev/null', 'git status 2>/dev/null.log', 'git status &>/dev/null/other', 'git status 12>/dev/null', 'git status 2>&10', 'git status 2>&1suffix', 'git status < file', 'git status >/dev/null"suffix"', 'git status 2>/dev/null > file', 'git status >|file', 'git status 2>&2'],
    substitution: ['git status $(program)', 'echo `program`', 'echo "${VALUE}"', 'cat <(program)', 'echo >(/path/program)'],
    structure: ['for x in a; do git status; done', 'if git status; then git push; fi', 'git status &&', 'git status & program', '(git status)', '{ git status; }', 'git "unterminated', 'git status # comment', '. script', 'git status\0'],
    heredoc: ['cat <<EOF\ntext\nEOF', 'cat <<-EOF\ntext\nEOF', 'cat <<<word'],
  };
  for (const engine of ['claude', 'codex']) {
    const decide = replayEvaluator([core], engine);
    for (const [cause, commands] of Object.entries(groups)) {
      for (const command of commands) {
        const result = decide(command);
        assert.equal(result.unsupported, true, command);
        assert.equal(result.cause, cause, command);
        assert.notEqual(result.verdict, 'allow', command);
      }
    }
  }
  // Une seule cause par commande : le premier obstacle rencontré.
  assert.equal(evaluate('git status >file $(program)').cause, 'redirection');
  assert.equal(evaluate('git status $(program) >file').cause, 'substitution');
});

test('rejeu JSONL : ventilation exacte par cause et aucune fuite de contenu', async t => {
  const root = temporary(t);
  const commands = [
    'git status 2>&1', 'git status 2>/dev/null', 'git status >/dev/null', 'git status &>/dev/null',
    'git status >PRIVATE_TARGET', 'git status $(PRIVATE_PROGRAM)',
    'for PRIVATE_VAR in PRIVATE_VALUE; do git status; done', 'cat <<PRIVATE_MARKER\nPRIVATE_BODY\nPRIVATE_MARKER',
  ];
  put(root, 'history/session.jsonl', jsonl(commands.flatMap((command, i) => [claude(`c${i}`, command), codex(`x${i}`, 'exec_command', { cmd: command })])));
  const result = await replayHistory(path.join(root, 'history'), root);
  for (const stats of Object.values(result.engines)) {
    assert.equal(stats.total, 8);
    assert.equal(stats.verdicts.allow, 4);
    assert.equal(stats.unsupported, 4);
    assert.deepEqual(stats.unsupportedByCause, { redirection: 1, substitution: 1, structure: 1, heredoc: 1 });
    assert.equal(Object.values(stats.unsupportedByCause).reduce((sum, count) => sum + count, 0), stats.unsupported);
  }
  const rendered = renderReplay(result);
  assert.doesNotMatch(rendered, /PRIVATE|2>&1|dev\/null|git status 2|cat <</u);
  for (const label of ['redirection vers fichier (ou autre redirection non prise en charge)', 'substitution', 'structure shell', 'heredoc']) {
    assert.ok(rendered.includes(`Non analysées — ${label} : 1`));
  }
});

test('formats Claude et Codex : uniquement les appels outils, aucun texte ou résultat exécuté', () => {
  assert.deepEqual(historyCalls(claude('one', 'git status')), [{ engine: 'claude', id: 'one', command: 'git status' }]);
  for (const name of ['exec_command', 'functions.exec_command', 'shell_command']) {
    assert.equal(historyCalls(codex('one', name, { cmd: 'git push' }))[0].command, 'git push');
  }
  assert.equal(historyCalls(codex('one', 'shell', { command: ['bash', '-lc', 'git status'] }))[0].command, 'git status');
  assert.equal(historyCalls(codex('one', 'shell', { command: ['git', 'status'] }))[0].command, "'git' 'status'");
  assert.deepEqual(historyCalls({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'container', input: 'arbitraryJavaScript()' } }), [{ engine: 'codex', id: 'container', container: true }]);
  for (const record of [
    { type: 'user', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm x' } }] } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'git push' } },
    { type: 'response_item', payload: { type: 'function_call', name: 42, arguments: '{}' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'git status' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'rm x' }] } },
  ]) assert.deepEqual(historyCalls(record), []);
});

test('replay JSONL récursif : deux couches, miroirs, compteurs exacts et aucun argument divulgué', async t => {
  const root = temporary(t);
  const histories = path.join(root, 'history');
  put(root, PROJECT_FILES.policy, { version: 1, entries: [entry({ pattern: ['npm', 'run', 'test:gate'], decision: 'allow', riskClass: 'local-reversible', match: ['npm run test:gate'], notMatch: ['npm run deploy'] })] });
  const records = [
    claude('1', 'git status --short PRIVATE_ARGUMENT'),
    claude('2', 'git push origin PRIVATE_BRANCH'),
    claude('3', 'rm -rf PRIVATE_PATH'),
    claude('4', 'unknown-PRIVATE_PROGRAM PRIVATE_VALUE'),
    claude('5', 'rtk npm run test:gate -- PRIVATE_PAYLOAD'),
    claude('6', 'cd /PRIVATE_WORKTREE && git diff --stat'),
    claude('7', 'cat "$(PRIVATE_SUBSTITUTION)"'),
    claude('1', 'duplicate-not-counted'),
  ];
  put(root, 'history/one.jsonl', jsonl(records) + '{"PRIVATE_BROKEN":\n');
  put(root, 'history/sub/two.jsonl', jsonl([
    codex('8', 'exec_command', { cmd: 'git push PRIVATE_REMOTE' }),
    codex('9', 'shell', { command: ['bash', '-lc', 'rg needle PRIVATE_PATH'] }),
    codex('10', 'shell_command', { command: 'sed -n 1p PRIVATE_PATH' }),
    codex('11', 'exec_command', { cmd: 42 }),
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: '12', input: 'PRIVATE_CODE()' } },
  ]));
  put(root, 'history/ignored.txt', 'not jsonl');
  const result = await replayHistory(histories, root);
  assert.equal(result.files, 2);
  assert.equal(result.project, true);
  assert.equal(result.invalidLines, 1);
  assert.equal(result.invalidCalls, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.engines.claude.total, 7);
  assert.deepEqual(result.engines.claude.verdicts, { allow: 3, aucune: 2, prompt: 1, forbidden: 1 });
  assert.equal(result.engines.claude.unsupported, 1);
  assert.deepEqual(result.engines.codex.verdicts, { allow: 1, aucune: 1, prompt: 1, forbidden: 0 });
  assert.equal(result.engines.codex.containers, 1);
  const output = renderReplay(result);
  assert.match(output, /rtk npm run \[…\] : 1/u);
  assert.doesNotMatch(output, /PRIVATE|test:gate|--short|--stat|rm -rf/u);
  assert.equal(output, renderReplay(await replayHistory(histories, root)));
});

test('replay CLI : lecture seule prouvée par les permissions Node et aucune commande complète', t => {
  const root = temporary(t);
  put(root, 'history/session.jsonl', jsonl([claude('1', 'git status --short SECRET_ARG'), claude('2', 'touch MUST_NOT_EXIST'), claude('3', 'git push SECRET_REMOTE')]));
  const before = fs.statSync(path.join(root, 'history/session.jsonl')).mtimeMs;
  const result = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', CLI, 'replay', path.join(root, 'history')], { cwd: root, env: { PATH: root }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /claude : 3 commandes/u);
  assert.match(result.stdout, /socle seul/u);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET|MUST_NOT_EXIST|--short/u);
  assert.deepEqual(fs.readdirSync(root), ['history']);
  assert.equal(fs.statSync(path.join(root, 'history/session.jsonl')).mtimeMs, before);
});

test('le rejeu ne suit aucun lien, refuse .env et masque aussi les erreurs', async t => {
  const root = temporary(t);
  put(root, 'outside.jsonl', jsonl([claude('1', 'rm x')]));
  fs.mkdirSync(path.join(root, 'history'));
  fs.symlinkSync(path.join(root, 'outside.jsonl'), path.join(root, 'history/link.jsonl'));
  fs.symlinkSync(path.join(root, 'history'), path.join(root, 'link'));
  assert.equal((await replayHistory(path.join(root, 'history'), root)).files, 0);
  await assert.rejects(replayHistory(path.join(root, 'link'), root), /symbolique/u);
  await assert.rejects(replayHistory(path.join(root, '.env.private'), root), /\.env/u);
  const error = cli(root, ['replay', path.join(root, 'PRIVATE_NONEXISTENT_COMMAND')]);
  assert.equal(error.status, 1);
  assert.doesNotMatch(error.stdout + error.stderr, /PRIVATE_NONEXISTENT_COMMAND/u);
  assert.equal(cli(root, ['replay']).status, 1);
});

test('les familles proviennent d’un vocabulaire fermé, jamais des arguments ou noms libres', () => {
  assert.equal(commandFamily('git -C /private/worktree status'), 'git -C');
  assert.equal(commandFamily('npm run SECRET_SCRIPT'), 'npm run');
  assert.equal(commandFamily('SECRET_PROGRAM arg'), 'autre');
  assert.equal(commandFamily('rtk proxy SECRET_PROGRAM arg'), 'rtk proxy');
  assert.equal(commandFamily('gh SECRET_SUBCOMMAND arg'), 'gh');
  for (const name of ['constructor', 'toString', '__proto__']) assert.equal(commandFamily(name), 'autre');
});
