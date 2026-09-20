import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  validatePolicy, expandEntries, decisionFor, generatePermissions,
  buildProject, checkProject, decisionForCommand, PROJECT_FILES,
} from '../lib/generate.mjs';
import { readCore, initProject } from '../lib/system.mjs';
import { temporary, put, policy, entry } from './helpers.mjs';

const refusalRisks = ['destructive-program', 'remote-publication', 'cloud-mutation', 'paid-provider', 'shared-local-state', 'arbitrary-execution'];
const allowRisks = ['read-only', 'local-reversible'];
const schema = JSON.parse(fs.readFileSync(new URL('../policy.schema.json', import.meta.url), 'utf8'));
const core = readCore();
const sample = (decision, riskClass, engines) => entry({
  pattern: ['gh', 'pr', 'view'], decision, riskClass,
  match: ['gh pr view 12'], notMatch: ['gh pr merge 12'],
  ...(engines ? { engines } : {}),
});

// Évaluer les contraintes ajoutées au schéma, sans dépendance ni connaissance
// des décisions/risques. Tout nouveau mot-clé doit être pris en charge explicitement.
function acceptsConstraint(constraint, value) {
  return Object.entries(constraint).every(([keyword, rule]) => {
    switch (keyword) {
      case 'description': return true;
      case 'const': return Object.is(value, rule);
      case 'enum': return rule.includes(value);
      case 'properties': return Object.entries(rule).every(([key, child]) => !Object.hasOwn(value, key) || acceptsConstraint(child, value[key]));
      case 'allOf': return rule.every(child => acceptsConstraint(child, value));
      case 'oneOf': return rule.filter(child => acceptsConstraint(child, value)).length === 1;
      default: throw new Error(`Mot-clé de contrainte non pris en charge par le test : ${keyword}`);
    }
  });
}

test('décision/risque : matrice complète dans validatePolicy et la contrainte JSON Schema', () => {
  assert.ok(schema.$defs.entry.required.includes('decision'));
  assert.ok(schema.$defs.entry.required.includes('riskClass'));
  assert.ok(schema.$defs.entry.allOf?.length > 0, 'la contrainte doit être appliquée aux entrées');
  for (const decision of ['allow', 'prompt', 'forbidden']) for (const riskClass of [...refusalRisks, ...allowRisks]) {
    const expected = (decision === 'allow' ? allowRisks : refusalRisks).includes(riskClass);
    for (const engines of [undefined, ['codex'], ['claude']]) {
      const candidate = sample(decision, riskClass, engines);
      assert.equal(acceptsConstraint({ allOf: schema.$defs.entry.allOf }, candidate), expected, `${decision}/${riskClass}`);
      if (expected) assert.doesNotThrow(() => validatePolicy(policy([candidate])));
      else assert.throws(() => validatePolicy(policy([candidate])), /risque incompatible/);
    }
  }
});

test('les motifs Claude et les entrées de garde seule respectent aussi les classes de refus', () => {
  for (const riskClass of [...refusalRisks, ...allowRisks]) {
    const candidates = [
      { claudePattern: 'uniq', engines: ['claude'], decision: 'prompt', riskClass, justification: 'Accord requis.', match: ['uniq'], notMatch: ['uniq input'] },
      { decision: 'forbidden', riskClass, justification: 'Refus requis.', residualRisk: 'Garde Claude seule.', claudeDeny: [{ pattern: 'test-tool * danger', match: ['test-tool argument danger'], notMatch: ['test-tool argument'] }] },
    ];
    for (const candidate of candidates) {
      const expected = refusalRisks.includes(riskClass);
      assert.equal(acceptsConstraint({ allOf: schema.$defs.entry.allOf }, candidate), expected);
      if (expected) assert.doesNotThrow(() => validatePolicy(policy([candidate])));
      else assert.throws(() => validatePolicy(policy([candidate])), /risque incompatible/);
    }
  }
});

test('socle et miroirs : chaque entrée de refus porte une classe admise par le consommateur', () => {
  for (const candidate of expandEntries(core)) {
    assert.ok((candidate.decision === 'allow' ? allowRisks : refusalRisks).includes(candidate.riskClass), JSON.stringify(candidate.pattern ?? candidate.claudePattern));
    assert.ok(acceptsConstraint({ allOf: schema.$defs.entry.allOf }, candidate));
  }
  const env = core.entries.find(candidate => candidate.pattern?.join(' ') === 'env');
  assert.equal(env.riskClass, 'arbitrary-execution');
  assert.match(env.justification, /env <commande> exécute un programme arbitraire/);
  for (const prefix of ['', 'rtk ', 'rtk proxy ']) {
    assert.equal(decisionFor(core, `${prefix}env`, 'claude'), 'prompt');
    assert.equal(decisionFor(core, `${prefix}env programme`, 'claude'), 'prompt');
    assert.equal(decisionFor(core, `${prefix}env`, 'codex'), undefined);
  }
});

test('env : le reclassement conserve exactement les permissions Claude', () => {
  const old = { ...core, entries: core.entries.filter(candidate => candidate.pattern?.join(' ') !== 'env') };
  const previousEnv = { ...core.entries.find(candidate => candidate.pattern?.join(' ') === 'env'), riskClass: 'read-only' };
  // La source historique invalide ne peut plus passer par le validateur.
  // Ses seules permissions étaient ces trois préfixes prompt.
  const expected = generatePermissions(old);
  for (const prefix of ['', 'rtk ', 'rtk proxy ']) expected.ask.push(`Bash(${prefix}env:*)`);
  const current = generatePermissions(core);
  for (const key of ['allow', 'ask', 'deny']) assert.deepEqual(new Set(current[key]), new Set(expected[key]));
  assert.throws(() => validatePolicy(policy([previousEnv])), /risque incompatible avec prompt/);
});

test('les couples invalides échouent avant écriture dans init, upgrade et build', t => {
  const root = temporary(t);
  initProject(root);
  buildProject(root);
  const generatedFiles = Object.values(PROJECT_FILES).filter(file => file !== PROJECT_FILES.policy);
  const snapshot = () => generatedFiles.map(file => {
    const target = path.join(root, file);
    return { file, content: fs.readFileSync(target, 'utf8'), mtimeMs: fs.statSync(target).mtimeMs };
  });
  const before = snapshot();
  for (const decision of ['allow', 'prompt', 'forbidden']) {
    for (const riskClass of decision === 'allow' ? refusalRisks : allowRisks) {
      const invalid = policy([sample(decision, riskClass)]);
      put(root, PROJECT_FILES.policy, invalid);
      for (const action of [
        () => initProject(root), () => initProject(root, { upgrade: true }),
        () => buildProject(root), () => checkProject(root),
        () => decisionForCommand(root, 'gh pr view 12', 'claude'),
      ]) {
        assert.throws(action, /risque incompatible/);
        assert.deepEqual(snapshot(), before);
      }
    }
  }
  const fresh = temporary(t);
  put(fresh, PROJECT_FILES.policy, policy([sample('prompt', 'read-only')]));
  assert.throws(() => initProject(fresh), /risque incompatible/);
  for (const file of generatedFiles) assert.equal(fs.existsSync(path.join(fresh, file)), false);
});
