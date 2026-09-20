import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  VERSION, PROJECT_FILES, expandEntries, generateCodex, decisionFor, decisionForCommand,
  buildProject, checkProject, tokenize,
} from '../lib/generate.mjs';
import { initProject, readCore } from '../lib/system.mjs';
import { temporary, put, policy, entry, ROOT } from './helpers.mjs';

const core = readCore();
const prefixes = ['', 'rtk ', 'rtk proxy '];
const sourceText = fs.readFileSync(path.join(ROOT, 'core-policy.json'), 'utf8');
const sha256 = text => createHash('sha256').update(text).digest('hex');
function standalone(root, args = ['check']) {
  return spawnSync(process.execPath, [PROJECT_FILES.generator, ...args], { cwd: root, encoding: 'utf8', env: { PATH: root } });
}
const script = (name, overrides = {}) => entry({
  pattern: ['npm', 'run', name], decision: 'allow', riskClass: 'local-reversible',
  match: [`npm run ${name}`], notMatch: ['npm run unknown'], ...overrides,
});

test('socle : aucune restriction Codex read-only ou local-reversible, miroirs compris', () => {
  for (const rule of expandEntries(core)) {
    if ((rule.engines ?? ['codex', 'claude']).includes('codex') === false) continue;
    if (['prompt', 'forbidden'].includes(rule.decision)) {
      assert.equal(['read-only', 'local-reversible'].includes(rule.riskClass), false, JSON.stringify(rule.pattern));
    }
  }
  for (const prefix of prefixes) {
    for (const command of ['rg --pre program needle src', 'sed -i 1d file', 'rtk grep --pre program needle src']) {
      assert.equal(decisionFor(core, prefix + command), command.startsWith('rg ') || (!prefix && command.startsWith('rtk grep ')) ? 'allow' : undefined, prefix + command);
      assert.equal(decisionFor(core, prefix + command, 'claude'), command.startsWith('sed ') ? 'prompt' : 'forbidden', prefix + command);
    }
    for (const engine of ['codex', 'claude']) {
      assert.equal(decisionFor(core, prefix + 'npm ci', engine), 'allow');
      for (const command of ['npm audit fix', 'git restore file', 'git worktree remove sibling']) {
        assert.equal(decisionFor(core, prefix + command, engine), 'prompt', prefix + command);
      }
    }
  }
});

test('session Codex courante : lectures confinées sans règle, filtres explicitement autorisés', () => {
  // Lire les règles produites, pour détecter aussi une régression du filtrage engines.
  const output = generateCodex(core);
  const rules = [...output.matchAll(/pattern=(\[[^\n]+\]),\n\s*decision="(allow|prompt|forbidden)"/gu)]
    .map(([, pattern, decision]) => ({ pattern: JSON.parse(pattern), decision }));
  assert.ok(rules.length > 100);
  const verdict = command => {
    const argv = tokenize(command);
    const decisions = rules.filter(rule => rule.pattern.every((token, index) => argv[index] === token)).map(rule => rule.decision);
    return ['forbidden', 'prompt', 'allow'].find(decision => decisions.includes(decision));
  };
  for (const prefix of prefixes) {
    for (const command of [
      'sed -n 1,20p AGENTS.md', "sed -n '1770,1790p' AGENTS.md",
      'cat README.md', 'ls -la docs', 'git diff --stat', 'git log --oneline -5',
      'sed -i 1d file',
    ]) assert.equal(verdict(prefix + command), undefined, prefix + command);
    for (const command of ['rg -n foo src', 'rg --pre program needle src']) assert.equal(verdict(prefix + command), 'allow');
    assert.equal(verdict(prefix + 'git push'), 'prompt');
    assert.equal(verdict(prefix + 'gh pr merge'), 'prompt');
    assert.equal(verdict(prefix + 'rm -rf x'), 'forbidden');
  }
});

test('init et upgrade : copie exacte du socle versionné, idempotence et source préservée', t => {
  const root = temporary(t);
  initProject(root);
  const localSource = JSON.stringify({ version: 1, entries: [script('test:gate')] }, null, 4) + '\n';
  put(root, PROJECT_FILES.policy, localSource);
  const owned = [PROJECT_FILES.generator, PROJECT_FILES.brief, PROJECT_FILES.core, PROJECT_FILES.coreVersion];
  const before = owned.map(relative => ({ relative, text: fs.readFileSync(path.join(root, relative), 'utf8'), mtime: fs.statSync(path.join(root, relative)).mtimeMs }));
  assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.core), 'utf8'), sourceText);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, PROJECT_FILES.coreVersion), 'utf8')), { version: VERSION, sha256: sha256(sourceText) });
  initProject(root);
  initProject(root, { upgrade: true });
  for (const file of before) {
    assert.equal(fs.readFileSync(path.join(root, file.relative), 'utf8'), file.text);
    assert.equal(fs.statSync(path.join(root, file.relative)).mtimeMs, file.mtime);
    put(root, file.relative, '// ancienne copie\n');
  }
  assert.match(initProject(root), /init --upgrade/);
  for (const file of before) assert.equal(fs.readFileSync(path.join(root, file.relative), 'utf8'), '// ancienne copie\n');
  initProject(root, { upgrade: true });
  for (const file of before) assert.equal(fs.readFileSync(path.join(root, file.relative), 'utf8'), file.text);
  assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.policy), 'utf8'), localSource);
  buildProject(root);
  const checked = standalone(root);
  assert.equal(checked.status, 0, checked.stderr);
});

test('check et API : dérive du socle ou de sa version refusée, même avec une empreinte forgée', t => {
  const root = temporary(t);
  initProject(root);
  buildProject(root);
  const outputs = [PROJECT_FILES.codex, PROJECT_FILES.claude].map(relative => [relative, fs.readFileSync(path.join(root, relative), 'utf8')]);
  const variants = [
    () => put(root, PROJECT_FILES.core, sourceText + '\n'),
    () => put(root, PROJECT_FILES.coreVersion, { version: '0.0.0', sha256: sha256(sourceText) }),
    () => {
      const weaker = JSON.stringify({ version: 1, entries: [] }) + '\n';
      put(root, PROJECT_FILES.core, weaker);
      put(root, PROJECT_FILES.coreVersion, { version: VERSION, sha256: sha256(weaker) });
    },
    () => fs.unlinkSync(path.join(root, PROJECT_FILES.core)),
    () => fs.unlinkSync(path.join(root, PROJECT_FILES.coreVersion)),
  ];
  for (const mutate of variants) {
    mutate();
    assert.throws(() => checkProject(root), /socle embarqué/);
    assert.throws(() => buildProject(root), /socle embarqué/);
    assert.throws(() => decisionForCommand(root, 'git push', 'codex'), /socle embarqué/);
    const checked = standalone(root);
    assert.equal(checked.status, 1);
    assert.match(checked.stderr, /socle embarqué/);
    for (const [relative, text] of outputs) assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), text);
    initProject(root, { upgrade: true });
    assert.doesNotThrow(() => checkProject(root));
  }
});

test('decisionForCommand : deux couches, moteurs, miroirs et aucune décision par défaut', t => {
  const root = temporary(t);
  initProject(root);
  put(root, PROJECT_FILES.policy, { version: 1, entries: [script('test:gate'), script('claude-only', { engines: ['claude'] })] });
  for (const engine of ['codex', 'claude']) {
    for (const prefix of prefixes) {
      for (const [command, decision] of [['git push', 'prompt'], ['rm -rf x', 'forbidden'], ['npm run test:gate', 'allow'], ['unknown-command', undefined]]) {
        assert.equal(decisionForCommand(root, prefix + command, engine), decision, `${engine}: ${prefix}${command}`);
      }
    }
  }
  assert.equal(decisionForCommand(root, 'rtk npm run claude-only', 'claude'), 'allow');
  assert.equal(decisionForCommand(root, 'rtk npm run claude-only', 'codex'), undefined);
  assert.equal(decisionForCommand(root, 'rg foo src', 'codex'), 'allow');
  assert.equal(decisionForCommand(root, 'rg foo src', 'claude'), 'allow');
  assert.equal(decisionForCommand(root, 'rtk rg --pre program needle src', 'claude'), 'forbidden');
  // Désactiver les miroirs du projet ne retire pas les miroirs du socle.
  put(root, PROJECT_FILES.policy, policy([script('test:gate')]));
  assert.equal(decisionForCommand(root, 'rtk npm run test:gate', 'codex'), undefined);
  assert.equal(decisionForCommand(root, 'rtk git push', 'codex'), 'prompt');
});

test('decisionForCommand : la décision la plus stricte gagne entre couches et gardes', t => {
  const root = temporary(t);
  initProject(root);
  const entries = [
    entry({ pattern: ['git', 'push'], decision: 'allow', riskClass: 'local-reversible', match: ['git push origin main'], notMatch: ['git status'] }),
    entry({ pattern: ['rm'], match: ['rm file'], notMatch: ['git status'] }),
    entry({ pattern: ['git', 'add'], decision: 'forbidden', match: ['git add file'], notMatch: ['git status'] }),
    entry({ pattern: ['git', 'diff', '--output=file'], decision: 'allow', riskClass: 'read-only', engines: ['claude'], match: ['git diff --output=file'], notMatch: ['git diff --stat'] }),
    entry({ pattern: ['git', 'branch', '-D'], decision: 'allow', riskClass: 'local-reversible', engines: ['claude'], match: ['git branch -D x'], notMatch: ['git branch --list'] }),
  ];
  for (const ordered of [entries, entries.toReversed()]) {
    put(root, PROJECT_FILES.policy, { version: 1, entries: ordered });
    for (const engine of ['codex', 'claude']) {
      for (const prefix of prefixes) {
        assert.equal(decisionForCommand(root, prefix + 'git push origin main', engine), 'prompt');
        assert.equal(decisionForCommand(root, prefix + 'rm file', engine), 'forbidden');
        assert.equal(decisionForCommand(root, prefix + 'git add file', engine), 'forbidden');
      }
    }
    assert.equal(decisionForCommand(root, 'git diff --output=file', 'claude'), 'forbidden');
    assert.equal(decisionForCommand(root, 'git branch -D x', 'claude'), 'prompt');
  }
});

test('import autonome depuis un consommateur du dépôt, sans outil installé ni accès à ses fichiers', t => {
  const root = temporary(t);
  initProject(root);
  put(root, PROJECT_FILES.policy, { version: 1, entries: [script('test:gate')] });
  put(root, 'consume.mjs', `
import { decisionForCommand } from './scripts/agent-policy/generate.mjs';
const root = process.cwd();
const result = ['git push', 'rm -rf x', 'npm run test:gate', 'rtk git push', 'unknown-command']
  .map(command => decisionForCommand(root, command, 'codex'));
console.log(JSON.stringify(result));
`);
  for (const invocation of [['consume.mjs'], ['--input-type=module', '-']]) {
    const result = spawnSync(process.execPath, [
      '--permission', `--allow-fs-read=${root}`, ...invocation,
    ], { cwd: root, env: { PATH: root }, encoding: 'utf8', input: fs.readFileSync(path.join(root, 'consume.mjs'), 'utf8') });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['prompt', 'forbidden', 'allow', 'prompt', null]);
  }
  assert.equal(fs.existsSync(path.join(root, '.codex')), false, 'l’import ne génère pas de réglages');
});

test('API : sources invalides, liens, moteur inconnu et syntaxe shell refusés', t => {
  const root = temporary(t);
  const outside = temporary(t);
  initProject(root);
  assert.throws(() => decisionForCommand(root, 'git push', 'unknown'), /Moteur/);
  for (const engine of ['codex', 'claude']) {
    for (const command of ['git status && rm file', 'echo ok; git push', 'cat README.md > file', 'X=1 command']) {
      assert.throws(() => decisionForCommand(root, command, engine), /Exemple/);
    }
  }
  put(root, PROJECT_FILES.policy, { version: 1, entries: [script('test:gate', { match: ['npm run other'] })] });
  assert.throws(() => decisionForCommand(root, 'git push', 'codex'), /incohérent/);
  fs.unlinkSync(path.join(root, PROJECT_FILES.policy));
  assert.throws(() => decisionForCommand(root, 'git push', 'codex'), /Politique absente/);
  put(outside, 'policy.json', policy());
  fs.symlinkSync(path.join(outside, 'policy.json'), path.join(root, PROJECT_FILES.policy));
  assert.throws(() => decisionForCommand(root, 'git push', 'codex'), /symbolique/);
});

test('init vérifie aussi les cibles du socle avant de déposer les fichiers', t => {
  for (const relative of [PROJECT_FILES.core, PROJECT_FILES.coreVersion]) {
    const root = temporary(t);
    const outside = temporary(t);
    put(outside, 'file.json', '{}\n');
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.symlinkSync(path.join(outside, 'file.json'), path.join(root, relative));
    assert.throws(() => initProject(root), /symbolique/);
    assert.equal(fs.existsSync(path.join(root, PROJECT_FILES.generator)), false);
    assert.equal(fs.existsSync(path.join(root, PROJECT_FILES.policy)), false);
    assert.equal(fs.readFileSync(path.join(outside, 'file.json'), 'utf8'), '{}\n');
  }
});
