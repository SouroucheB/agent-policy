#!/usr/bin/env node
// agent-policy generator v1.0.0 — copie autonome ; mise à jour par agent-policy init --upgrade.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const VERSION = '1.0.0';
export const RISK_CLASSES = [
  'destructive-program', 'remote-publication', 'cloud-mutation', 'paid-provider',
  'shared-local-state', 'arbitrary-execution', 'read-only', 'local-reversible',
];
const DECISIONS = ['allow', 'prompt', 'forbidden'];
const CLAUDE_KEYS = { allow: 'allow', prompt: 'ask', forbidden: 'deny' };
const TOKEN = /^[A-Za-z0-9_./:@%+,=\-]+$/;
const ENTRY_KEYS = ['pattern', 'decision', 'riskClass', 'justification', 'match', 'notMatch'];
export const PROJECT_FILES = {
  policy: 'agent-policy/policy.json',
  generator: 'scripts/agent-policy/generate.mjs',
  codex: '.codex/rules/project.rules',
  claude: '.claude/settings.json',
};

function fail(message) { throw new Error(message); }
export function isObject(value) {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}
function keys(value, expected, label, optional = []) {
  if (isObject(value) === false) fail(`${label} : objet attendu`);
  if (Object.keys(value).some(key => [...expected, ...optional].includes(key) === false)) fail(`${label} : clé inconnue`);
  if (expected.some(key => Object.hasOwn(value, key) === false)) fail(`${label} : clé manquante`);
}
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }

// Grammaire volontairement limitée : une commande argv, jamais un programme shell.
// Les suffixes peuvent contenir des arguments cités, sans expansion ni opérateur actif.
export function tokenize(command) {
  if (nonempty(command) === false || /[\n\r\u0000]/u.test(command)) fail('Exemple : commande simple attendue');
  const tokens = [];
  let token = '';
  let quote = '';
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = '';
      else token += char;
    } else if (char === '\\') {
      index += 1;
      if (index >= command.length) fail('Exemple : échappement incomplet');
      const next = command[index];
      if (quote === '"' && ['$', '`', '"', '\\'].includes(next) === false) token += '\\';
      token += next;
      started = true;
    } else if (quote === '"') {
      if (char === '"') quote = '';
      else if (char === '$' || char === '`') fail('Exemple : expansion shell interdite');
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) tokens.push(token);
      token = '';
      started = false;
    } else if (/[;&|<>$`*?()[\]{}~#]/u.test(char)) {
      fail('Exemple : opérateur, expansion ou glob shell interdit');
    } else {
      token += char;
      started = true;
    }
  }
  if (quote !== '') fail('Exemple : guillemet non fermé');
  if (started) tokens.push(token);
  if (tokens.length === 0 || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[0])) fail('Exemple : argv attendu, sans affectation');
  return tokens;
}

export function matchesPrefix(pattern, argv) {
  return pattern.length <= argv.length && pattern.every((token, index) => token === argv[index]);
}
export function claudePermission(entry) { return `Bash(${entry.pattern.join(' ')}:*)`; }
export function matchesClaude(permission, command) {
  if (typeof permission !== 'string' || permission.startsWith('Bash(') === false || permission.endsWith(')') === false) {
    fail('Permission Claude : motif Bash attendu');
  }
  tokenize(command);
  const pattern = permission.slice(5, -1);
  const trimmed = command.trim();
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return trimmed === prefix || trimmed.startsWith(`${prefix} `);
  }
  if (pattern.endsWith(' *') && pattern.indexOf('*') === pattern.length - 1 && trimmed === pattern.slice(0, -2)) return true;
  const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`, 'u').test(trimmed);
}

function validateAllow(entry, label) {
  if (entry.decision !== 'allow') return;
  if (['read-only', 'local-reversible'].includes(entry.riskClass) === false) fail(`${label} : risque incompatible avec allow`);
  const [program, subcommand, operation] = entry.pattern;
  const basename = path.posix.basename(program);
  if (['eval', 'exec', 'sudo', 'rm', 'psql', 'env', 'xargs', 'timeout', 'find', 'command', 'builtin', 'time', 'nice', 'nohup', 'stdbuf', 'watch', 'flock', 'setsid', 'ionice', 'busybox'].includes(basename)) {
    fail(`${label} : programme ou wrapper libre interdit en allow`);
  }
  if (['bash', 'sh', 'zsh', 'node', 'python', 'python3', 'ruby', 'perl', 'deno', 'bun'].includes(basename)) {
    if (typeof subcommand !== 'string' || subcommand.startsWith('scripts/') === false || /\.(?:mjs|cjs|js|sh|py|rb|pl|ts)$/u.test(subcommand) === false) {
      fail(`${label} : interpréteur libre ; nommer un script de dépôt fermé`);
    }
  }
  if (['rg', 'sed'].includes(basename)) fail(`${label} : options exécutables ou mutations ; utiliser un wrapper fermé`);
  if (entry.pattern.some(token => ['with-env.sh', 'with-supabase-env.sh'].includes(path.posix.basename(token)))) fail(`${label} : wrapper de chargement de secrets interdit en allow`);
  if (['git', 'gh', 'npm', 'npx', 'docker'].includes(basename) && (typeof subcommand !== 'string' || subcommand.startsWith('-'))) fail(`${label} : sous-commande littérale requise`);
  if (basename === 'npx' && (subcommand !== 'tsc' || operation !== '--noEmit')) fail(`${label} : npx libre interdit en allow`);
  if (basename === 'npm' && ['exec', 'x'].includes(subcommand)) fail(`${label} : npm exec libre interdit en allow`);
  if (basename === 'npm' && subcommand === 'run' && (typeof operation !== 'string' || operation.startsWith('-'))) fail(`${label} : nom de script npm requis`);
  if (basename === 'gh' && ['pr', 'run', 'repo', 'secret', 'variable', 'alias'].includes(subcommand) && typeof operation !== 'string') fail(`${label} : sous-commande gh requise`);
  if (basename === 'docker' && (['exec', 'run'].includes(subcommand) || (subcommand === 'compose' && (typeof operation !== 'string' || ['exec', 'run'].includes(operation))))) fail(`${label} : exécution Docker libre interdite en allow`);
}

export function validatePolicy(value, { core = false } = {}) {
  keys(value, ['version', 'entries'], 'Politique');
  if (value.version !== 1 || Array.isArray(value.entries) === false) fail('Politique : version 1 et entries[] requis');
  const patterns = new Set();
  value.entries.forEach((entry, index) => {
    const label = `Entrée ${index + 1}`;
    keys(entry, ENTRY_KEYS, label, ['residualRisk', 'claudeDeny']);
    if (Array.isArray(entry.pattern) === false || entry.pattern.length === 0 || entry.pattern.some(token => typeof token !== 'string' || TOKEN.test(token) === false)) {
      fail(`${label} : pattern non vide de tokens littéraux simples requis`);
    }
    const identity = JSON.stringify(entry.pattern);
    if (patterns.has(identity)) fail(`${label} : pattern dupliqué`);
    patterns.add(identity);
    if (DECISIONS.includes(entry.decision) === false) fail(`${label} : décision invalide`);
    if (RISK_CLASSES.includes(entry.riskClass) === false) fail(`${label} : riskClass invalide`);
    if (nonempty(entry.justification) === false) fail(`${label} : justification requise`);
    if (Object.hasOwn(entry, 'residualRisk') && nonempty(entry.residualRisk) === false) fail(`${label} : residualRisk doit être une explication non vide`);
    if (core && entry.pattern.some(token => token.includes('/') || token.startsWith('.'))) fail(`${label} : chemin interdit dans le socle global`);
    for (const field of ['match', 'notMatch']) {
      if (Array.isArray(entry[field]) === false || entry[field].length === 0 || entry[field].some(example => nonempty(example) === false)) fail(`${label} : ${field}[] non vide requis`);
      entry[field].forEach(tokenize);
    }
    validateAllow(entry, label);
    if (Object.hasOwn(entry, 'claudeDeny')) {
      if (Array.isArray(entry.claudeDeny) === false || entry.claudeDeny.length === 0) fail(`${label} : claudeDeny[] non vide requis`);
      for (const guard of entry.claudeDeny) {
        keys(guard, ['pattern', 'match', 'notMatch'], `${label} / garde Claude`);
        if (typeof guard.pattern !== 'string' || /^[A-Za-z0-9_./:@%+,= *\-]+$/u.test(guard.pattern) === false || guard.pattern.startsWith(`${entry.pattern[0]} `) === false) fail(`${label} : motif Claude explicite du même programme requis`);
        if (core && guard.pattern.split(' ').some(token => token.includes('/') || token.startsWith('.'))) fail(`${label} : chemin interdit dans une garde du socle global`);
        for (const field of ['match', 'notMatch']) {
          if (Array.isArray(guard[field]) === false || guard[field].length === 0) fail(`${label} : exemples de garde Claude requis`);
          guard[field].forEach(tokenize);
        }
      }
    }
  });
  return value;
}

export function validateExamples(policy) {
  validatePolicy(policy);
  let count = 0;
  for (const entry of policy.entries) {
    for (const [examples, expected] of [[entry.match, true], [entry.notMatch, false]]) {
      for (const example of examples) {
        if (matchesPrefix(entry.pattern, tokenize(example)) !== expected) fail(`Exemple Codex incohérent : ${JSON.stringify(example)} pour ${entry.pattern.join(' ')}`);
        if (matchesClaude(claudePermission(entry), example) !== expected) fail(`Exemple Claude incohérent : ${JSON.stringify(example)} pour ${entry.pattern.join(' ')}`);
        count += 1;
      }
    }
    for (const guard of entry.claudeDeny ?? []) {
      for (const [examples, expected] of [[guard.match, true], [guard.notMatch, false]]) {
        for (const example of examples) {
          if (matchesClaude(`Bash(${guard.pattern})`, example) !== expected) fail(`Exemple de garde Claude incohérent : ${JSON.stringify(example)}`);
          count += 1;
        }
      }
    }
  }
  return count;
}
export function decisionFor(policy, command) {
  const argv = tokenize(command);
  let decision;
  for (const entry of policy.entries) {
    if (matchesPrefix(entry.pattern, argv) && (decision === undefined || DECISIONS.indexOf(entry.decision) > DECISIONS.indexOf(decision))) decision = entry.decision;
  }
  return decision;
}

export function generateCodex(policy) {
  validateExamples(policy);
  const header = `# Généré par agent-policy v${VERSION}. Ne pas éditer ; modifier la source JSON.\n`;
  return header + policy.entries.map(entry => [
    'prefix_rule(',
    `    pattern=${JSON.stringify(entry.pattern)},`,
    `    decision=${JSON.stringify(entry.decision)},`,
    `    justification=${JSON.stringify(entry.justification)},`,
    `    match=${JSON.stringify(entry.match)},`,
    `    not_match=${JSON.stringify(entry.notMatch)},`,
    ')',
  ].join('\n')).join('\n\n') + '\n';
}
export function generatePermissions(policy) {
  validateExamples(policy);
  const permissions = { allow: [], ask: [], deny: [] };
  for (const entry of policy.entries) {
    permissions[CLAUDE_KEYS[entry.decision]].push(claudePermission(entry));
    for (const guard of entry.claudeDeny ?? []) permissions.deny.push(`Bash(${guard.pattern})`);
  }
  permissions.deny = [...new Set(permissions.deny)];
  return permissions;
}
export function parseSettings(text) {
  const settings = text === null ? {} : JSON.parse(text);
  if (isObject(settings) === false) fail('Claude : objet settings.json requis');
  if (Object.hasOwn(settings, 'permissions') && isObject(settings.permissions) === false) fail('Claude : bloc permissions invalide');
  for (const key of Object.values(CLAUDE_KEYS)) {
    if (settings.permissions && Object.hasOwn(settings.permissions, key)) {
      const list = settings.permissions[key];
      if (Array.isArray(list) === false || list.some(value => typeof value !== 'string')) fail(`Claude : permissions.${key} doit être une liste de chaînes`);
    }
  }
  return settings;
}

function isBashPermission(value) { return value.startsWith('Bash(') && value.endsWith(')'); }

// JSON.parse a déjà validé le document. Ces positions servent uniquement à modifier
// les listes possédées, sans resérialiser les autres réglages ou leurs clés.
function jsonPositions(text) {
  const tokens = [...text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gu)];
  let index = 0;
  function value() {
    const first = tokens[index++];
    const node = { start: first.index, end: first.index + first[0].length, properties: new Map(), items: [] };
    if (first[0] === '{' || first[0] === '[') {
      const closing = first[0] === '{' ? '}' : ']';
      while (tokens[index][0] !== closing) {
        if (first[0] === '{') {
          const key = tokens[index++];
          node.firstKeyStart ??= key.index;
          index += 1; // deux-points
          node.properties.set(JSON.parse(key[0]), { keyStart: key.index, value: value() });
        } else node.items.push(value());
        if (tokens[index][0] === ',') index += 1;
      }
      node.end = tokens[index++].index + 1;
    }
    return node;
  }
  return value();
}

function replaceBashList(text, node, existing, generated) {
  const parts = node.items.map((item, index) => ({
    raw: text.slice(item.start, item.end) + (index + 1 < node.items.length ? text.slice(item.end, node.items[index + 1].start).match(/^\s*(?=,)/u)[0] : ''),
    leading: index === 0 ? text.slice(node.start + 1, item.start) : text.slice(node.items[index - 1].end, item.start).replace(/^\s*,/u, ''),
  }));
  const count = existing.filter(isBashPermission).length;
  let skip = Math.max(0, count - generated.length);
  let slots = count;
  let cursor = 0;
  const updated = [];
  const insert = leading => {
    updated.push({ raw: JSON.stringify(generated[cursor++]), leading });
  };
  // Garder les emplacements existants, notamment le dernier : une virgule sur
  // une ligne non-Bash n'est ainsi pas déplacée quand un ancien Bash est remplacé.
  for (const [index, part] of parts.entries()) {
    if (isBashPermission(existing[index]) === false) updated.push(part);
    else {
      slots -= 1;
      if (skip > 0) skip -= 1;
      else if (cursor < generated.length) {
        insert(part.leading);
        if (slots === 0) while (cursor < generated.length) insert(part.leading);
      }
    }
  }
  if (count === 0) {
    const leading = parts[0]?.leading ?? '';
    updated.unshift(...generated.map(value => ({ raw: JSON.stringify(value), leading })));
  }
  const tail = text.slice(node.items.at(-1)?.end ?? node.start + 1, node.end - 1);
  return `[${updated.map(part => part.leading + part.raw).join(',')}${tail}]`;
}

function insertProperties(text, node, properties) {
  const first = node.firstKeyStart;
  const leading = first === undefined ? '' : text.slice(node.start + 1, first);
  const multiline = leading.includes('\n');
  const indent = multiline ? leading.slice(leading.lastIndexOf('\n') + 1) : '';
  const unit = text.match(/\n([\t ]+)"/u)?.[1] ?? '  ';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const fields = Object.entries(properties).map(([key, value]) => {
    const formatted = multiline ? JSON.stringify(value, null, unit).replaceAll('\n', eol + indent) : JSON.stringify(value);
    return `${leading}${JSON.stringify(key)}: ${formatted}`;
  });
  return { start: node.start + 1, end: node.start + 1, content: fields.join(',') + (first === undefined ? '' : ',') };
}

export function generateClaude(policy, previous = null) {
  const settings = parseSettings(previous);
  const generated = generatePermissions(policy);
  if (previous === null) return JSON.stringify({ permissions: generated }, null, 2) + '\n';
  const root = jsonPositions(previous);
  const permissions = root.properties.get('permissions')?.value;
  const edits = [];
  const missing = {};
  for (const [key, expected] of Object.entries(generated)) {
    const existing = settings.permissions?.[key] ?? [];
    if (JSON.stringify(existing.filter(isBashPermission)) === JSON.stringify(expected)) continue;
    const node = permissions?.properties.get(key)?.value;
    if (node === undefined) missing[key] = expected;
    else edits.push({ start: node.start, end: node.end, content: replaceBashList(previous, node, existing, expected) });
  }
  if (Object.keys(missing).length > 0) {
    edits.push(permissions === undefined ? insertProperties(previous, root, { permissions: missing }) : insertProperties(previous, permissions, missing));
  }
  let result = previous;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.content + result.slice(edit.end);
  }
  parseSettings(result);
  return result;
}

// Toutes les cibles sont relatives à une racine explicite. Aucun lien symbolique traversé.
export function safePath(root, relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/u).some(part => part === '..')) fail('Chemin cible hors racine');
  const base = path.resolve(root);
  let current = base;
  const parts = relative.split(path.sep).filter(part => part.length > 0);
  for (const part of ['', ...parts]) {
    if (part !== '') current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) fail(`Lien symbolique refusé : ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return path.join(base, relative);
}
export function readOptional(root, relative) {
  const target = safePath(root, relative);
  try {
    if (fs.statSync(target).isFile() === false) fail(`Fichier régulier requis : ${target}`);
    const bytes = fs.readFileSync(target);
    const text = bytes.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(bytes) === false) fail(`UTF-8 invalide : ${target} ; refus d'une sauvegarde avec perte`);
    return text;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export function atomicWrite(root, relative, content, mode = 0o600) {
  const target = safePath(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.agent-policy-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode });
    safePath(root, relative);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export function loadPolicy(root, relative = PROJECT_FILES.policy, options = {}) {
  const text = readOptional(root, relative);
  if (text === null) fail(`Politique absente : ${relative}. Exécuter agent-policy init.`);
  return validatePolicy(JSON.parse(text), options);
}
export function projectOutputs(root) {
  const policy = loadPolicy(root);
  return {
    policy,
    outputs: [
      { relative: PROJECT_FILES.codex, content: generateCodex(policy) },
      { relative: PROJECT_FILES.claude, content: generateClaude(policy, readOptional(root, PROJECT_FILES.claude)) },
    ],
  };
}
export function buildProject(root) {
  const { outputs } = projectOutputs(root);
  // Préparer et valider toutes les cibles avant la première écriture.
  for (const output of outputs) readOptional(root, output.relative);
  for (const output of outputs) {
    if (readOptional(root, output.relative) !== output.content) atomicWrite(root, output.relative, output.content);
  }
  return outputs.map(output => output.relative);
}

export function checkNativeCodex(root, rulesRelative, policy) {
  const scratchParent = safePath(root, '.agent-tmp');
  fs.mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
  const scratch = fs.mkdtempSync(path.join(scratchParent, 'codex-check-'));
  try {
    const examples = [...new Set(policy.entries.flatMap(entry => [...entry.match, ...entry.notMatch]))];
    if (examples.length === 0) examples.push('agent-policy-unmatched');
    for (const example of examples) {
      const result = spawnSync('codex', ['execpolicy', 'check', '--rules', safePath(root, rulesRelative), '--', ...tokenize(example)], {
        encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, CODEX_HOME: scratch, TMPDIR: scratch, XDG_CACHE_HOME: scratch, XDG_STATE_HOME: scratch },
      });
      if (result.error?.code === 'ENOENT') return 'absent (contrôle interne effectué)';
      if (result.error) throw result.error;
      if (result.status !== 0) fail(`Codex execpolicy : ${result.stderr.trim()}`);
      const actual = JSON.parse(result.stdout);
      const expected = decisionFor(policy, example);
      if (isObject(actual) === false || (actual.decision ?? undefined) !== expected) {
        fail(`Décision Codex inattendue pour ${JSON.stringify(example)} : ${JSON.stringify(actual.decision)}, attendu ${expected}`);
      }
    }
    return `${examples.length} commandes vérifiées`;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
export function checkProject(root, { codex = false } = {}) {
  const { policy, outputs } = projectOutputs(root);
  for (const output of outputs) {
    if (readOptional(root, output.relative) !== output.content) fail(`Écart généré : ${output.relative}. Exécuter agent-policy build.`);
  }
  const count = validateExamples(policy);
  return { count, codex: codex ? checkNativeCodex(root, PROJECT_FILES.codex, policy) : 'non demandé' };
}
export function runProjectCommand(args, root = process.cwd()) {
  const [command, ...options] = args;
  if (command === 'build' && options.length === 0) {
    console.log(`Généré : ${buildProject(root).join(', ')}`);
  } else if (command === 'check' && (options.length === 0 || (options.length === 1 && options[0] === '--codex'))) {
    const result = checkProject(root, { codex: options.includes('--codex') });
    console.log(`OK : fichiers synchronisés, ${result.count} exemples Codex + Claude ; Codex natif : ${result.codex}.`);
  } else {
    fail('Usage : node scripts/agent-policy/generate.mjs build | check [--codex]');
  }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runProjectCommand(process.argv.slice(2)); }
  catch (error) { console.error(`agent-policy : ${error.message}`); process.exitCode = 1; }
}
