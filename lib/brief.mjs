#!/usr/bin/env node
// agent-policy brief v1.2.0 — copie autonome ; mise à jour par agent-policy init --upgrade.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const VERSION = '1.2.0';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
function fail(message) { throw new Error(`Brief : ${message}`); }
function keys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} : objet attendu`);
  if (Object.keys(value).some(key => expected.includes(key) === false)) fail(`${label} : clé inconnue`);
  if (expected.some(key => Object.hasOwn(value, key) === false)) fail(`${label} : clé manquante`);
}
function text(value, label, { multiline = false, max = 2000 } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || CONTROL.test(value)
    || (multiline === false && (/[\n\t]/u.test(value) || value.trim() !== value))) fail(`${label} : texte invalide`);
}
function array(value, label, max = 100, min = 1) {
  if (Array.isArray(value) === false || value.length < min || value.length > max) fail(`${label} : liste invalide`);
}
function unique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label} : doublon`);
}
function identifier(value, label) {
  if (typeof value !== 'string' || IDENTIFIER.test(value) === false) fail(`${label} : identifiant invalide`);
}
function identifiers(values, label) {
  array(values, label);
  values.forEach(value => identifier(value, label));
  unique(values, label);
}

// Reprise sans Zod d'assertOwnedPathsSafe, renforcée pour les segments imbriqués et Windows.
export function assertOwnedPathsSafe(paths) {
  array(paths, 'ownedPaths', 200);
  for (const value of paths) {
    text(value, 'ownedPaths', { max: 500 });
    const segments = value.split('/');
    if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/u.test(value)
      || value.includes('\\') || value.includes('..') || segments.includes('.') || segments.includes('')
      || segments.some(segment => segment.toLowerCase() === '.git' || segment.toLowerCase().startsWith('.env'))) {
      fail(`chemin autorisé interdit : ${value}`);
    }
  }
  unique(paths, 'ownedPaths');
}

// Contrats repris de missionBrief/planStep/dodCriterion/validation : références par identifiant,
// empreinte du plan, argv et délai bornés. Aucun contrat de fournisseur ni exécution de commande.
export function validateBrief(brief) {
  keys(brief, ['schemaVersion', 'model', 'effort', 'thread', 'worktree', 'branch', 'plan',
    'prerequisiteReads', 'planStep', 'dod', 'ownedPaths', 'boundaries', 'validations', 'delivery', 'stopCondition'], 'racine');
  if (brief.schemaVersion !== 1) fail('schemaVersion doit valoir 1');
  text(brief.model, 'model', { max: 100 });
  text(brief.effort, 'effort', { max: 80 });
  keys(brief.thread, ['workstream', 'mode'], 'thread');
  text(brief.thread.workstream, 'thread.workstream', { max: 300 });
  if (['nouveau', 'continuer'].includes(brief.thread.mode) === false) fail('thread.mode : nouveau ou continuer attendu');
  text(brief.worktree, 'worktree', { max: 1000 });
  if (path.posix.isAbsolute(brief.worktree) === false && path.win32.isAbsolute(brief.worktree) === false) fail('worktree : chemin absolu attendu');
  text(brief.branch, 'branch', { max: 240 });
  if (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(brief.branch) === false || brief.branch.includes('..')
    || brief.branch.includes('//') || brief.branch.includes('@{') || brief.branch.endsWith('.')
    || brief.branch.split('/').some(segment => segment === '' || segment.startsWith('.') || segment.endsWith('.lock'))) fail('branch : nom invalide');
  keys(brief.plan, ['path', 'sha256', 'itemSection', 'dodSection'], 'plan');
  assertOwnedPathsSafe([brief.plan.path]);
  if (/^docs\/plans\/[A-Za-z0-9_./-]+\.md$/u.test(brief.plan.path) === false) fail('plan.path : fichier .md sous docs/plans attendu');
  if (typeof brief.plan.sha256 !== 'string' || /^[a-f0-9]{64}$/u.test(brief.plan.sha256) === false) fail('plan.sha256 : empreinte invalide');
  for (const key of ['itemSection', 'dodSection']) {
    text(brief.plan[key], `plan.${key}`);
    if (/^## [^#]/u.test(brief.plan[key]) === false) fail(`plan.${key} : titre Markdown de niveau 2 attendu`);
  }
  if (brief.plan.itemSection === brief.plan.dodSection) fail('les sections item et DoD doivent être distinctes');
  for (const key of ['prerequisiteReads', 'boundaries', 'delivery']) {
    array(brief[key], key, 200, key === 'prerequisiteReads' ? 0 : 1);
    brief[key].forEach(value => text(value, key));
    unique(brief[key], key);
  }
  keys(brief.planStep, ['id', 'text', 'dodCriterionIds', 'validationIds'], 'planStep');
  identifier(brief.planStep.id, 'planStep.id');
  text(brief.planStep.text, 'planStep.text', { multiline: true, max: 30000 });
  identifiers(brief.planStep.dodCriterionIds, 'planStep.dodCriterionIds');
  identifiers(brief.planStep.validationIds, 'planStep.validationIds');
  array(brief.dod, 'dod');
  for (const criterion of brief.dod) {
    keys(criterion, ['id', 'text'], 'dod');
    identifier(criterion.id, 'dod.id');
    text(criterion.text, 'dod.text', { multiline: true, max: 30000 });
  }
  unique(brief.dod.map(value => value.id), 'dod.id');
  assertOwnedPathsSafe(brief.ownedPaths);
  array(brief.validations, 'validations');
  for (const validation of brief.validations) {
    keys(validation, ['id', 'label', 'command', 'timeoutMs'], 'validations');
    identifier(validation.id, 'validation.id');
    text(validation.label, 'validation.label', { max: 200 });
    array(validation.command, 'validation.command', 30);
    validation.command.forEach(value => text(value, 'validation.command', { max: 500 }));
    if (Number.isInteger(validation.timeoutMs) === false || validation.timeoutMs < 1000 || validation.timeoutMs > 900000) fail('validation.timeoutMs : délai invalide');
  }
  unique(brief.validations.map(value => value.id), 'validation.id');
  // Un brief porte un seul item : aucune définition ignorée ni référence implicite.
  for (const [references, definitions, label] of [
    [brief.planStep.dodCriterionIds, brief.dod, 'DoD'],
    [brief.planStep.validationIds, brief.validations, 'validation'],
  ]) {
    if (references.length !== definitions.length || references.some(id => definitions.some(value => value.id === id) === false)) fail(`${label} : références et définitions différentes`);
  }
  text(brief.stopCondition, 'stopCondition', { multiline: true, max: 4000 });
  return brief;
}

// Ne lit que des fichiers réguliers du dépôt, sans suivre de lien ni ouvrir .env*.
function readRepositoryFile(root, relative) {
  assertOwnedPathsSafe([relative]);
  if (/[*?\[\]{}]/u.test(relative)) fail('chemin de lecture : aucun glob admis');
  let current = fs.realpathSync(root);
  const segments = relative.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail(`lien symbolique interdit : ${relative}`);
    if (index < segments.length - 1 ? stat.isDirectory() === false : stat.isFile() === false) fail(`fichier régulier attendu : ${relative}`);
    if (index === segments.length - 1 && stat.size > 2 * 1024 * 1024) fail(`fichier trop volumineux : ${relative}`);
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(current));
}

// Sous-ensemble explicite de Markdown : titres ## uniques, liste numérotée en colonne 1,
// suites indentées. Les clôtures de code ne sont jamais des titres ni des items.
export function planPassages(planText, section) {
  const lines = planText.split('\n');
  let fence = null;
  let active = false;
  let found = 0;
  let current = null;
  const passages = new Map();
  function finish() {
    if (current === null) return;
    while (current.lines.at(-1) === '') current.lines.pop();
    if (passages.has(current.id)) fail(`identifiant ambigu dans ${section} : ${current.id}`);
    passages.set(current.id, current.lines.join('\n'));
    current = null;
  }
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence !== null) {
      if (active && current !== null) current.lines.push(line);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.size && marker[2].trim() === '') fence = null;
      continue;
    }
    if (marker) {
      fence = { char: marker[1][0], size: marker[1].length };
      if (active && current !== null && /^\s/u.test(line)) current.lines.push(line);
      else finish();
      continue;
    }
    if (/^#{1,2} /u.test(line)) {
      finish();
      active = line === section;
      if (active) found += 1;
      continue;
    }
    if (active === false) continue;
    const item = /^([0-9]+)\. /u.exec(line);
    if (item) {
      finish();
      current = { id: item[1], lines: [line] };
    } else if (current !== null && (line === '' || /^(?: {3,}|\t)/u.test(line))) current.lines.push(line);
    else {
      // Une continuation Markdown non indentée pourrait tronquer silencieusement la mission.
      if (current !== null && current.lines.at(-1) !== '' && /^#{3,6} /u.test(line) === false) fail('plan : suite d’item non indentée ; passage ambigu');
      finish();
    }
  }
  finish();
  if (fence !== null) fail('plan : bloc de code non fermé');
  if (found !== 1) fail(`section absente ou ambiguë : ${section}`);
  return passages;
}

function assertPlanCopies(brief, planText) {
  if (createHash('sha256').update(planText).digest('hex') !== brief.plan.sha256) fail('le SHA-256 du plan a changé');
  const items = planPassages(planText, brief.plan.itemSection);
  const criteria = planPassages(planText, brief.plan.dodSection);
  const item = items.get(brief.planStep.id);
  if (item === undefined || item !== brief.planStep.text) fail('item : copie exacte du passage du plan requise');
  const association = /\(DoD ([0-9]+(?:, [0-9]+)*)\)$/u.exec(item);
  if (association === null) fail('item : association finale (DoD 1, 2, …) attendue');
  if (JSON.stringify(association[1].split(', ')) !== JSON.stringify(brief.planStep.dodCriterionIds)) fail('DoD : critères associés différents de ceux du plan');
  for (const criterion of brief.dod) {
    if (criteria.get(criterion.id) !== criterion.text) fail(`DoD ${criterion.id} : copie exacte du passage du plan requise`);
  }
}

function shellArgument(value) {
  return /^[A-Za-z0-9_./:@%+,=\-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
export function renderBrief(input, planText) {
  const brief = validateBrief(input);
  assertPlanCopies(brief, planText);
  const bullets = values => values.map(value => `- ${value}`);
  const body = [
    `Worktree : ${brief.worktree}`, `Branche : ${brief.branch}`, '',
    'Lectures préalables :', ...bullets([brief.plan.path, ...brief.prerequisiteReads.filter(value => value !== brief.plan.path)]), '',
    'Item confié :', brief.planStep.text, '',
    'Critères de DoD associés :', ...brief.planStep.dodCriterionIds.map(id => brief.dod.find(value => value.id === id).text), '',
    'Fichiers autorisés :', ...bullets(brief.ownedPaths), '',
    'Frontières :', ...bullets(brief.boundaries), '',
    'Validations attendues :', ...brief.planStep.validationIds.map(id => {
      const validation = brief.validations.find(value => value.id === id);
      return `- ${validation.id} — ${validation.label} : ${validation.command.map(shellArgument).join(' ')} (délai : ${validation.timeoutMs} ms)`;
    }), '',
    'Livraison :', ...bullets(brief.delivery), '',
    "Condition d'arrêt :", brief.stopCondition,
  ].join('\n');
  const fence = '`'.repeat(Math.max(3, ...Array.from(body.matchAll(/`+/gu), match => match[0].length + 1)));
  return `Modèle : ${brief.model} · Effort : ${brief.effort} · Thread : ${brief.thread.workstream}, ${brief.thread.mode}\n\n${fence}text\n${body}\n${fence}\n`;
}

export function briefFromFile(root, relative) {
  if (typeof relative !== 'string' || relative.endsWith('.json') === false) fail('fichier brief.json relatif au dépôt attendu');
  const brief = validateBrief(JSON.parse(readRepositoryFile(root, relative)));
  return renderBrief(brief, readRepositoryFile(root, brief.plan.path));
}
export function runBriefCommand(args, root = process.cwd()) {
  if (args.length !== 1 || args[0].startsWith('-')) fail('Usage : agent-policy brief <brief.json>');
  process.stdout.write(briefFromFile(root, args[0]));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runBriefCommand(process.argv.slice(2)); }
  catch (error) { console.error(`agent-policy : ${error.message}`); process.exitCode = 1; }
}
