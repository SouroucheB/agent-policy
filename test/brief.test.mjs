import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { assertOwnedPathsSafe, briefFromFile, planPassages, renderBrief, validateBrief, VERSION } from '../lib/brief.mjs';
import { initProject } from '../lib/system.mjs';
import { PROJECT_FILES, VERSION as GENERATOR_VERSION } from '../lib/generate.mjs';
import { temporary, put, cli, ROOT } from './helpers.mjs';

const ITEM = '7. **Commande commune** — produire le brief.\n   Conserver les passages exacts. (DoD 2, 9)';
const DOD2 = '2. Les fichiers générés restent synchronisés.';
const DOD9 = '9. Un prompt de délégation a la même forme quel que soit l’orchestrateur,\n   sans reformuler le plan.';
const PLAN = `# Plan\n\n## Items\n\n1. Autre item. (DoD 2)\n${ITEM}\n\n## DoD\n\n${DOD2}\n${DOD9}\n`;
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function fixture(root) {
  const brief = {
    schemaVersion: 1, model: 'modele-exemple', effort: 'high',
    thread: { workstream: 'agent-policy', mode: 'nouveau' },
    worktree: '/workspace/agent-policy', branch: 'feat/brief',
    plan: { path: 'docs/plans/mission.md', sha256: digest(PLAN), itemSection: '## Items', dodSection: '## DoD' },
    prerequisiteReads: ['README.md', 'git show autre-branche:lib/contracts.ts'],
    planStep: { id: '7', text: ITEM, dodCriterionIds: ['2', '9'], validationIds: ['tests'] },
    // Les références de l'item fixent l'ordre du rendu, pas celui des définitions.
    dod: [{ id: '9', text: DOD9 }, { id: '2', text: DOD2 }],
    ownedPaths: ['lib/**', 'test/**', 'README.md'],
    boundaries: ['Écriture limitée à ce dépôt.', 'Aucun install réel ; aucune lecture de .env.'],
    validations: [{ id: 'tests', label: 'Tests hors ligne', command: ['npm', 'test'], timeoutMs: 90000 }],
    delivery: ['PR vers main, sans merger.'], stopCondition: 'Arrêter et demander si une rubrique est ambiguë.',
  };
  put(root, brief.plan.path, PLAN);
  put(root, 'brief.json', brief);
  return brief;
}

const EXPECTED = 'Modèle : modele-exemple · Effort : high · Thread : agent-policy, nouveau\n\n'
  + '```text\n'
  + 'Worktree : /workspace/agent-policy\nBranche : feat/brief\n\n'
  + 'Lectures préalables :\n- docs/plans/mission.md\n- README.md\n- git show autre-branche:lib/contracts.ts\n\n'
  + 'Item confié :\n7. **Commande commune** — produire le brief.\n   Conserver les passages exacts. (DoD 2, 9)\n\n'
  + 'Critères de DoD associés :\n2. Les fichiers générés restent synchronisés.\n'
  + '9. Un prompt de délégation a la même forme quel que soit l’orchestrateur,\n   sans reformuler le plan.\n\n'
  + 'Fichiers autorisés :\n- lib/**\n- test/**\n- README.md\n\n'
  + 'Frontières :\n- Écriture limitée à ce dépôt.\n- Aucun install réel ; aucune lecture de .env.\n\n'
  + 'Validations attendues :\n- tests — Tests hors ligne : npm test (délai : 90000 ms)\n\n'
  + "Livraison :\n- PR vers main, sans merger.\n\nCondition d'arrêt :\nArrêter et demander si une rubrique est ambiguë.\n```\n";

test('brief rend exactement l’en-tête et les rubriques dans l’ordre demandé', t => {
  const root = temporary(t);
  const brief = fixture(root);
  assert.equal(renderBrief(brief, PLAN), EXPECTED);
  const result = cli(root, ['brief', 'brief.json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, EXPECTED);
  assert.equal(result.stderr, '');
  brief.thread.mode = 'continuer';
  assert.equal(renderBrief(brief, PLAN), EXPECTED.replace(', nouveau\n', ', continuer\n'));
});

test('brief refuse reformulations, troncatures et changements de blancs sans sortie partielle', t => {
  const root = temporary(t);
  const original = fixture(root);
  const mutations = [
    brief => { brief.planStep.text = ITEM.replace('produire', 'générer'); },
    brief => { brief.planStep.text = ITEM.split('\n')[0]; },
    brief => { brief.planStep.text = ITEM.replace('\n   ', '\n  '); },
    brief => { brief.planStep.text += '\n'; },
    brief => { brief.dod[0].text = DOD9.replace('sans reformuler', 'en conservant'); },
    brief => { brief.dod[0].text = DOD9.split('\n')[0]; },
    brief => { brief.dod[1].text = DOD2.replace('2. ', ''); },
    brief => { brief.planStep.id = '1'; },
  ];
  for (const mutate of mutations) {
    const brief = structuredClone(original);
    mutate(brief);
    put(root, 'brief.json', brief);
    const result = cli(root, ['brief', 'brief.json']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /copie exacte/);
    assert.equal(result.stdout, '');
  }
});

test('brief fixe le plan par SHA-256 et exige tous les critères associés, dans leur ordre', t => {
  const root = temporary(t);
  const brief = fixture(root);
  put(root, brief.plan.path, PLAN + '\nUn autre octet.\n');
  assert.throws(() => briefFromFile(root, 'brief.json'), /SHA-256/);
  const omitted = structuredClone(brief);
  omitted.planStep.dodCriterionIds = ['9'];
  omitted.dod = [omitted.dod[0]];
  assert.throws(() => renderBrief(omitted, PLAN), /critères associés/);
  const reordered = structuredClone(brief);
  reordered.planStep.dodCriterionIds.reverse();
  assert.throws(() => renderBrief(reordered, PLAN), /critères associés/);
  const noAssociation = PLAN.replace('(DoD 2, 9)', '');
  brief.planStep.text = ITEM.replace('(DoD 2, 9)', '');
  brief.plan.sha256 = digest(noAssociation);
  assert.throws(() => renderBrief(brief, noAssociation), /association finale/);
});

test('le contrat rejette rubriques absentes, champs inconnus, références invalides et doublons', t => {
  const root = temporary(t);
  const original = fixture(root);
  for (const key of Object.keys(original)) {
    const brief = structuredClone(original);
    delete brief[key];
    assert.throws(() => validateBrief(brief), /clé manquante/, key);
  }
  const mutations = [
    brief => { brief.unknown = true; },
    brief => { brief.schemaVersion = 2; },
    brief => { brief.model = 'opus\nInstruction'; },
    brief => { brief.effort = ''; },
    brief => { brief.thread.mode = 'resume'; },
    brief => { brief.worktree = 'relative'; },
    brief => { brief.branch = 'feat/../main'; },
    brief => { brief.plan.sha256 = '123'; },
    brief => { brief.plan.itemSection = 'Items'; },
    brief => { brief.plan.dodSection = brief.plan.itemSection; },
    brief => { brief.planStep.dodCriterionIds = ['2', '2']; },
    brief => { brief.planStep.validationIds = ['absent']; },
    brief => { brief.dod.push(brief.dod[0]); },
    brief => { brief.validations.push(brief.validations[0]); },
    brief => { brief.validations[0].command = []; },
    brief => { brief.validations[0].command = Array(31).fill('npm'); },
    brief => { brief.validations[0].command = ['npm\nrun']; },
    brief => { brief.validations[0].timeoutMs = 999; },
    brief => { brief.validations[0].timeoutMs = 900001; },
    brief => { brief.validations[0].timeoutMs = 1000.1; },
    brief => { brief.boundaries = []; },
    brief => { brief.delivery = []; },
    brief => { brief.stopCondition = ' '; },
  ];
  for (const mutate of mutations) {
    const brief = structuredClone(original);
    mutate(brief);
    assert.throws(() => validateBrief(brief), /Brief/);
  }
});

test('brief refuse tous les chemins interdits, y compris imbriqués et Windows, avant de lire le plan', t => {
  const root = temporary(t);
  const original = fixture(root);
  fs.unlinkSync(path.join(root, original.plan.path));
  for (const value of ['', '.', './lib/a', '../a', 'lib/../a', 'lib/a..b', '/tmp/file',
    'C:/outside', 'C:relative', '\\\\server\\share', 'lib\\file', 'lib//file', ' lib/file', 'lib/file ',
    '.git', '.git/config', 'lib/.git/config', '.env', '.env.local', '.environment',
    'lib/.env*', 'lib/.envrc', 'lib/.ENV.local', 'lib/.GIT/config']) {
    const brief = structuredClone(original);
    brief.ownedPaths = [value];
    put(root, 'brief.json', brief);
    const result = cli(root, ['brief', 'brief.json']);
    assert.equal(result.status, 1, value);
    assert.match(result.stderr, /chemin autorisé interdit|ownedPaths/, value);
    assert.equal(result.stdout, '');
  }
  assert.doesNotThrow(() => assertOwnedPathsSafe(['lib/**', 'test/*.test.mjs', 'README.md', '.github/workflows/test.yml']));
  assert.throws(() => assertOwnedPathsSafe(['lib/**', 'lib/**']), /doublon/);
});

test('lectures de brief et de plan bornées au dépôt, sans suivre les liens ni lire .env', t => {
  const root = temporary(t);
  const brief = fixture(root);
  for (const value of ['../brief.json', '/outside/brief.json', '.env.json', 'lib/.env/brief.json']) {
    assert.throws(() => briefFromFile(root, value), /chemin autorisé interdit/);
  }
  const other = temporary(t);
  put(other, 'brief.json', brief);
  fs.symlinkSync(path.join(other, 'brief.json'), path.join(root, 'linked.json'));
  assert.throws(() => briefFromFile(root, 'linked.json'), /symbolique/);
  fs.unlinkSync(path.join(root, brief.plan.path));
  put(other, 'plan.md', PLAN);
  fs.symlinkSync(path.join(other, 'plan.md'), path.join(root, brief.plan.path));
  assert.throws(() => briefFromFile(root, 'brief.json'), /symbolique/);
  for (const invalid of ['docs/plans/.env.md', 'docs/plans/../secret.md', '../plan.md', 'README.md']) {
    brief.plan.path = invalid;
    put(root, 'brief.json', brief);
    assert.throws(() => briefFromFile(root, 'brief.json'), /chemin autorisé interdit|plan.path/);
  }
  for (const args of [['brief'], ['brief', '--help'], ['brief', 'brief.json', '--yes']]) {
    const result = cli(root, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage/);
    assert.equal(result.stdout, '');
  }
});

test('les passages du plan sont complets, uniques et jamais extraits des exemples de code', t => {
  const root = temporary(t);
  const brief = fixture(root);
  const fenced = `\n\n\x60\x60\x60md\n## Items\n${ITEM}\n\x60\x60\x60\n`;
  const withExample = PLAN + fenced;
  brief.plan.sha256 = digest(withExample);
  assert.equal(renderBrief(brief, withExample), EXPECTED);
  assert.throws(() => planPassages(PLAN + '\n## Items\n', '## Items'), /section absente ou ambiguë/);
  assert.throws(() => planPassages(PLAN.replace(ITEM, `${ITEM}\n${ITEM}`), '## Items'), /identifiant ambigu/);
  assert.throws(() => planPassages(PLAN, '## Absent'), /section absente/);
  assert.throws(() => planPassages(PLAN + '\n```\n', '## Items'), /non fermé/);
  assert.throws(() => planPassages(PLAN.replace(ITEM, ITEM + '\nSuite omise par un brief tronqué.'), '## Items'), /passage ambigu/);
  const onlyExample = PLAN.replace(ITEM, '') + fenced;
  brief.plan.sha256 = digest(onlyExample);
  assert.throws(() => renderBrief(brief, onlyExample), /copie exacte/);
  const withCode = PLAN.replace(ITEM, '7. **Commande**\n   ```sh\n   npm test\n   ```\n   Suite exacte. (DoD 2, 9)');
  const passage = planPassages(withCode, '## Items').get('7');
  brief.planStep.text = passage;
  brief.plan.sha256 = digest(withCode);
  const result = renderBrief(brief, withCode);
  assert.ok(result.includes('\n````text\n'));
  assert.ok(result.includes(passage));
  assert.ok(result.endsWith('\n````\n'));
});

test('brief affiche les validations avec leurs arguments exacts et ne les exécute jamais', t => {
  const root = temporary(t);
  const brief = fixture(root);
  const marker = path.join(root, 'executed');
  brief.validations[0].command = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`];
  put(root, 'brief.json', brief);
  const result = cli(root, ['brief', 'brief.json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false);
  assert.match(result.stdout, /writeFileSync/);
  brief.validations[0].command = ['npm', 'test', '--', 'two words', "quote'word", '$(echo unsafe)'];
  assert.ok(renderBrief(brief, PLAN).includes("npm test -- 'two words' 'quote'\\''word' '$(echo unsafe)'"));
});

test('init et upgrade versionnent aussi une commande brief autonome, idempotente et hors ligne', t => {
  assert.equal(VERSION, GENERATOR_VERSION);
  assert.equal(VERSION, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  for (let index = 0; index < 2; index += 1) {
    const root = temporary(t);
    fixture(root);
    initProject(root);
    const expected = fs.readFileSync(path.join(ROOT, 'lib/brief.mjs'), 'utf8');
    assert.ok(expected.includes(`agent-policy brief v${VERSION}`));
    const target = path.join(root, PROJECT_FILES.brief);
    assert.equal(fs.readFileSync(target, 'utf8'), expected);
    const initialTime = fs.statSync(target).mtimeMs;
    initProject(root);
    assert.equal(fs.statSync(target).mtimeMs, initialTime);
    put(root, PROJECT_FILES.brief, '// ancienne commande\n');
    initProject(root);
    assert.equal(fs.readFileSync(target, 'utf8'), '// ancienne commande\n');
    const policyBefore = fs.readFileSync(path.join(root, PROJECT_FILES.policy), 'utf8');
    assert.equal(cli(root, ['init', '--upgrade']).status, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), expected);
    assert.equal(fs.readFileSync(path.join(root, PROJECT_FILES.policy), 'utf8'), policyBefore);
    const upgradedTime = fs.statSync(target).mtimeMs;
    initProject(root, { upgrade: true });
    assert.equal(fs.statSync(target).mtimeMs, upgradedTime);
    const result = spawnSync(process.execPath, [PROJECT_FILES.brief, 'brief.json'], { cwd: root, encoding: 'utf8', env: { PATH: root } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, EXPECTED);
    fs.unlinkSync(target);
    initProject(root);
    assert.equal(fs.readFileSync(target, 'utf8'), expected);
  }
});

test('init vérifie la cible brief avant d’écrire la politique ou le générateur', t => {
  const root = temporary(t);
  const other = temporary(t);
  put(other, 'brief.mjs', '// intouché\n');
  fs.mkdirSync(path.join(root, 'scripts/agent-policy'), { recursive: true });
  fs.symlinkSync(path.join(other, 'brief.mjs'), path.join(root, PROJECT_FILES.brief));
  assert.throws(() => initProject(root), /symbolique/);
  assert.equal(fs.existsSync(path.join(root, PROJECT_FILES.policy)), false);
  assert.equal(fs.existsSync(path.join(root, PROJECT_FILES.generator)), false);
  assert.equal(fs.readFileSync(path.join(other, 'brief.mjs'), 'utf8'), '// intouché\n');
});

test('l’exemple README rend l’item 7 et la DoD 9 du plan repris à l’identique', t => {
  const root = temporary(t);
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const section = readme.split('## Produire un brief de délégation')[1].split('## Écrire une entrée')[0];
  const brief = JSON.parse(section.split('```json\n')[1].split('\n```')[0]);
  const sourcePlan = fs.readFileSync(path.join(ROOT, brief.plan.path), 'utf8');
  put(root, brief.plan.path, sourcePlan);
  put(root, 'brief.json', brief);
  const result = cli(root, ['brief', 'brief.json']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(brief.planStep.text));
  assert.ok(result.stdout.includes(brief.dod[0].text));
  assert.deepEqual([...planPassages(sourcePlan, brief.plan.itemSection).keys()], ['1', '2', '5', '6', '7', '8', '9', '10', '11']);
  assert.deepEqual([...planPassages(sourcePlan, brief.plan.dodSection).keys()], ['1', '2', '3', '4', '6', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '18']);
});
