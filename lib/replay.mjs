// Lecture seule : aucun appel au shell, aucune évaluation du code des historiques.
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  bundledCoreSnapshot, loadPolicy, PROJECT_FILES, readOptional, validateExamples,
  generatePermissions, expandEntries, matchesPrefix, tokenize, compileClaudePermission,
} from './generate.mjs';

const VERDICTS = ['allow', 'aucune', 'prompt', 'forbidden'];
const strictest = decisions => VERDICTS[Math.max(...decisions.map(value => VERDICTS.indexOf(value ?? 'aucune')))];
const SHELL_TOOLS = new Set(['exec_command', 'shell_command', 'shell']);

// Seulement des catégories fixes, jamais de token libre issu de l'historique.
const PROGRAMS = new Set(['awk', 'basename', 'cat', 'cd', 'column', 'comm', 'cp', 'cut', 'date', 'df', 'diff', 'dig', 'dirname', 'du', 'echo', 'env', 'file', 'find', 'grep', 'head', 'jq', 'ls', 'lsof', 'mkdir', 'node', 'pgrep', 'printf', 'pwd', 'python', 'python3', 'realpath', 'rg', 'rm', 'sed', 'sort', 'sqlite3', 'stat', 'tail', 'touch', 'tr', 'uniq', 'wc', 'which', 'xxd']);
const SUBCOMMANDS = {
  git: new Set(['add', 'branch', 'checkout', 'clean', 'commit', 'config', 'diff', 'fetch', 'gc', 'grep', 'log', 'ls-files', 'ls-tree', 'merge', 'merge-tree', 'pull', 'push', 'rebase', 'remote', 'reset', 'restore', 'rev-parse', 'show', 'stash', 'status', 'switch', 'tag', 'worktree']),
  gh: new Set(['pr', 'run', 'repo', 'workflow', 'secret', 'variable']),
  npm: new Set(['run', 'ci', 'install', 'audit', 'view', 'test']),
  npx: new Set(['tsc', 'vitest', 'playwright', 'supabase', 'tsx']),
  docker: new Set(['ps', 'compose', 'run', 'exec', 'rm', 'rmi', 'system', 'volume']),
};
export function commandFamily(command) {
  const tokens = command.trim().split(/\s+/u);
  const prefix = [];
  if (tokens[0] === 'rtk') { prefix.push(tokens.shift()); if (tokens[0] === 'proxy') prefix.push(tokens.shift()); }
  const program = tokens.shift();
  if (PROGRAMS.has(program)) return [...prefix, program].join(' ');
  if (Object.hasOwn(SUBCOMMANDS, program)) {
    if (program === 'git' && tokens[0] === '-C') return [...prefix, 'git -C'].join(' ');
    return [...prefix, program, ...(SUBCOMMANDS[program].has(tokens[0]) ? [tokens[0]] : [])].join(' ');
  }
  if (prefix.length && ['tsc', 'vitest', 'playwright', 'read', 'gain', 'session', 'discover'].includes(program)) return [...prefix, program].join(' ');
  return prefix.length ? prefix.join(' ') : 'autre';
}

// Le sous-ensemble analysé contient des commandes simples séparées par &&, ||,
// ;, saut de ligne ou |. Les substitutions, redirections et structures shell
// restent non classées plutôt que d'inventer un allow.
export function splitShell(command) {
  if (typeof command !== 'string' || command.includes('\0')) return null;
  let quote = '', start = 0;
  const parts = [];
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote === "'") { if (c === "'") quote = ''; continue; }
    if (c === '\\') { if (++i === command.length) return null; continue; }
    if (c === '`' || (c === '$' && ['(', '{'].includes(command[i + 1]))) return null;
    if (quote === '"') { if (c === '"') quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if ('<>(){}'.includes(c)) return null;
    if (';&|\n'.includes(c)) {
      const part = command.slice(start, i).trim();
      if (!part) return null;
      parts.push(part);
      if (command[i + 1] === c && '&|'.includes(c)) i += 1;
      else if (c === '&') return null;
      start = i + 1;
    }
  }
  if (quote) return null;
  const tail = command.slice(start).trim();
  if (tail) parts.push(tail);
  else if (start && !/[;\n]\s*$/u.test(command)) return null;
  if (!parts.length || parts.some(part => /^(?:if|then|else|fi|for|while|until|do|done|case|esac|function|source|\.|export)\b/u.test(part))) return null;
  return parts;
}

export function replayEvaluator(sources, engine) {
  if (!['claude', 'codex'].includes(engine)) throw new Error('Moteur de rejeu inconnu');
  const permissions = engine === 'claude' ? sources.map(generatePermissions) : [];
  const groups = ['deny', 'ask', 'allow'].map(key => permissions.flatMap(p => p[key]).map(compileClaudePermission));
  const entries = sources.flatMap(source => expandEntries(source)).filter(e => e.pattern && (e.engines ?? ['codex', 'claude']).includes('codex'));
  const simple = command => {
    if (engine === 'claude') {
      for (let i = 0; i < groups.length; i += 1) if (groups[i].some(match => match(command))) return ['forbidden', 'prompt', 'allow'][i];
      return 'aucune';
    }
    try {
      const argv = tokenize(command);
      const matches = entries.filter(e => matchesPrefix(e.pattern, argv)).map(e => e.decision);
      return matches.length ? strictest(matches) : 'aucune';
    } catch { return 'aucune'; }
  };
  return command => {
    const parts = splitShell(command);
    if (!parts) {
      // Conserver un refus explicite (heredoc notamment), jamais un allow issu
      // d'un simple préfixe sur du shell dont on ignore les autres opérations.
      const direct = simple(command.trim());
      return { verdict: ['forbidden', 'prompt'].includes(direct) ? direct : 'aucune', unsupported: true };
    }
    return { verdict: strictest(parts.map(simple)), unsupported: false };
  };
}

function parseArguments(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}
function shellCommand(name, args) {
  if (!SHELL_TOOLS.has(name) || !args) return null;
  if (typeof args.cmd === 'string') return args.cmd;
  if (typeof args.command === 'string') return args.command;
  const argv = args.command;
  if (Array.isArray(argv) && argv.every(x => typeof x === 'string')) {
    if (['bash', 'sh', 'zsh', '/bin/bash', '/bin/sh', '/bin/zsh'].includes(argv[0]) && ['-c', '-lc'].includes(argv[1]) && argv.length === 3) return argv[2];
    return argv.map(x => `'${x.replaceAll("'", "'\\''")}'`).join(' ');
  }
  return null;
}
export function historyCalls(record) {
  const calls = [];
  if ((record?.type === 'assistant' || record?.message?.role === 'assistant') && Array.isArray(record?.message?.content)) {
    for (const block of record.message.content) {
      if (block?.type === 'tool_use' && block.name === 'Bash') calls.push({ engine: 'claude', id: block.id, command: typeof block.input?.command === 'string' ? block.input.command : null });
    }
  }
  if (record?.type === 'response_item' && record.payload?.type === 'function_call') {
    const p = record.payload;
    const name = typeof p.name === 'string' ? p.name.split('.').at(-1) : undefined;
    if (SHELL_TOOLS.has(name)) calls.push({ engine: 'codex', id: p.call_id, command: shellCommand(name, parseArguments(p.arguments)) });
  }
  if (record?.type === 'response_item' && record.payload?.type === 'custom_tool_call' && ['exec', 'functions.exec'].includes(record.payload.name)) {
    // Le runtime récent encapsule les outils dans du JavaScript. On ne l'évalue
    // jamais : ce conteneur est compté séparément, pas assimilé à une commande.
    calls.push({ engine: 'codex', id: record.payload.call_id, container: true });
  }
  return calls;
}

function* historyFiles(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    if (component.startsWith('.env')) throw new Error('Chemin d’historique .env interdit');
    current = path.join(current, component);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Lien symbolique d’historique refusé');
  }
  if (!fs.statSync(absolute).isDirectory()) throw new Error('Dossier d’historique requis');
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.env') || entry.isSymbolicLink()) continue;
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) yield* historyFiles(child);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield child;
  }
}
export async function replayHistory(directory, root = process.cwd()) {
  const core = bundledCoreSnapshot().policy;
  const sources = [core];
  if (readOptional(root, PROJECT_FILES.policy) !== null) {
    const project = loadPolicy(root);
    validateExamples(project);
    sources.push(project);
  }
  const evaluators = Object.fromEntries(['claude', 'codex'].map(engine => [engine, replayEvaluator(sources, engine)]));
  const engines = Object.fromEntries(['claude', 'codex'].map(engine => [engine, {
    total: 0, verdicts: Object.fromEntries(VERDICTS.map(verdict => [verdict, 0])),
    families: Object.fromEntries(VERDICTS.map(verdict => [verdict, new Map()])), unsupported: 0, containers: 0,
  }]));
  const result = { files: 0, invalidLines: 0, invalidCalls: 0, duplicates: 0, project: sources.length === 2, engines };
  const seen = new Set();
  for (const file of historyFiles(directory)) {
    result.files += 1;
    const stream = fs.createReadStream(file, { encoding: 'utf8', flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { result.invalidLines += 1; continue; }
        for (const call of historyCalls(record)) {
          const key = typeof call.id === 'string' && call.id ? `${call.engine}:${call.id}` : null;
          if (key && seen.has(key)) { result.duplicates += 1; continue; }
          if (key) seen.add(key);
          const stats = engines[call.engine];
          if (call.container) { stats.containers += 1; continue; }
          if (typeof call.command !== 'string' || !call.command.trim()) { result.invalidCalls += 1; continue; }
          const { verdict, unsupported } = evaluators[call.engine](call.command);
          stats.total += 1;
          stats.verdicts[verdict] += 1;
          if (unsupported) stats.unsupported += 1;
          const family = commandFamily(call.command);
          stats.families[verdict].set(family, (stats.families[verdict].get(family) ?? 0) + 1);
        }
      }
    } finally { lines.close(); stream.destroy(); }
  }
  return result;
}
export function renderReplay(result) {
  const lines = [`Rejeu statique : ${result.files} fichiers JSONL ; socle${result.project ? ' + couche du dépôt' : ' seul (couche absente)'}.`];
  for (const [engine, stats] of Object.entries(result.engines)) {
    if (!stats.total && !stats.containers) continue;
    lines.push(`${engine} : ${stats.total} commandes ; ${stats.unsupported} syntaxes non analysées ; ${stats.containers} conteneurs JavaScript non analysés.`);
    for (const verdict of VERDICTS) {
      const count = stats.verdicts[verdict];
      const ratio = stats.total ? (100 * count / stats.total).toFixed(1) : '0.0';
      lines.push(`  ${verdict} : ${count} (${ratio} %)`);
      for (const [family, frequency] of [...stats.families[verdict]].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10)) lines.push(`    ${family} […] : ${frequency}`);
    }
  }
  lines.push(`Ignorés : ${result.invalidLines} lignes invalides, ${result.invalidCalls} appels invalides, ${result.duplicates} doublons.`);
  lines.push('aucune = absence de règle (demande Claude, sandbox Codex). Les débuts affichés sont des catégories fixes ; aucun argument ni commande intégrale.');
  return lines.join('\n');
}
export async function runReplayCommand(args, root = process.cwd()) {
  if (args.length !== 1 || !args[0] || args[0].startsWith('--')) throw new Error('Usage : agent-policy replay <dossier-historique>');
  try { console.log(renderReplay(await replayHistory(args[0], root))); }
  catch { throw new Error('Rejeu impossible : vérifier le dossier JSONL et la politique du dépôt. Aucun contenu d’historique affiché.'); }
}
