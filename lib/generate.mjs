#!/usr/bin/env node
// agent-policy generator v1.3.0 — copie autonome ; mise à jour par agent-policy init --upgrade.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

export const VERSION = '1.3.0';
// init remplace ce marqueur par le texte exact du socle dans la copie autonome.
const EMBEDDED_CORE_TEXT = null;
export const RISK_CLASSES = [
  'destructive-program', 'remote-publication', 'cloud-mutation', 'paid-provider',
  'shared-local-state', 'arbitrary-execution', 'read-only', 'local-reversible',
];
const DECISIONS = ['allow', 'prompt', 'forbidden'];
const ENGINES = ['codex', 'claude'];
const CLAUDE_KEYS = { allow: 'allow', prompt: 'ask', forbidden: 'deny' };
const TOKEN = /^[A-Za-z0-9_./:@%+,=\-]+$/;
export const DEFAULT_COMMAND_PREFIXES = [['rtk'], ['rtk', 'proxy']];
const CLAUDE_GUARDS = { claudeDeny: 'deny', claudeAsk: 'ask' };
export const PROJECT_FILES = {
  policy: 'agent-policy/policy.json',
  core: 'agent-policy/core-policy.json',
  coreVersion: 'agent-policy/core-policy.version.json',
  generator: 'scripts/agent-policy/generate.mjs',
  brief: 'scripts/agent-policy/brief.mjs',
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
function enginesFor(entry) { return entry.engines ?? ENGINES; }
function validPattern(value) { return Array.isArray(value) && value.length > 0 && value.every(token => typeof token === 'string' && TOKEN.test(token)); }
export const GIT_C_READS = ['status', 'diff', 'log', 'show', 'rev-parse', 'branch --list', 'ls-files', 'grep', 'merge-tree', 'worktree list'];
export const GIT_C_COMMANDS = [...GIT_C_READS, 'add', 'commit', 'fetch'];
export const GIT_C_OPTIONS = ['--output', '--ext-diff', '--upload-pack', '-c', '--exec-path', '--config-env'];
export const GIT_C_MUTATIONS = [
  'push', 'pull', 'merge', 'rebase', 'reset', 'restore', 'checkout', 'switch',
  'stash', 'clean', 'rm', 'tag', 'config', 'gc',
  'init', 'mv', 'am', 'apply', 'cherry-pick', 'revert', 'bisect', 'notes', 'update-ref',
  'update-index', 'read-tree', 'prune', 'repack', 'maintenance', 'format-patch',
  'branch -d', 'branch -D', 'branch -m', 'branch -M', 'branch -c', 'branch -C', 'branch -f', 'branch -u',
  'branch --delete', 'branch --move', 'branch --copy', 'branch --force',
  'branch --set-upstream-to', 'branch --unset-upstream', 'branch --edit-description', 'branch --create-reflog',
  'worktree add', 'worktree remove', 'worktree prune', 'worktree move', 'worktree repair', 'worktree lock', 'worktree unlock',
  'remote add', 'remote set-url', 'remote remove', 'remote rm', 'remote rename',
  'remote prune', 'remote update', 'remote set-head', 'remote set-branches',
];
export const UNIQ_FORMS = ['uniq', 'uniq -c', 'uniq -d', 'uniq -u', 'uniq -i', 'uniq -c -i', 'uniq -i -c', 'uniq -d -i', 'uniq -i -d', 'uniq -u -i', 'uniq -i -u', 'uniq -cd', 'uniq -ci', 'uniq -di', 'uniq -ui'];
export function gitCMutationPatterns(root) {
  return [...GIT_C_MUTATIONS.flatMap(command => command.includes(' -')
    ? [`${root} * ${command}*`]
    : [`${root} * ${command}`, `${root} * ${command} *`]), `${root} rm *`];
}
export function optionGuardPatterns(root, option) { return [`${root} ${option}*`, `${root} * ${option}*`]; }
export function envGuardPatterns(root) {
  // Un début de basename .env, pas la sous-chaîne de report.env.ts.
  return ['.env*', '* .env*', '".env*', '* ".env*', "'.env*", "* '.env*", '*/.env*'].map(suffix => `${root} ${suffix}`);
}
function stripRtk(command) { return command.replace(/^(?:rtk (?:proxy )?)+/u, ''); }

// Une seule expansion depuis la source : ni récursion ni autorisation du wrapper seul.
// Les gardes sans pattern argv suivent elles aussi les préfixes, sans règle Codex fictive.
export function expandEntries(policy) {
  return policy.entries.flatMap(entry => [entry, ...(policy.commandPrefixes ?? DEFAULT_COMMAND_PREFIXES).map(prefix => {
    const prepend = command => `${prefix.join(' ')} ${command.trim()}`;
    return {
      ...entry,
      ...(entry.claudePattern ? { claudePattern: prepend(entry.claudePattern), match: entry.match.map(prepend), notMatch: entry.notMatch.map(prepend) } : {}),
      ...(entry.pattern ? {
        pattern: [...prefix, ...entry.pattern],
        match: entry.match.map(prepend), notMatch: entry.notMatch.map(prepend),
      } : {}),
      ...Object.fromEntries(Object.keys(CLAUDE_GUARDS).filter(key => entry[key]).map(key => [key, entry[key].map(guard => ({
        pattern: prepend(guard.pattern), match: guard.match.map(prepend), notMatch: guard.notMatch.map(prepend),
      }))])),
    };
  })]);
}
function entriesFor(policy, engine) { return expandEntries(policy).filter(entry => enginesFor(entry).includes(engine)); }

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
export function claudePermission(entry) { return `Bash(${entry.claudePattern ?? `${entry.pattern.join(' ')}:*`})`; }
export function compileClaudePermission(permission) {
  if (typeof permission !== 'string' || permission.startsWith('Bash(') === false || permission.endsWith(')') === false) {
    fail('Permission Claude : motif Bash attendu');
  }
  const pattern = permission.slice(5, -1);
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return command => command === prefix || command.startsWith(`${prefix} `);
  }
  const bare = pattern.endsWith(' *') && pattern.indexOf('*') === pattern.length - 1 ? pattern.slice(0, -2) : null;
  const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('[\\s\\S]*');
  const regex = new RegExp(`^${escaped}$`, 'u');
  return command => command === bare || regex.test(command);
}
export function matchesClaude(permission, command, { shellText = false } = {}) {
  if (shellText) {
    if (nonempty(command) === false || command.includes('\u0000')) fail('Exemple Claude : texte non vide sans NUL requis');
  } else tokenize(command);
  return compileClaudePermission(permission)(command.trim());
}

function validateAllow(entry, label) {
  if (entry.decision !== 'allow') return;
  if (['read-only', 'local-reversible'].includes(entry.riskClass) === false) fail(`${label} : risque incompatible avec allow`);
  let offset = 0;
  const hasClaude = enginesFor(entry).includes('claude');
  const requireGuard = (pattern, field = 'claudeDeny') => {
    if (entry[field]?.some(guard => guard.pattern === pattern) !== true) fail(`${label} : garde Claude obligatoire : ${pattern}`);
  };
  if (entry.claudePattern) {
    const direct = stripRtk(entry.claudePattern);
    if (UNIQ_FORMS.includes(direct)) return;
    if (GIT_C_COMMANDS.some(command => [`git -C * ${command}`, `git -C * ${command} *`].includes(direct))) return;
    fail(`${label} : claudePattern allow réservé aux formes fermées uniq et commandes git -C prévues`);
  }
  while (path.posix.basename(entry.pattern[offset] ?? '') === 'rtk') {
    const subcommand = entry.pattern[offset + 1];
    if (subcommand === undefined || ['run', 'err', 'test', 'summary', 'env'].includes(subcommand)) fail(`${label} : wrapper RTK libre interdit en allow`);
    if (['grep', 'read', 'ls', 'diff', 'gain', 'discover', 'session'].includes(subcommand)) {
      const root = entry.pattern.slice(0, offset + 2).join(' ');
      if (hasClaude && ['grep', 'read', 'diff'].includes(subcommand)) envGuardPatterns(root).forEach(pattern => requireGuard(pattern, subcommand === 'grep' ? 'claudeAsk' : 'claudeDeny'));
      if (hasClaude && subcommand === 'grep') optionGuardPatterns(root, '--pre').forEach(pattern => requireGuard(pattern, 'claudeAsk'));
      return;
    }
    if (subcommand === '--version' && entry.pattern.length === offset + 2) return;
    if (subcommand === 'tsc' && entry.pattern[offset + 2] === '--noEmit') return;
    if (subcommand === 'vitest' && (entry.pattern.length === offset + 2 || entry.pattern[offset + 2] === 'run')) return;
    if (subcommand === 'playwright' && entry.pattern[offset + 2] === 'test') return;
    if (['tsc', 'vitest', 'playwright'].includes(subcommand)) fail(`${label} : forme native RTK de test non autorisable`);
    offset += subcommand === 'proxy' ? 2 : 1;
    if (offset >= entry.pattern.length) fail(`${label} : wrapper RTK libre interdit en allow`);
  }
  const [program, subcommand, operation] = entry.pattern.slice(offset);
  const basename = path.posix.basename(program);
  const guardRoot = entry.pattern.slice(0, offset + 1).join(' ');
  if (['node', 'npm', 'codex'].includes(basename) && subcommand === '--version' && entry.pattern.length === offset + 2) return;
  if (['eval', 'exec', 'sudo', 'rm', 'psql', 'env', 'xargs', 'timeout', 'find', 'command', 'builtin', 'time', 'nice', 'nohup', 'stdbuf', 'watch', 'flock', 'setsid', 'ionice', 'busybox'].includes(basename)) {
    fail(`${label} : programme ou wrapper libre interdit en allow`);
  }
  if (['bash', 'sh', 'zsh', 'node', 'python', 'python3', 'ruby', 'perl', 'deno', 'bun'].includes(basename)) {
    if (typeof subcommand !== 'string' || subcommand.startsWith('scripts/') === false || /\.(?:mjs|cjs|js|sh|py|rb|pl|ts)$/u.test(subcommand) === false) {
      fail(`${label} : interpréteur libre ; nommer un script de dépôt fermé`);
    }
  }
  if (hasClaude && ['cat', 'head', 'tail', 'grep', 'rg', 'sed'].includes(basename)) envGuardPatterns(guardRoot).forEach(pattern => requireGuard(pattern, ['grep', 'rg', 'sed'].includes(basename) ? 'claudeAsk' : 'claudeDeny'));
  if (['mkdir', 'cp', 'touch'].includes(basename)) {
    if (entry.engines?.length !== 1 || entry.engines[0] !== 'claude' || entry.riskClass !== 'local-reversible') fail(`${label} : écritures relatives réservées à Claude avec gardes`);
    if (basename === 'mkdir' && subcommand !== '-p') fail(`${label} : seul mkdir -p est autorisable`);
    envGuardPatterns(guardRoot).forEach(pattern => requireGuard(pattern));
    for (const suffix of ['/*', '* /*', '"/*', '* "/*', "'/*", "* '/*", '*=/*']) requireGuard(`${guardRoot} ${suffix}`);
    for (const suffix of ['*..*', '*~*', '*$*', '*`*', '*\\*']) requireGuard(`${guardRoot} ${suffix}`, 'claudeAsk');
  }
  if (['rg', 'sed'].includes(basename)) {
    if (entry.engines?.length !== 1 || entry.riskClass !== 'read-only' || (basename === 'sed' && entry.engines[0] !== 'claude')) fail(`${label} : rg/sed exigent un moteur explicite ; sed réservé à Claude`);
    if (basename === 'rg' && hasClaude) optionGuardPatterns(guardRoot, '--pre').forEach(pattern => requireGuard(pattern, 'claudeAsk'));
    if (basename === 'rg' && !hasClaude && !entry.residualRisk?.includes('--pre')) fail(`${label} : residualRisk rg --pre requis pour Codex`);
    if (basename === 'sed') {
      if (subcommand !== '-n') fail(`${label} : seule la lecture sed -n est autorisable`);
      for (const option of ['-i', '--in-place']) optionGuardPatterns(guardRoot, option).forEach(pattern => requireGuard(pattern, 'claudeAsk'));
    }
  }
  if (basename === 'awk') {
    if (entry.engines?.length !== 1 || !hasClaude) fail(`${label} : awk réservé à Claude`);
    for (const suffix of ['*>*', '*|*', '*system*(*', '*getline*', '*@include*', '*@load*']) requireGuard(`${guardRoot} ${suffix}`, 'claudeAsk');
    for (const flag of ['-f', '-i', '-E', '-l', '--file', '--include', '--exec', '--load']) optionGuardPatterns(guardRoot, flag).forEach(pattern => requireGuard(pattern, 'claudeAsk'));
  }
  if (basename === 'uniq') fail(`${label} : uniq exige une forme exacte claudePattern sans argument positionnel`);
  if (basename === 'file' && hasClaude) for (const flag of ['-C', '--compile']) optionGuardPatterns(guardRoot, flag).forEach(pattern => requireGuard(pattern));
  if (entry.pattern.some(token => ['with-env.sh', 'with-supabase-env.sh'].includes(path.posix.basename(token)))) fail(`${label} : wrapper de chargement de secrets interdit en allow`);
  if (['git', 'gh', 'npm', 'npx', 'docker'].includes(basename) && (typeof subcommand !== 'string' || subcommand.startsWith('-'))) fail(`${label} : sous-commande littérale requise`);
  if (basename === 'npx' && !((subcommand === 'tsc' && operation === '--noEmit') || (subcommand === 'vitest' && operation === 'run') || (subcommand === 'playwright' && operation === 'test'))) fail(`${label} : npx libre interdit en allow`);
  if (basename === 'npm' && ['exec', 'x'].includes(subcommand)) fail(`${label} : npm exec libre interdit en allow`);
  if (basename === 'npm' && subcommand === 'run' && (typeof operation !== 'string' || operation.startsWith('-'))) fail(`${label} : nom de script npm requis`);
  if (basename === 'gh' && ['pr', 'run', 'repo', 'secret', 'variable', 'alias'].includes(subcommand) && typeof operation !== 'string') fail(`${label} : sous-commande gh requise`);
  if (basename === 'docker' && (['exec', 'run'].includes(subcommand) || (subcommand === 'compose' && (typeof operation !== 'string' || ['exec', 'run'].includes(operation))))) fail(`${label} : exécution Docker libre interdite en allow`);
}

export function validatePolicy(value, { core = false } = {}) {
  keys(value, ['version', 'entries'], 'Politique', ['commandPrefixes']);
  if (value.version !== 1 || Array.isArray(value.entries) === false) fail('Politique : version 1 et entries[] requis');
  if (Object.hasOwn(value, 'commandPrefixes')) {
    if (Array.isArray(value.commandPrefixes) === false || value.commandPrefixes.some(prefix => validPattern(prefix) === false)) fail('commandPrefixes : liste de préfixes argv non vides requise');
    if (new Set(value.commandPrefixes.map(prefix => JSON.stringify(prefix))).size !== value.commandPrefixes.length) fail('commandPrefixes : préfixe dupliqué');
    if (core && value.commandPrefixes.some(prefix => prefix.some(token => token.includes('/') || token.startsWith('.')))) fail('commandPrefixes : chemin interdit dans le socle global');
  }
  const patterns = new Set();
  value.entries.forEach((entry, index) => {
    const label = `Entrée ${index + 1}`;
    keys(entry, ['decision', 'riskClass', 'justification'], label, ['pattern', 'claudePattern', 'match', 'notMatch', 'residualRisk', 'claudeDeny', 'claudeAsk', 'engines']);
    if (Object.hasOwn(entry, 'engines') && (Array.isArray(entry.engines) === false || entry.engines.length === 0
      || entry.engines.some(engine => ENGINES.includes(engine) === false) || new Set(entry.engines).size !== entry.engines.length)) fail(`${label} : engines doit être un sous-ensemble non vide de codex, claude`);
    const native = Object.hasOwn(entry, 'pattern');
    const claudeOnly = Object.hasOwn(entry, 'claudePattern');
    if (claudeOnly && (native || entry.engines?.length !== 1 || entry.engines[0] !== 'claude' || typeof entry.claudePattern !== 'string'
      || /^[A-Za-z0-9_ *\-]+$/u.test(entry.claudePattern) === false)) fail(`${label} : claudePattern exige engines ["claude"], sans pattern argv`);
    if (native && validPattern(entry.pattern) === false) {
      fail(`${label} : pattern non vide de tokens littéraux simples requis`);
    }
    if (native || claudeOnly) {
      for (const engine of enginesFor(entry)) {
        const identity = JSON.stringify([engine, entry.pattern ?? entry.claudePattern]);
        if (patterns.has(identity)) fail(`${label} : pattern dupliqué pour ${engine}`);
        patterns.add(identity);
      }
    } else if (entry.decision !== 'forbidden' || nonempty(entry.residualRisk) === false || Object.hasOwn(entry, 'claudeDeny') === false || Object.hasOwn(entry, 'match') || Object.hasOwn(entry, 'notMatch')) {
      fail(`${label} : sans préfixe Codex, exiger forbidden, residualRisk et claudeDeny seuls`);
    }
    if (DECISIONS.includes(entry.decision) === false) fail(`${label} : décision invalide`);
    if (RISK_CLASSES.includes(entry.riskClass) === false) fail(`${label} : riskClass invalide`);
    if (nonempty(entry.justification) === false) fail(`${label} : justification requise`);
    if (Object.hasOwn(entry, 'residualRisk') && nonempty(entry.residualRisk) === false) fail(`${label} : residualRisk doit être une explication non vide`);
    const localTsx = entry.decision === 'forbidden' && native && entry.pattern.length === 1 && entry.pattern[0] === './node_modules/.bin/tsx';
    if (core && native && localTsx === false && entry.pattern.some(token => token.includes('/') || token.startsWith('.'))) fail(`${label} : chemin interdit dans le socle global`);
    for (const field of native || claudeOnly ? ['match', 'notMatch'] : []) {
      if (Array.isArray(entry[field]) === false || entry[field].length === 0 || entry[field].some(example => nonempty(example) === false)) fail(`${label} : ${field}[] non vide requis`);
      entry[field].forEach(tokenize);
    }
    validateAllow(entry, label);
    for (const field of Object.keys(CLAUDE_GUARDS).filter(key => Object.hasOwn(entry, key))) {
      if (Array.isArray(entry[field]) === false || entry[field].length === 0) fail(`${label} : ${field}[] non vide requis`);
      for (const guard of entry[field]) {
        keys(guard, ['pattern', 'match', 'notMatch'], `${label} / garde Claude`);
        if (typeof guard.pattern !== 'string' || /^[A-Za-z0-9_./:@%+,= *<>|()"'~$`\\\-]+$/u.test(guard.pattern) === false || /^[A-Za-z0-9_./:@%+,=\-]+\*?(?: |$)/u.test(guard.pattern) === false || ((native || claudeOnly) && guard.pattern.startsWith(`${native ? entry.pattern[0] : entry.claudePattern.split(' ')[0]} `) === false)) fail(`${label} : motif Claude avec programme littéral requis`);
        const executableDirectory = ['/bin/*', '/usr/bin/*', '/usr/local/bin/*', '/opt/homebrew/bin/*'].includes(guard.pattern) && entry.decision === 'forbidden';
        const relativeWriteGuard = native && ['mkdir', 'cp', 'touch'].includes(entry.pattern[0]) && entry.engines?.length === 1 && entry.engines[0] === 'claude';
        const envGuard = /(?: |["'/])\.env\*$/u.test(guard.pattern);
        if (core && executableDirectory === false && relativeWriteGuard === false && envGuard === false && guard.pattern.split(' ').some(token => token.includes('/') || token.startsWith('.'))) fail(`${label} : chemin interdit dans une garde du socle global`);
        for (const field of ['match', 'notMatch']) {
          if (Array.isArray(guard[field]) === false || guard[field].length === 0) fail(`${label} : exemples de garde Claude requis`);
          guard[field].forEach(example => {
            if (nonempty(example) === false || example.includes('\u0000')) fail(`${label} : exemple Claude non vide sans NUL requis`);
          });
        }
      }
    }
  });
  return value;
}

export function validateExamples(policy) {
  validatePolicy(policy);
  let count = 0;
  for (const entry of expandEntries(policy)) {
    validateAllow(entry, 'Entrée dérivée');
    for (const [examples, expected] of [[entry.match ?? [], true], [entry.notMatch ?? [], false]]) {
      for (const example of examples) {
        if (enginesFor(entry).includes('codex') && matchesPrefix(entry.pattern, tokenize(example)) !== expected) fail(`Exemple Codex incohérent : ${JSON.stringify(example)} pour ${entry.pattern.join(' ')}`);
        if (enginesFor(entry).includes('claude') && matchesClaude(claudePermission(entry), example) !== expected) fail(`Exemple Claude incohérent : ${JSON.stringify(example)} pour ${entry.claudePattern ?? entry.pattern.join(' ')}`);
        count += 1;
      }
    }
    for (const guard of enginesFor(entry).includes('claude') ? Object.keys(CLAUDE_GUARDS).flatMap(key => entry[key] ?? []) : []) {
      for (const [examples, expected] of [[guard.match, true], [guard.notMatch, false]]) {
        for (const example of examples) {
          if (matchesClaude(`Bash(${guard.pattern})`, example, { shellText: true }) !== expected) fail(`Exemple de garde Claude incohérent : ${JSON.stringify(example)}`);
          count += 1;
        }
      }
    }
  }
  return count;
}
export function decisionFor(policy, command, engine = 'codex') {
  if (ENGINES.includes(engine) === false) fail('Moteur inconnu');
  const argv = engine === 'codex' ? tokenize(command) : null;
  let decision;
  for (const entry of entriesFor(policy, engine)) {
    if (engine === 'claude' && entry.claudeDeny?.some(guard => matchesClaude(`Bash(${guard.pattern})`, command, { shellText: true }))) return 'forbidden';
    if (engine === 'claude' && entry.claudeAsk?.some(guard => matchesClaude(`Bash(${guard.pattern})`, command, { shellText: true })) && decision !== 'forbidden') decision = 'prompt';
    const matches = (entry.pattern || entry.claudePattern) && (engine === 'codex' ? matchesPrefix(entry.pattern, argv) : matchesClaude(claudePermission(entry), command, { shellText: true }));
    if (matches && (decision === undefined || DECISIONS.indexOf(entry.decision) > DECISIONS.indexOf(decision))) decision = entry.decision;
  }
  return decision;
}

export function generateCodex(policy) {
  validateExamples(policy);
  const header = `# Généré par agent-policy v${VERSION}. Ne pas éditer ; modifier la source JSON.\n`;
  // Une entrée explicite peut coïncider avec un miroir : fusionner ses exemples, pas ses décisions.
  const rules = new Map();
  for (const entry of entriesFor(policy, 'codex').filter(entry => entry.pattern)) {
    const key = JSON.stringify([entry.pattern, entry.decision]);
    const existing = rules.get(key);
    rules.set(key, existing ? { ...existing, match: [...new Set([...existing.match, ...entry.match])], notMatch: [...new Set([...existing.notMatch, ...entry.notMatch])] } : entry);
  }
  return header + [...rules.values()].map(entry => [
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
  for (const entry of entriesFor(policy, 'claude')) {
    if (entry.pattern || entry.claudePattern) permissions[CLAUDE_KEYS[entry.decision]].push(claudePermission(entry));
    for (const [field, key] of Object.entries(CLAUDE_GUARDS)) {
      for (const guard of entry[field] ?? []) permissions[key].push(`Bash(${guard.pattern})`);
    }
  }
  for (const key of Object.keys(permissions)) permissions[key] = [...new Set(permissions[key])];
  assertClaudeAllowPatterns(permissions);
  return permissions;
}
export function assertClaudeAllowPatterns(permissions) {
  for (const permission of permissions.allow) {
    const pattern = permission.slice(5, -1);
    if (pattern.includes('*') && (pattern.indexOf('*') !== pattern.length - 1 || /(?: |:)\*$/u.test(pattern) === false)) {
      const direct = stripRtk(pattern);
      const valid = GIT_C_COMMANDS.some(command => [`git -C * ${command}`, `git -C * ${command} *`].includes(direct));
      const root = pattern.slice(0, pattern.indexOf('git -C') + 'git -C'.length);
      const guarded = gitCMutationPatterns(root)
        .every(guard => permissions.ask?.includes(`Bash(${guard})`) || permissions.deny?.includes(`Bash(${guard})`))
        && GIT_C_OPTIONS.flatMap(option => optionGuardPatterns(root, option))
          .every(guard => permissions.ask?.includes(`Bash(${guard})`));
      if (!valid || !guarded) fail(`Claude : pas de joker interne dans un allow sans exception git -C gardée : ${permission}`);
    }
  }
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

export function assertClaudePostcondition(previous, result, generated) {
  const before = parseSettings(previous);
  const after = parseSettings(result);
  const lists = Object.values(CLAUDE_KEYS);
  const identical = (left, right, label) => {
    if (JSON.stringify(left) !== JSON.stringify(right)) fail(`Post-condition Claude : ${label}`);
  };
  identical(Object.keys(before), Object.keys(after).filter(key => key !== 'permissions' || Object.hasOwn(before, key)), 'ordre des réglages modifié');
  identical(Object.entries(before).filter(([key]) => key !== 'permissions'), Object.entries(after).filter(([key]) => key !== 'permissions'), 'réglages hors permissions modifiés');
  const oldPermissions = before.permissions ?? {};
  const newPermissions = after.permissions ?? {};
  identical(Object.keys(oldPermissions), Object.keys(newPermissions).filter(key => Object.hasOwn(oldPermissions, key) || lists.includes(key) === false), 'ordre des clés de permissions modifié');
  identical(Object.entries(oldPermissions).filter(([key]) => lists.includes(key) === false), Object.entries(newPermissions).filter(([key]) => lists.includes(key) === false), 'autres clés de permissions modifiées');
  for (const key of lists) {
    const oldList = oldPermissions[key] ?? [];
    const newList = newPermissions[key] ?? [];
    identical(oldList.filter(value => isBashPermission(value) === false), newList.filter(value => isBashPermission(value) === false), `entrées non-Bash de ${key} modifiées`);
    identical(generated[key], newList.filter(isBashPermission), `entrées Bash de ${key} différentes de la politique`);
  }
}

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
  if (previous === null) {
    const result = JSON.stringify({ permissions: generated }, null, 2) + '\n';
    assertClaudePostcondition(previous, result, generated);
    return result;
  }
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
  assertClaudePostcondition(previous, result, generated);
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
export function bundledCoreSnapshot() {
  const text = EMBEDDED_CORE_TEXT ?? readOptional(fileURLToPath(new URL('../', import.meta.url)), 'core-policy.json');
  if (text === null) fail('Socle embarqué absent');
  const policy = validatePolicy(JSON.parse(text), { core: true });
  validateExamples(policy);
  const metadata = JSON.stringify({ version: VERSION, sha256: createHash('sha256').update(text).digest('hex') }, null, 2) + '\n';
  return { text, policy, metadata };
}
export function loadProjectCore(root) {
  const snapshot = bundledCoreSnapshot();
  for (const [relative, expected] of [[PROJECT_FILES.core, snapshot.text], [PROJECT_FILES.coreVersion, snapshot.metadata]]) {
    if (readOptional(root, relative) !== expected) fail(`Écart avec le socle embarqué v${VERSION} : ${relative}. Exécuter agent-policy init --upgrade.`);
  }
  return snapshot.policy;
}

// Consommation autonome : chaque couche garde ses préfixes et ses moteurs.
// Une absence de règle n'autorise aucune sortie du sandbox du consommateur.
export function decisionForCommand(root, command, engine) {
  if (ENGINES.includes(engine) === false) fail('Moteur inconnu');
  tokenize(command); // Refuser les programmes shell composés, pour les deux moteurs.
  const core = loadProjectCore(root);
  const project = loadPolicy(root);
  validateExamples(project);
  let decision;
  for (const source of [core, project]) {
    const candidate = decisionFor(source, command, engine);
    if (DECISIONS.indexOf(candidate) > DECISIONS.indexOf(decision)) decision = candidate;
  }
  return decision;
}
export function projectOutputs(root) {
  loadProjectCore(root);
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
    const examples = [...new Set(entriesFor(policy, 'codex').flatMap(entry => [...(entry.match ?? []), ...(entry.notMatch ?? [])]))];
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
    console.log(`OK : fichiers synchronisés, ${result.count} exemples vérifiés sur leurs moteurs cibles ; Codex natif : ${result.codex}.`);
  } else {
    fail('Usage : node scripts/agent-policy/generate.mjs build | check [--codex]');
  }
}
if (process.argv[1] && process.argv[1] !== '-' && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runProjectCommand(process.argv.slice(2)); }
  catch (error) { console.error(`agent-policy : ${error.message}`); process.exitCode = 1; }
}
