import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GIT_C_OPTIONS, optionGuardPatterns, generatePermissions, generateCodex,
  compileClaudePermission, decisionFor,
} from '../lib/generate.mjs';
import { readCore } from '../lib/system.mjs';

const core = readCore();
const permissions = generatePermissions(core);
const groups = ['deny', 'ask', 'allow'].map(key => permissions[key].map(compileClaudePermission));
const verdict = command => ['forbidden', 'prompt', 'allow'][groups.findIndex(matchers => matchers.some(match => match(command)))];
const prefixes = ['', 'rtk ', 'rtk proxy '];

test('parité Claude : add, commit et fetch avec ou sans -C, sans règle Codex pour -C', () => {
  const commands = ['add src/file', 'add --all', 'add --edit', 'commit -m message', 'commit --amend --no-edit', 'commit --edit', 'commit --gpg-sign=key', 'fetch', 'fetch --prune origin'];
  for (const prefix of prefixes) for (const command of commands) {
    const direct = `${prefix}git ${command}`;
    assert.equal(verdict(direct), 'allow', direct);
    assert.equal(decisionFor(core, direct, 'codex'), 'allow', direct);
    for (const worktree of ['/x', '../sibling', '"/worktree with spaces"']) {
      const changed = `${prefix}git -C ${worktree} ${command}`;
      assert.equal(verdict(changed), verdict(direct), changed);
      assert.equal(decisionFor(core, changed, 'claude'), 'allow');
      assert.equal(decisionFor(core, changed, 'codex'), undefined);
    }
  }
  const rules = [...generateCodex(core).matchAll(/pattern=(\[[^\n]+\]),/gu)].map(([, pattern]) => JSON.parse(pattern));
  assert.equal(rules.some(argv => argv.some((token, i) => token === 'git' && argv[i + 1] === '-C')), false);
});

test('options libres : ask Claude identique avec ou sans -C, y compris un argument légitime', () => {
  for (const prefix of prefixes) for (const name of ['add', 'commit', 'fetch']) {
    for (const option of GIT_C_OPTIONS) for (const suffix of [`${option}=program`, `argument ${option}=program`, `${option} program`, `argument ${option} program`]) {
      const direct = `${prefix}git ${name} ${suffix}`;
      const changed = `${prefix}git -C /x ${name} ${suffix}`;
      assert.equal(verdict(direct), 'prompt', direct);
      assert.equal(verdict(changed), 'prompt', changed);
      assert.equal(decisionFor(core, direct, 'codex'), 'allow', direct);
      assert.equal(decisionFor(core, changed, 'codex'), undefined);
    }
    for (const option of GIT_C_OPTIONS) {
      assert.equal(verdict(`${prefix}git ${name} docs/name${option}.txt`), 'allow');
      assert.equal(verdict(`${prefix}git -C /x ${name} docs/name${option}.txt`), 'allow');
      assert.equal(verdict(`${prefix}git -C /x ${option}=program ${name}`), 'prompt');
    }
  }
  for (const prefix of prefixes) for (const middle of ['', '-C /x ']) {
    assert.equal(verdict(`${prefix}git ${middle}commit -m "documenter --upload-pack=program"`), 'prompt');
    assert.equal(verdict(`${prefix}git ${middle}commit -m "documenter --output=file"`), 'prompt');
  }
  // Le retrait des gardes génériques ne retire pas celles de worktree/remote add.
  for (const prefix of prefixes) for (const command of ['git -C /x worktree add /y', 'git -C /x remote add origin target']) {
    assert.equal(verdict(prefix + command), 'prompt');
  }
});

test('gardes git -C obligatoires : aucune suppression ou transformation en deny des options ambiguës', () => {
  for (const pattern of GIT_C_OPTIONS.flatMap(option => optionGuardPatterns('git -C', option))) {
    const mutant = structuredClone(core);
    const anchor = mutant.entries.find(e => e.claudePattern === 'git -C * status');
    const guard = anchor.claudeAsk.find(g => g.pattern === pattern);
    assert.ok(guard);
    anchor.claudeAsk = anchor.claudeAsk.filter(g => g !== guard);
    assert.throws(() => generatePermissions(mutant), /exception git -C gardée/);
    anchor.claudeDeny = [guard];
    assert.throws(() => generatePermissions(mutant), /exception git -C gardée/);
  }
});

test('mutations Claude protégées et exception Codex worktree add conservée', () => {
  for (const prefix of prefixes) for (const command of [
    'push origin feature', 'pull --ff-only', 'merge main', 'rebase main', 'reset --soft HEAD',
    'checkout feature', 'stash push', 'worktree add ../sibling', 'worktree remove ../sibling',
    'worktree prune', 'worktree move old new', 'worktree repair', 'worktree lock ../sibling', 'worktree unlock ../sibling',
  ]) for (const middle of ['', '-C /x ']) {
    // Sans règle explicite, Claude demande l'accord par défaut.
    assert.equal(verdict(`${prefix}git ${middle}${command}`) ?? 'prompt', 'prompt');
  }
  for (const prefix of prefixes) {
    assert.equal(verdict(`${prefix}git worktree add ../sibling`), 'prompt');
    assert.equal(decisionFor(core, `${prefix}git worktree add ../sibling`), 'allow');
    for (const command of ['push', 'pull', 'merge', 'worktree remove sibling']) assert.equal(decisionFor(core, `${prefix}git ${command}`), 'prompt');
    for (const command of ['reset --hard HEAD', 'checkout -- file']) assert.equal(verdict(`${prefix}git ${command}`), 'forbidden');
  }
});

test('risques Git explicitement acceptés : éditeur, signature et upload-pack Codex', () => {
  for (const name of ['add', 'commit']) {
    const rule = core.entries.find(e => e.pattern?.join(' ') === `git ${name}`);
    assert.match(rule.residualRisk, /--edit.*éditeur configuré/u);
    assert.match(rule.residualRisk, /--gpg-sign.*programme de signature configuré/u);
    assert.match(rule.residualRisk, /préconfigurés par le user/u);
  }
  const fetch = core.entries.find(e => e.pattern?.join(' ') === 'git fetch');
  assert.match(fetch.residualRisk, /--upload-pack.*programme/u);
  assert.match(fetch.residualRisk, /pas être filtrée par préfixe/u);
  for (const prefix of prefixes) {
    assert.equal(decisionFor(core, `${prefix}git fetch --upload-pack=program`), 'allow');
    assert.equal(verdict(`${prefix}git fetch --upload-pack=program`), 'prompt');
    assert.equal(verdict(`${prefix}git -C /x fetch origin --upload-pack=program`), 'prompt');
  }
});
