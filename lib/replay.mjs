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
const UNSUPPORTED_CAUSES = {
  redirection: 'redirection vers fichier (ou autre redirection non prise en charge)',
  substitution: 'substitution',
  structure: 'structure shell',
  heredoc: 'heredoc',
};
const JAVASCRIPT_CAUSES = {
  variable: 'variable',
  concatenation: 'concaténation',
  interpolation: 'gabarit avec interpolation',
  call: 'appel calculant la valeur',
  expression: 'autre expression non littérale',
  arguments: 'objet ou arguments non pris en charge',
  syntax: 'syntaxe lexicale non prise en charge ou incomplète',
  'no-shell-call': 'aucun appel shell direct reconnu',
};

// Seulement des catégories fixes, jamais de token libre issu de l'historique.
const PROGRAMS = new Set(['awk', 'basename', 'cat', 'cd', 'column', 'comm', 'cp', 'cut', 'date', 'df', 'diff', 'dig', 'dirname', 'du', 'echo', 'env', 'file', 'find', 'grep', 'head', 'jq', 'ls', 'lsof', 'mkdir', 'node', 'pgrep', 'printf', 'pwd', 'python', 'python3', 'realpath', 'rg', 'rm', 'sed', 'sort', 'sqlite3', 'stat', 'tail', 'touch', 'tr', 'uniq', 'wc', 'which', 'xxd', 'sleep', 'kill', 'open', 'curl', 'bash', 'sh', 'chmod', 'mv', 'tee', 'xargs', 'time', 'brew', 'supabase', 'psql']);
const SUBCOMMANDS = {
  git: new Set(['add', 'branch', 'checkout', 'clean', 'commit', 'config', 'diff', 'fetch', 'gc', 'grep', 'log', 'ls-files', 'ls-tree', 'merge', 'merge-tree', 'pull', 'push', 'rebase', 'remote', 'reset', 'restore', 'rev-parse', 'show', 'stash', 'status', 'switch', 'tag', 'worktree']),
  gh: new Set(['pr', 'run', 'repo', 'workflow', 'secret', 'variable']),
  npm: new Set(['run', 'ci', 'install', 'audit', 'view', 'test']),
  npx: new Set(['tsc', 'vitest', 'playwright', 'supabase', 'tsx']),
  docker: new Set(['ps', 'compose', 'run', 'exec', 'rm', 'rmi', 'system', 'volume']),
};
// Lire au plus quatre mots (rtk proxy programme sous-commande). Les guillemets
// et échappements sont décodés, jamais les expansions, alias ou programmes.
function familyWords(command) {
  const words = [];
  let word = '', quote = '';
  const flush = () => {
    if (!word) return;
    try { words.push(tokenize(word)[0]); } catch { words.push(undefined); }
    word = '';
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote === "'") { word += c; if (c === "'") quote = ''; continue; }
    if (c === '\\') { word += c + (command[++i] ?? ''); continue; }
    if (quote === '"') { word += c; if (c === '"') quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; word += c; continue; }
    if (';&|<>\n'.includes(c)) break;
    if (/\s/u.test(c)) { flush(); if (words.length === 4) return words; }
    else word += c;
  }
  flush();
  return words;
}
export function commandFamily(command) {
  const tokens = familyWords(command.trim());
  const prefix = [];
  if (tokens[0] === 'rtk') { prefix.push(tokens.shift()); if (tokens[0] === 'proxy') prefix.push(tokens.shift()); }
  const program = tokens.shift();
  if (program?.startsWith('./scripts/') || program?.startsWith('scripts/')) return [...prefix, 'script du dépôt'].join(' ');
  if (PROGRAMS.has(program)) return [...prefix, program].join(' ');
  if (Object.hasOwn(SUBCOMMANDS, program)) {
    if (program === 'git' && tokens[0] === '-C') return [...prefix, 'git -C'].join(' ');
    return [...prefix, program, ...(SUBCOMMANDS[program].has(tokens[0]) ? [tokens[0]] : [])].join(' ');
  }
  if (prefix.length && ['tsc', 'vitest', 'playwright', 'read', 'gain', 'session', 'discover'].includes(program)) return [...prefix, program].join(' ');
  return prefix.length ? prefix.join(' ') : 'autre';
}

// Le sous-ensemble analysé contient des commandes simples séparées par &&, ||,
// ;, saut de ligne ou |. Seules quatre redirections bénignes sont retirées,
// hors guillemets, sans fusionner les mots de part et d'autre. Le premier
// obstacle rencontré donne la cause ; aucun fragment libre ne quitte l'analyse.
function analyzeShell(command) {
  const unsupported = cause => ({ parts: null, cause });
  if (typeof command !== 'string' || command.includes('\0')) return unsupported('structure');
  let quote = '', word = '', trailingSeparator = '';
  let words = [];
  const parts = [];
  const flushWord = () => { if (word) words.push(word); word = ''; };
  const flushPart = () => {
    flushWord();
    if (!words.length || /^(?:if|then|else|fi|for|while|until|do|done|case|esac|function|source|\.|export)$/u.test(words[0])) return false;
    parts.push(words.join(' '));
    words = [];
    return true;
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote === "'") { word += c; if (c === "'") quote = ''; continue; }
    if (c === '\\') {
      if (i + 1 === command.length) return unsupported('structure');
      word += c + command[++i];
      continue;
    }
    if (c === '`' || (c === '$' && ['(', '{'].includes(command[i + 1]))) return unsupported('substitution');
    if (quote === '"') { word += c; if (c === '"') quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; word += c; continue; }
    if ('<>'.includes(c) && command[i + 1] === '(') return unsupported('substitution');
    if (c === '<' && command[i + 1] === '<') return unsupported('heredoc');
    if ('<>'.includes(c) || (c === '&' && command[i + 1] === '>')) {
      // Un IO_NUMBER est un mot entier non cité, adjacent à < ou >.
      // Dans "file2>/dev/null", 2 appartient au nom, pas au descripteur.
      const fd = '<>'.includes(c) && /^\d+$/u.test(word) ? word : '';
      if (fd) word = '';
      const redirect = (fd + command.slice(i)).match(/^(?:2>&1|(?:2>|>|&>)[ \t]*\/dev\/null)(?=$|[\s;&|<>])/u);
      if (!redirect) return unsupported('redirection');
      flushWord();
      i += redirect[0].length - fd.length - 1;
      continue;
    }
    if ('(){}'.includes(c) || (c === '#' && !word)) return unsupported('structure');
    if (';&|\n'.includes(c)) {
      if (!flushPart()) return unsupported('structure');
      trailingSeparator = c;
      if (command[i + 1] === c && '&|'.includes(c)) i += 1;
      else if (c === '&') return unsupported('structure');
      continue;
    }
    if (/\s/u.test(c)) flushWord();
    else { word += c; trailingSeparator = ''; }
  }
  if (quote) return unsupported('structure');
  if (word || words.length) {
    if (!flushPart()) return unsupported('structure');
  } else if (!parts.length || ![';', '\n'].includes(trailingSeparator)) return unsupported('structure');
  return { parts };
}
export function splitShell(command) { return analyzeShell(command).parts; }

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
    const { parts, cause } = analyzeShell(command);
    if (!parts) {
      // Conserver un refus explicite (heredoc notamment), jamais un allow issu
      // d'un simple préfixe sur du shell dont on ignore les autres opérations.
      const direct = simple(command.trim());
      return { verdict: ['forbidden', 'prompt'].includes(direct) ? direct : 'aucune', unsupported: true, cause };
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

// Analyse lexicale uniquement : pas de résolution des variables, de flot de
// contrôle ou d'objets JavaScript. Les chaînes/commentaires ne peuvent créer de
// faux appels. Les groupes sont appariés pour borner chaque valeur de propriété.
// Un slash hors chaîne/commentaire est volontairement non pris en charge :
// distinguer partout division et regexp demanderait le contexte grammatical.
function javascriptTokens(source) {
  let offset = 0;
  const invalid = () => { throw new Error('JavaScript non analysable'); };
  const quoted = (quote, depth) => {
    offset += 1;
    let value = '';
    const expressions = [];
    while (offset < source.length) {
      const c = source[offset++];
      if (c === quote) return { kind: expressions.length ? 'interpolated' : quote === '`' ? 'template' : 'string', value, expressions };
      if (quote === '`' && c === '$' && source[offset] === '{') {
        offset += 1;
        expressions.push(scan('}', depth + 1));
        continue;
      }
      if (c === '\r' || c === '\n') {
        if (quote !== '`') invalid();
        if (c === '\r' && source[offset] === '\n') offset += 1;
        value += '\n';
        continue;
      }
      if (c !== '\\') { value += c; continue; }
      if (offset === source.length) invalid();
      const escaped = source[offset++];
      if (escaped === '\n' || escaped === '\r' || escaped === '\u2028' || escaped === '\u2029') {
        if (escaped === '\r' && source[offset] === '\n') offset += 1;
        continue;
      }
      const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
      if (/[0-9]/u.test(escaped) && (escaped !== '0' || /[0-9]/u.test(source[offset] ?? ''))) invalid();
      if (escaped === 'x' || escaped === 'u') {
        const braced = escaped === 'u' && source[offset] === '{';
        if (braced) offset += 1;
        const end = braced ? source.indexOf('}', offset) : offset + (escaped === 'x' ? 2 : 4);
        const hex = source.slice(offset, end);
        if (end < offset || end > source.length || !/^[0-9a-f]+$/iu.test(hex)) invalid();
        const code = Number.parseInt(hex, 16);
        if (code > 0x10ffff) invalid();
        value += String.fromCodePoint(code);
        offset = end + (braced ? 1 : 0);
      } else value += Object.hasOwn(escapes, escaped) ? escapes[escaped] : escaped;
    }
    invalid();
  };
  const scan = (stop = '', depth = 0) => {
    if (depth > 128) invalid();
    const tokens = [], stack = [];
    while (offset < source.length) {
      const c = source[offset];
      if (/\s/u.test(c)) { offset += 1; continue; }
      if (source.startsWith('//', offset)) {
        offset += 2;
        while (offset < source.length && !/[\r\n\u2028\u2029]/u.test(source[offset])) offset += 1;
        continue;
      }
      if (source.startsWith('/*', offset)) {
        const end = source.indexOf('*/', offset + 2);
        if (end === -1) invalid();
        offset = end + 2;
        continue;
      }
      if (['"', "'", '`'].includes(c)) { tokens.push(quoted(c, depth + stack.length)); continue; }
      if (c === '/' || c === '\\') invalid();
      if ('([{'.includes(c)) {
        if (depth + stack.length >= 128) invalid();
        stack.push(tokens.length);
      } else if (')]}'.includes(c)) {
        if (!stack.length) {
          if (c === stop) { offset += 1; return tokens; }
          invalid();
        }
        const open = tokens[stack.pop()];
        if ('([{'.indexOf(open.value) !== ')]}'.indexOf(c)) invalid();
        open.close = tokens.length;
      }
      const word = source.slice(offset).match(/^[a-zA-Z_$][\w$]*/u)?.[0];
      if (word) { tokens.push({ kind: 'word', value: word }); offset += word.length; continue; }
      const number = source.slice(offset).match(/^\d[\w.]*/u)?.[0];
      if (number) { tokens.push({ kind: 'number', value: number }); offset += number.length; continue; }
      if (!'()[]{}.,:;?=+-*%!&|^~<>'.includes(c)) invalid();
      const punct = ['...', '?.', '=>', '++', '--'].find(value => source.startsWith(value, offset)) ?? c;
      tokens.push({ kind: 'punct', value: punct });
      offset += punct.length;
    }
    if (stop || stack.length) invalid();
    return tokens;
  };
  return scan();
}

const isPunct = (token, value) => token?.kind === 'punct' && token.value === value;
function commaRanges(tokens, start, end) {
  const ranges = [];
  let from = start;
  for (let i = start; i < end; i += 1) {
    if (isPunct(tokens[i], ',')) { ranges.push([from, i]); from = i + 1; }
    else if (tokens[i].close !== undefined) i = tokens[i].close;
  }
  if (from < end) ranges.push([from, end]); // La virgule finale est permise.
  return ranges;
}
function nonLiteralCause(tokens) {
  if (tokens.some(token => token.kind === 'interpolated')) return 'interpolation';
  if (tokens.some(token => isPunct(token, '+'))) return 'concatenation';
  if (tokens.length === 1 && tokens[0].kind === 'word' && !['true', 'false', 'null'].includes(tokens[0].value)) return 'variable';
  if (tokens.some((token, i) => isPunct(token, '(') && i > 0)) return 'call';
  return 'expression';
}
function literalShellArgument(tokens, start, end) {
  const args = commaRanges(tokens, start, end);
  if (args.length !== 1) return { cause: 'arguments' };
  const [from, to] = args[0];
  if (!isPunct(tokens[from], '{') || tokens[from].close !== to - 1) {
    return { cause: nonLiteralCause(tokens.slice(from, to)) };
  }
  let commandValue;
  const keys = new Set();
  for (const [key, limit] of commaRanges(tokens, from + 1, to - 1)) {
    // Refuser spreads, clés calculées, accesseurs et doublons : ils pourraient
    // remplacer cmd/command. Une seule de ces deux clés doit être présente.
    const property = tokens[key];
    if (!['word', 'string'].includes(property?.kind) || !isPunct(tokens[key + 1], ':') || key + 2 >= limit || keys.has(property.value)) return { cause: 'arguments' };
    keys.add(property.value);
    if (['cmd', 'command'].includes(property.value)) {
      if (commandValue) return { cause: 'arguments' };
      commandValue = tokens.slice(key + 2, limit);
    }
  }
  if (!commandValue) return { cause: 'arguments' };
  if (commandValue.length === 1 && ['string', 'template'].includes(commandValue[0].kind)) return { command: commandValue[0].value };
  return { cause: nonLiteralCause(commandValue) };
}
function javascriptCommands(input) {
  if (typeof input !== 'string') return { commands: [], causes: ['syntax'] };
  let tokens;
  try { tokens = javascriptTokens(input); }
  catch { return { commands: [], causes: ['syntax'] }; }
  const commands = [], causes = [];
  const visit = sequence => {
    for (let i = 0; i < sequence.length; i += 1) {
      // Le texte d'un gabarit reste opaque ; ses expressions contiennent du
      // code lexicalement délimité, dont les appels directs sont aussi relevés.
      for (const expression of sequence[i].expressions ?? []) visit(expression);
      if (sequence[i].kind !== 'word' || sequence[i].value !== 'tools' || !isPunct(sequence[i + 1], '.') || sequence[i + 2]?.kind !== 'word' || !SHELL_TOOLS.has(sequence[i + 2].value) || !isPunct(sequence[i + 3], '(')) continue;
      if (isPunct(sequence[i - 1], '.') || isPunct(sequence[i - 1], '?.') || sequence[i - 1]?.value === 'new') continue;
      const result = literalShellArgument(sequence, i + 4, sequence[i + 3].close);
      if (result.cause) causes.push(result.cause);
      else commands.push(result.command);
    }
  };
  visit(tokens);
  if (!commands.length && !causes.length) causes.push('no-shell-call');
  return { commands, causes };
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
    // Garder le groupe pour dédupliquer le conteneur une fois, sans perdre ses
    // multiples commandes (même identiques) ni ses appels non littéraux.
    calls.push({ engine: 'codex', id: record.payload.call_id, container: true, ...javascriptCommands(record.payload.input) });
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
    unsupportedByCause: Object.fromEntries(Object.keys(UNSUPPORTED_CAUSES).map(cause => [cause, 0])),
    containersWithoutCommands: 0,
    containersByCause: Object.fromEntries(Object.keys(JAVASCRIPT_CAUSES).map(cause => [cause, 0])),
    javascriptUnsupportedByCause: Object.fromEntries(Object.keys(JAVASCRIPT_CAUSES).map(cause => [cause, 0])),
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
          if (call.container) {
            stats.containers += 1;
            for (const cause of call.causes) stats.javascriptUnsupportedByCause[cause] += 1;
            if (!call.commands.length) {
              stats.containersWithoutCommands += 1;
              stats.containersByCause[call.causes[0]] += 1;
            }
          }
          for (const command of call.container ? call.commands : [call.command]) {
            if (typeof command !== 'string' || !command.trim()) { result.invalidCalls += 1; continue; }
            const { verdict, unsupported, cause } = evaluators[call.engine](command);
            stats.total += 1;
            stats.verdicts[verdict] += 1;
            if (unsupported) { stats.unsupported += 1; stats.unsupportedByCause[cause] += 1; }
            const family = commandFamily(command);
            stats.families[verdict].set(family, (stats.families[verdict].get(family) ?? 0) + 1);
          }
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
    lines.push(`${engine} : ${stats.total} commandes ; ${stats.unsupported} syntaxes non analysées ; ${stats.containers} conteneurs JavaScript, dont ${stats.containersWithoutCommands} sans commande littérale.`);
    for (const [cause, label] of Object.entries(UNSUPPORTED_CAUSES)) lines.push(`  Non analysées — ${label} : ${stats.unsupportedByCause[cause]}`);
    if (stats.containers) {
      for (const [cause, label] of Object.entries(JAVASCRIPT_CAUSES)) lines.push(`  JavaScript — ${label} : ${stats.javascriptUnsupportedByCause[cause]} fragments non analysés ; ${stats.containersByCause[cause]} conteneurs sans commande littérale (première cause).`);
    }
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
