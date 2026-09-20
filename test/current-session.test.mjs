import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  assertClaudeAllowPatterns, generatePermissions, generateCodex, decisionFor, matchesClaude,
  validatePolicy, validateExamples, expandEntries, buildProject, checkProject, PROJECT_FILES,
  DEFAULT_COMMAND_PREFIXES,
} from '../lib/generate.mjs';
import { readCore, initProject } from '../lib/system.mjs';
import { entry, policy, temporary, put, ROOT } from './helpers.mjs';

const core = readCore();
const permissions = generatePermissions(core);
const prefixes = ['', 'rtk ', 'rtk proxy '];
function claudeDecision(command, settings = permissions) {
  for (const [key, decision] of [['deny', 'forbidden'], ['ask', 'prompt'], ['allow', 'allow']]) {
    if (settings[key].some(permission => matchesClaude(permission, command, { shellText: true }))) return decision;
  }
}

test('session courante : lectures Claude, tests RTK et mutations soumises à accord', () => {
  for (const command of [
    'git diff --stat', 'git log --oneline -8', 'git show abc:path',
    'git branch --no-merged origin/main', 'git rev-parse --short HEAD',
    'rtk git diff --stat', 'rtk tsc --noEmit', 'rtk vitest run', 'rtk vitest',
    'pwd', 'mkdir -p docs/plans',
  ]) assert.equal(claudeDecision(command), 'allow', command);
  for (const command of ['git branch -D x', 'git push', 'rtk git push']) {
    assert.equal(claudeDecision(command), 'prompt', command);
  }
  const codex = generateCodex(core);
  const gitReads = core.entries.filter(rule => rule.pattern?.[0] === 'git' && rule.engines?.includes('claude') && rule.decision === 'allow');
  assert.equal(gitReads.length, 15);
  for (const rule of gitReads) {
    assert.deepEqual(rule.engines, ['claude']);
    for (const prefix of [[], ...DEFAULT_COMMAND_PREFIXES]) {
      const pattern = [...prefix, ...rule.pattern];
      assert.equal(codex.includes(`pattern=${JSON.stringify(pattern)},`), false, pattern.join(' '));
      for (const example of rule.match) {
        const command = [...prefix, example].join(' ');
        assert.equal(decisionFor(core, command), undefined, command);
        assert.equal(claudeDecision(command), 'allow', command);
      }
    }
  }
  for (const rule of core.entries) {
    assert.equal(['git diff --', 'git diff --cached --', 'git log --'].includes(rule.pattern?.join(' ')), false);
  }
  for (const command of ['git add file', 'git commit -m message', 'lsof -i :3000', 'rtk tsc --noEmit', 'rtk vitest', 'rtk vitest run', 'rtk playwright test']) {
    assert.equal(decisionFor(core, command), 'allow', command);
    assert.equal(claudeDecision(command), 'allow', command);
  }
});

test('git branch : création autorisée, mutations initiales et suffixes en ask, miroirs compris', () => {
  for (const prefix of prefixes) {
    for (const option of ['-d', '-D', '-m', '-M', '-c', '-C', '--set-upstream-to=origin/main', '--unset-upstream', '-u', '-f', '--delete', '--move', '--copy', '--force']) {
      for (const command of [`git branch ${option} feature`, `git branch --verbose ${option} feature`]) {
        assert.equal(claudeDecision(prefix + command), 'prompt', prefix + command);
        assert.equal(decisionFor(core, prefix + command, 'claude'), 'prompt');
      }
    }
    for (const command of ['git branch feature', 'git branch --list', 'git branch --no-merged origin/main', 'git branch --format=%(refname)']) {
      assert.equal(claudeDecision(prefix + command), 'allow', prefix + command);
    }
  }
});

test('lectures git : gardes des options libres prioritaires sur allow', () => {
  const reads = core.entries.filter(rule => rule.pattern?.[0] === 'git' && rule.decision === 'allow' && rule.engines?.[0] === 'claude');
  for (const prefix of prefixes) {
    for (const rule of reads) {
      const command = prefix + rule.pattern.join(' ');
      for (const option of ['--output=/outside/report', '--ext-diff', '--upload-pack=custom-command', '-c name=value']) {
        const expected = option.startsWith('-c') ? 'prompt' : 'forbidden';
        for (const middle of ['', '--verbose ']) {
          assert.equal(claudeDecision(`${command} ${middle}${option}`), expected, `${command} ${middle}${option}`);
        }
      }
    }
    for (const option of ['--open-files-in-pager=program', '-Oprogram']) {
      assert.equal(claudeDecision(`${prefix}git grep ${option} needle`), 'forbidden');
      assert.equal(claudeDecision(`${prefix}git grep needle ${option}`), 'forbidden');
    }
  }
});

test('git remote -v : un suffixe de mutation ne bénéficie pas de l’allow de lecture', () => {
  for (const prefix of prefixes) {
    for (const operation of ['add', 'rename', 'remove', 'rm', 'set-head', 'set-branches', 'set-url', 'prune', 'update']) {
      for (const middle of ['', '--verbose ']) {
        assert.equal(claudeDecision(`${prefix}git remote -v ${middle}${operation} target`), 'prompt');
      }
    }
    assert.equal(claudeDecision(`${prefix}git remote -v`), 'allow');
    assert.equal(claudeDecision(`${prefix}git remote -v get-url origin`), 'allow');
  }
});

test('git -C : exception Claude gardée, aucune règle Codex', () => {
  for (const prefix of prefixes) {
    for (const command of ['git -C /x status', 'git -C ../worktree diff --stat', 'git -C /x push origin status', 'git -C /x branch -D status', 'git -C /x gh pr merge status', 'git -C /x rm status']) {
      assert.equal(claudeDecision(prefix + command), ['git -C /x status', 'git -C ../worktree diff --stat'].includes(command) ? 'allow' : 'prompt', prefix + command);
      assert.equal(decisionFor(core, prefix + command), undefined, prefix + command);
    }
  }
  assert.ok(permissions.allow.some(permission => permission.includes('git -C ')));
});

test('utilitaires et écritures relatives : Claude seul, chemins exclus même sous RTK', () => {
  for (const prefix of prefixes) {
    for (const command of ['pwd', 'date', 'which node', 'node --version', 'npm --version', 'codex --version', 'rtk --version', 'mkdir -p docs/plans', 'cp README.md docs/copy.md', 'touch docs/notes.md']) {
      assert.equal(claudeDecision(prefix + command), 'allow', prefix + command);
      assert.equal(decisionFor(core, prefix + command), undefined, prefix + command);
    }
    for (const command of [
      'mkdir -p /outside', 'mkdir -p docs/../outside', 'mkdir -p "docs/../../outside"',
      'mkdir -p .env.d', 'mkdir -p ~/outside', 'mkdir -p $HOME/outside',
      'cp /outside/source docs/dest', 'cp README.md /outside/dest',
      'cp "README.md" "/outside/quoted path"', "cp README.md '/outside/dest'",
      'cp README.md --target-directory=/outside', 'cp -t/outside README.md',
      'cp .env README.md', 'cp README.md docs/.env.local', 'cp README.md docs/../outside',
      'touch /outside/file', 'touch docs/.env.example', 'touch ../outside',
      'touch -r/outside/file docs/file', 'touch docs/\\.env', 'touch `program`',
    ]) assert.ok(['forbidden', 'prompt'].includes(claudeDecision(prefix + command)), prefix + command);
  }
  for (const name of ['mkdir', 'cp', 'touch']) {
    const source = core.entries.find(rule => rule.pattern?.[0] === name);
    assert.throws(() => validatePolicy(policy([{ ...source, engines: ['codex', 'claude'] }])));
    assert.throws(() => validatePolicy(policy([{ ...source, claudeDeny: [] }])), /garde Claude obligatoire/);
  }
});

// Relevé avec `rtk rewrite` 0.45.0 ; les tests restent hors ligne et sans dépendance RTK.
test('formes natives produites par le hook RTK : même décision que la commande source', () => {
  const fixtures = [
    ['git status', 'rtk git status', undefined, 'allow'],
    ['git diff --stat', 'rtk git diff --stat', undefined, 'allow'],
    ['git push origin main', 'rtk git push origin main', 'prompt', 'prompt'],
    ['gh pr view 1', 'rtk gh pr view 1', 'allow', 'allow'],
    ['gh pr merge 1', 'rtk gh pr merge 1', 'prompt', 'prompt'],
    ['docker ps', 'rtk docker ps', 'allow', 'allow'],
    ['npx tsc --noEmit', 'rtk tsc --noEmit', 'allow', 'allow'],
    ['npx vitest run', 'rtk vitest', 'allow', 'allow'],
    ['npx vitest run test/example.test.ts', 'rtk vitest test/example.test.ts', 'allow', 'allow'],
    ['npx playwright test', 'rtk playwright test', 'allow', 'allow'],
    ['rg needle src', 'rtk rg needle src', 'allow', 'allow'],
    ['find -delete file', 'rtk find -delete file', 'forbidden', 'forbidden'],
    ['ls src', 'rtk ls src', undefined, 'allow'],
    ['cat README.md', 'rtk read README.md', undefined, 'allow'],
    ['grep needle src', 'rtk grep needle src', 'allow', 'allow'],
    ['wc -l README.md', 'rtk wc -l README.md', 'allow', 'allow'],
  ];
  for (const [before, after, codex, claude] of fixtures) {
    for (const command of [before, after]) {
      assert.equal(decisionFor(core, command), codex, command);
      assert.equal(claudeDecision(command), claude, command);
    }
  }
  assert.equal(decisionFor(core, 'tail -n 20 README.md'), 'allow');
  assert.equal(decisionFor(core, 'rtk read README.md --tail-lines 20'), undefined);
  assert.equal(claudeDecision('rtk read README.md --tail-lines 20'), 'allow');
  for (const command of ['rtk tsc', 'rtk playwright install', 'rtk npm run unknown', 'rtk test program', 'rtk proxy unknown']) {
    assert.notEqual(decisionFor(core, command), 'allow', command);
    assert.notEqual(claudeDecision(command), 'allow', command);
  }
});

test('une couche de dépôt hérite de RTK sans redéclarer commandPrefixes, copie autonome comprise', t => {
  const root = temporary(t);
  initProject(root);
  const source = { version: 1, entries: [
    entry({ pattern: ['npm', 'run', 'test:gate'], decision: 'allow', riskClass: 'local-reversible', match: ['npm run test:gate'], notMatch: ['npm run deploy'] }),
    entry({ pattern: ['npm', 'run', 'deploy'], match: ['npm run deploy'], notMatch: ['npm run test:gate'] }),
    entry({ pattern: ['npm', 'run', 'destroy'], decision: 'forbidden', match: ['npm run destroy'], notMatch: ['npm run test:gate'] }),
  ] };
  put(root, PROJECT_FILES.policy, source);
  buildProject(root);
  const codex = fs.readFileSync(path.join(root, PROJECT_FILES.codex), 'utf8');
  const settings = JSON.parse(fs.readFileSync(path.join(root, PROJECT_FILES.claude), 'utf8')).permissions;
  for (const prefix of prefixes) {
    for (const [name, decision] of [['test:gate', 'allow'], ['deploy', 'prompt'], ['destroy', 'forbidden']]) {
      const command = `${prefix}npm run ${name}`;
      assert.equal(decisionFor(source, command), decision, command);
      assert.equal(claudeDecision(command, settings), decision, command);
      assert.ok(codex.includes(`pattern=${JSON.stringify(command.split(' '))}`));
    }
    for (const command of [`${prefix}npm run`, `${prefix}npm run unknown`]) {
      assert.equal(decisionFor(source, command), undefined);
      assert.equal(claudeDecision(command, settings), undefined);
    }
  }
  const standalone = spawnSync(process.execPath, [PROJECT_FILES.generator, 'check'], { cwd: root, env: { PATH: root }, encoding: 'utf8' });
  assert.equal(standalone.status, 0, standalone.stderr);
  initProject(root, { upgrade: true });
  buildProject(root);
  assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.codex), 'utf8'), codex);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, PROJECT_FILES.policy), 'utf8')), source);
  assert.equal(checkProject(root).count, 18);
  const directOnly = { ...source, commandPrefixes: [] };
  assert.equal(decisionFor(directOnly, 'rtk npm run test:gate'), undefined);
  assert.deepEqual(expandEntries(directOnly), source.entries);
});

test('claudeAsk : validation, miroirs et priorité deny > ask > allow', () => {
  const branch = core.entries.find(rule => rule.pattern?.join(' ') === 'git branch');
  for (const claudeAsk of [[], null, [{ pattern: '*', match: ['git branch -D x'], notMatch: ['git branch'] }]]) {
    assert.throws(() => validatePolicy(policy([{ ...branch, claudeAsk }])));
  }
  assert.throws(() => validateExamples(policy([{ ...branch, claudeAsk: [{ pattern: 'git branch * -D*', match: ['git branch'], notMatch: ['git branch --verbose -D x'] }] }])), /incohérent/);
  const source = { version: 1, entries: [branch] };
  for (const prefix of prefixes) {
    assert.equal(decisionFor(source, `${prefix}git branch -D x`, 'claude'), 'prompt');
    assert.equal(decisionFor(source, `${prefix}git branch -D x --output=file`, 'claude'), 'forbidden');
  }
  assert.equal(generateCodex(source).includes('prefix_rule('), false);
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'policy.schema.json'), 'utf8'));
  assert.equal(schema.$defs.entry.properties.claudeAsk.items.$ref, '#/$defs/claudeDeny');
  assert.deepEqual(schema.properties.commandPrefixes.default, DEFAULT_COMMAND_PREFIXES);
  const guardPattern = new RegExp(schema.$defs.claudeDeny.properties.pattern.pattern, 'u');
  for (const rule of core.entries) {
    for (const guard of [...(rule.claudeAsk ?? []), ...(rule.claudeDeny ?? [])]) assert.ok(guardPattern.test(guard.pattern), guard.pattern);
  }
});

function hasInternalWildcard(permission) {
  return permission.slice(5, -1).replace(/(?: |:)\*$/u, '').includes('*');
}
function assertNoWildcardInjection(settings, injections = ['git push', 'gh pr merge', 'rm']) {
  for (const permission of settings.allow.filter(hasInternalWildcard)) {
    for (const injection of injections) {
      const command = permission.slice(5, -1).replace(/:\*$/u, '').replaceAll('*', injection);
      assert.ok(matchesClaude(permission, command, { shellText: true }));
      assert.notEqual(claudeDecision(command, settings), 'allow', `${permission} englobe ${command}`);
    }
  }
}

test('seule exception interne git -C gardée ; aucune injection de mutation autorisée', () => {
  assertNoWildcardInjection(permissions);
  assert.ok(permissions.allow.filter(hasInternalWildcard).length > 0);
  for (const permission of permissions.allow.filter(hasInternalWildcard)) assert.match(permission, /git -C \* /u);
  let exercised = 0;
  for (const rule of expandEntries(core)) {
    for (const guard of [...(rule.claudeAsk ?? []), ...(rule.claudeDeny ?? [])]) {
      const permission = `Bash(${guard.pattern})`;
      if (!hasInternalWildcard(permission)) continue;
      for (const injection of ['git push', 'gh pr merge', 'rm']) {
        const command = guard.pattern.replaceAll('*', ` ${injection} `);
        assert.ok(matchesClaude(permission, command, { shellText: true }));
        assert.notEqual(claudeDecision(command), 'allow', command);
        exercised += 1;
      }
    }
  }
  assert.ok(exercised > 100);
});

test('le test d’injection et le générateur refusent les régressions à joker interne', () => {
  for (const permission of ['Bash(git -C * status)', 'Bash(git * status)', 'Bash(rtk * git status)']) {
    const mutant = { allow: [permission], ask: [], deny: [] };
    for (const injection of ['git push', 'gh pr merge', 'rm']) {
      assert.throws(() => assertNoWildcardInjection(mutant, [injection]), /englobe/);
    }
    assert.throws(() => assertClaudeAllowPatterns(mutant), /pas de joker interne/);
  }
  assert.throws(() => assertClaudeAllowPatterns({ allow: ['Bash(git * status:*)'] }), /pas de joker interne/);
  for (const pattern of [['git', '-C', '*', 'status'], ['git', '*', 'status'], ['rtk', '*', 'git', 'status']]) {
    assert.throws(() => generatePermissions(policy([entry({ pattern, decision: 'allow', riskClass: 'read-only' })])), /tokens littéraux/);
  }
  assert.equal(matchesClaude('Bash(git -C * status)', 'git -C /x push origin status'), true);
  assert.notEqual(claudeDecision('git -C /x push origin status'), 'allow');
});
