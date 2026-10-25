#!/usr/bin/env node
// agent-policy env read guard v1.4.0 — autonome ; actualiser par agent-policy init --upgrade.
// Hooks Claude (PreToolUse Bash|Read|Grep) et Cursor (beforeReadFile, beforeShellExecution,
// preToolUse Grep) : toute référence à un fichier .env ou .env.* est refusée, sauf *.example.
// Contrôle préalable conservateur, pas un sandbox : aucune commande exécutée, aucun .env ouvert ici.
const path = require('node:path');
const fs = require('node:fs');

// Séparateurs shell et de chemin. Guillemets et antislashs sont retirés avant la recherche :
// .e""nv, '.env' et \.env désignent le même fichier pour le shell.
const SEPARATORS = '\\s=:<>|;&(){},/`$';
const ENV_NAME = new RegExp(`(?:^|[${SEPARATORS}])(\\.env(?:[.*?\\[][^${SEPARATORS}]*)?)(?=$|[${SEPARATORS}])`, 'gu');
// Motif shell pouvant se développer en .env : .*, .e*, .en?, .[e]nv, .{e,x}nv…
const ENV_GLOB = new RegExp(`(?:^|[${SEPARATORS}])\\.(?:e(?:n(?:v)?)?)?[*?\\[{]`, 'u');
const CURSOR_EVENTS = ['beforeReadFile', 'beforeShellExecution', 'preToolUse'];
const WRAPPERS = ['rtk', 'command', 'exec', 'sudo', 'env', 'time', 'nohup'];
// Options de grep, rg et git grep dont la valeur n'est ni le motif ni un chemin lu en premier.
const SEARCH_VALUES = new Set(['-A', '-B', '-C', '-m', '-t', '-g', '--after-context', '--before-context', '--context', '--max-count', '--type', '--type-not', '--glob', '--iglob']);
const MESSAGES = { git: new Set(['-m', '--message']), gh: new Set(['-t', '--title', '-b', '--body']) };

function mentionsEnv(text, glob) {
  const plain = text.replace(/['"\\]/gu, '');
  for (const match of plain.matchAll(ENV_NAME)) if (!match[1].endsWith('.example')) return true;
  return glob && ENV_GLOB.test(plain);
}
// Un lien symbolique vers .env est refusé comme le fichier lui-même.
function realTarget(cwd, value) {
  try { return fs.realpathSync(path.resolve(cwd, value)); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return ''; throw error; }
}
function refused(cwd, targets) {
  return targets.some(({ text, glob = false, file = false }) => mentionsEnv(text, glob) || (file && mentionsEnv(realTarget(cwd, text), false)));
}
function text(value, label) {
  if (typeof value !== 'string' || value === '') throw new Error(`Champ ${label} invalide`);
  return value;
}

// Mots d'une commande simple, cibles de redirection marquées. Une substitution, un heredoc
// ou une structure rend la commande opaque : null, et le texte entier est alors contrôlé.
function shellSegments(command) {
  const segments = [[]];
  let word = '';
  let started = false;
  let quote = '';
  let redirect = false;
  const flush = () => {
    if (started) { segments.at(-1).push({ text: word, redirect }); redirect = false; }
    word = '';
    started = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if ((char === '`' || (char === '$' && command[i + 1] === '(')) && quote !== "'") return null;
    if (quote) {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"' && /["\\$`\n]/u.test(command[i + 1] ?? '')) word += command[++i] ?? '';
      else word += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === '\\') { started = true; i += 1; if (i < command.length && command[i] !== '\n') word += command[i]; }
    else if ('()'.includes(char) || (char === '<' && command[i + 1] === '<')) return null;
    else if (char === '<' || char === '>' || (char === '&' && command[i + 1] === '>')) {
      flush();
      while ('<>&|'.includes(command[i + 1] ?? ' ')) i += 1;
      redirect = true;
    } else if (';|&\n'.includes(char)) { flush(); redirect = false; segments.push([]); }
    else if (/\s/u.test(char)) flush();
    else { word += char; started = true; }
  }
  if (quote) return null;
  flush();
  return segments.filter(words => words.length > 0);
}
// Indices des mots qui ne désignent aucun fichier : motif de grep/rg, texte d'un message git ou gh.
function exempt(words) {
  const free = new Set();
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[index]?.text ?? '')) index += 1;
  while (WRAPPERS.includes(words[index]?.text)) index += words[index].text === 'rtk' && words[index + 1]?.text === 'proxy' ? 2 : 1;
  const program = path.basename(words[index]?.text ?? '');
  const search = start => {
    let given = false;
    for (let k = start; k < words.length; k += 1) {
      const value = words[k].text;
      if (words[k].redirect) continue;
      if (value === '--') { if (!given && k + 1 < words.length) free.add(k + 1); return; }
      if (value === '-e' || value === '--regexp') { free.add(k + 1); given = true; k += 1; }
      else if (value.startsWith('--regexp=') || /^-e./u.test(value)) { free.add(k); given = true; }
      else if (value === '-f' || value === '--file') { given = true; k += 1; }
      else if (value.startsWith('--file=')) given = true;
      else if (SEARCH_VALUES.has(value)) k += 1;
      else if (value.startsWith('-') && value !== '-') continue;
      else if (!given) { free.add(k); given = true; }
    }
  };
  const messages = (start, names, cluster) => {
    for (let k = start; k < words.length; k += 1) {
      const value = words[k].text;
      if (words[k].redirect) continue;
      if (names.has(value) || (cluster && /^-[A-Za-z]+m$/u.test(value))) { free.add(k + 1); k += 1; }
      else if ([...names].some(name => name.startsWith('--') && value.startsWith(`${name}=`))) free.add(k);
    }
  };
  if (['grep', 'egrep', 'fgrep', 'rg'].includes(program)) search(index + 1);
  else if (program === 'gh') messages(index + 1, MESSAGES.gh, false);
  else if (program === 'git') {
    let k = index + 1;
    while (words[k]?.text.startsWith('-')) k += ['-C', '-c'].includes(words[k].text) ? 2 : 1;
    const subcommand = words[k]?.text;
    if (subcommand === 'grep') search(k + 1);
    else if (['commit', 'tag', 'merge', 'stash', 'notes'].includes(subcommand)) messages(k + 1, MESSAGES.git, subcommand === 'commit');
  }
  return free;
}
function commandTargets(command) {
  const segments = shellSegments(command);
  if (segments === null) return [{ text: command, glob: true }];
  return segments.flatMap(words => {
    const free = exempt(words);
    return words.filter((word, index) => !free.has(index)).map(word => ({ text: word.text, glob: true }));
  });
}

// Les wrappers cités viennent de la couche du dépôt ; une source illisible garde le refus.
function message(root) {
  let wrappers = [];
  try {
    const tools = JSON.parse(fs.readFileSync(path.join(root, 'agent-policy/tools.json'), 'utf8'));
    if (Array.isArray(tools.envWrappers) && tools.envWrappers.every(item => typeof item === 'string' && /^[^\u0000-\u001f]{1,200}$/u.test(item))) wrappers = tools.envWrappers;
  } catch { /* message générique */ }
  return `Lecture de .env refusée : un agent ne lit, ne cherche ni ne charge un fichier .env ou .env.*. ${wrappers.length
    ? `Lancer la commande par un wrapper du dépôt : ${wrappers.join(', ')}.`
    : 'Aucun wrapper déclaré dans agent-policy/tools.json (envWrappers) : demander au user.'}`;
}

function claudeTargets(data) {
  const input = data.tool_input || {};
  if (data.tool_name === 'Bash') return commandTargets(text(input.command, 'command'));
  if (data.tool_name === 'Read') return [{ text: text(input.file_path, 'file_path'), file: true }];
  if (data.tool_name === 'Grep') {
    return [['path', { file: true }], ['glob', { glob: true }]].filter(([key]) => input[key] !== undefined)
      .map(([key, kind]) => ({ text: text(input[key], key), ...kind }));
  }
  return [];
}
function cursorTargets(data) {
  if (data.hook_event_name === 'beforeShellExecution') return commandTargets(text(data.command, 'command'));
  if (data.hook_event_name === 'beforeReadFile') {
    const attachments = Array.isArray(data.attachments) ? data.attachments : [];
    return [data.file_path, ...attachments.map(item => item?.file_path)].filter(value => value !== undefined)
      .map(value => ({ text: text(value, 'file_path'), file: true }));
  }
  // preToolUse Grep : champs non documentés ; le motif cherché n'est pas un chemin, tout le reste est inspecté.
  return Object.entries(data.tool_input || {}).filter(([key, value]) => typeof value === 'string' && !/pattern|query|regex|search/iu.test(key))
    .map(([key, value]) => ({ text: value, glob: /glob|path|include|file/iu.test(key) }));
}

// Cursor : "allow" laisse passer l'action, comme les exemples officiels des hooks ; il
// n'approuve rien que l'allowlist ou le mode d'exécution soumettent à accord.
function respond(cursor, event, verdict) {
  if (verdict === null) {
    if (cursor) process.stdout.write(JSON.stringify({ permission: 'allow' }));
    return;
  }
  if (cursor) {
    process.stdout.write(JSON.stringify(event === 'beforeReadFile'
      ? { permission: 'deny', user_message: verdict }
      : { permission: 'deny', user_message: verdict, agent_message: verdict }));
  }
  // Claude bloque sur le code 2 et transmet stderr ; Cursor y voit aussi un refus.
  if (!cursor || !CURSOR_EVENTS.includes(event)) {
    process.stderr.write(JSON.stringify({ result: 'block', message: verdict }));
    process.exitCode = 2;
  }
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const data = JSON.parse(input);
  if (!data || typeof data !== 'object') throw new Error('Entrée du hook invalide');
  const root = process.env.CLAUDE_PROJECT_DIR || process.env.CURSOR_PROJECT_DIR || path.resolve(__dirname, '..');
  const native = CURSOR_EVENTS.includes(data.hook_event_name);
  // Hooks Claude chargés par Cursor : réponse au format Cursor en plus du code de sortie.
  const cursor = native || Boolean(process.env.CURSOR_VERSION);
  const cwd = typeof data.cwd === 'string' && data.cwd ? data.cwd : root;
  const targets = native ? cursorTargets(data) : claudeTargets(data);
  respond(cursor, data.hook_event_name, refused(cwd, targets) ? message(root) : null);
}
main().catch(() => {
  const verdict = 'Garde .env : entrée ou chemin opaque ; lecture refusée.';
  if (process.env.CURSOR_VERSION) process.stdout.write(JSON.stringify({ permission: 'deny', user_message: verdict, agent_message: verdict }));
  process.stderr.write(JSON.stringify({ result: 'block', message: verdict }));
  process.exitCode = 2;
});
