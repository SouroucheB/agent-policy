#!/usr/bin/env node
// agent-policy write guard v1.4.0 — autonome ; actualiser par agent-policy init --upgrade.
// Repris de CoproOS/scripts/claude-worktree-write-guard.cjs et de ses tests.
// Contrôle préalable conservateur, pas un sandbox OS : les scripts du dépôt,
// hooks Git et outils configurés restent de confiance. Aucune commande exécutée ici.
const path = require('node:path');
const fs = require('node:fs');

function cursorSurface() {
  // Sortie native Cursor quand le garde est chargé via les hooks Claude tiers,
  // sauf appel imbriqué depuis .cursor/hooks/* (qui lit stderr + code de sortie).
  return Boolean(process.env.CURSOR_VERSION || process.env.CURSOR_AGENT)
    && process.env.CURSOR_HOOK_NESTED !== '1';
}

function block(message) {
  process.stderr.write(JSON.stringify({ result: 'block', message }));
  if (cursorSurface()) {
    process.stdout.write(JSON.stringify({
      permission: 'deny',
      user_message: message,
      agent_message: message,
    }));
  }
  process.exitCode = 2;
}

function allowCursor() {
  if (cursorSurface()) {
    process.stdout.write(JSON.stringify({ permission: 'allow' }));
  }
}

// Résoudre aussi les destinations absentes et les symlinks pendants. Ne pas
// normaliser "lien/.." avant de suivre le lien : le shell traverse d'abord le lien.
function canonical(target, depth = 0) {
  if (depth > 40) throw new Error('Boucle de liens symboliques');
  if (!path.isAbsolute(target)) throw new Error('Chemin absolu requis');
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep)) {
    if (!part || part === '.') continue;
    if (part === '..') { current = path.dirname(current); continue; }
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        const link = fs.readlinkSync(current);
        current = canonical(path.isAbsolute(link) ? link : `${path.dirname(current)}/${link}`, depth + 1);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
function isWithin(root, target) {
  const relative = path.relative(canonical(root), canonical(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
// Jokers que le shell développe hors guillemets ; cités ou échappés, ils sont littéraux.
const GLOB = /[*?{}\[\]]/u;
// `literal` : mot dont tous les jokers étaient cités (voir shellTokens). « $ », « ` » et « ~ »
// restent refusés même cités : le lexer ne prouve pas leur expansion entre guillemets doubles.
function resolvePath(root, cwd, value, literal = false) {
  const expanded = value.replace(/^~(?=\/|$)/u, process.env.HOME || '~')
    .replace(/\$\{HOME\}|\$HOME(?=\/|$)/gu, process.env.HOME || '$HOME')
    .replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR(?=\/|$)/gu, root);
  if (/[\$`~]/u.test(expanded) || (!literal && GLOB.test(expanded))) throw new Error('Chemin dynamique');
  return path.isAbsolute(expanded) ? expanded : `${cwd}/${expanded}`;
}

// Grammaire limitée : mots cités/échappés, séparateurs et redirections simples.
// Les substitutions, heredocs et structures shell ne sont jamais évalués.
function shellTokens(command) {
  const tokens = [];
  let word = '';
  let started = false;
  let quote = '';
  // Un joker non cité (bareGlob) est développé par le shell ; cité ou échappé, il est littéral.
  let bareGlob = false;
  const flush = () => { if (started) tokens.push({ word, literal: !bareGlob }); word = ''; started = false; bareGlob = false; };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if ((char === '`' || (char === '$' && command[i + 1] === '(')) && quote !== "'") throw new Error('Substitution shell');
    if (quote) {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"' && /["\\$`\n]/u.test(command[i + 1] ?? '')) word += command[++i] ?? '';
      else word += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === '\\') { started = true; if (++i >= command.length) throw new Error('Échappement incomplet'); if (command[i] !== '\n') word += command[i]; }
    else if (char === '#' && !started) { while (i < command.length && command[i] !== '\n') i += 1; flush(); tokens.push({ op: ';' }); }
    else if ('()'.includes(char)) throw new Error('Structure shell');
    else if (';|&<>\n'.includes(char)) {
      flush();
      let op = char;
      if ('|&<>'.includes(char) && command[i + 1] === char) op += command[++i];
      if ((op === '>' || op === '<' || op === '&') && command[i + 1] === '>') op += command[++i];
      if ((op === '>' || op === '<') && command[i + 1] === '&') op += command[++i];
      if (op.startsWith('<<')) throw new Error('Heredoc');
      tokens.push({ op: op === '\n' ? ';' : op });
    } else if (/\s/u.test(char)) flush();
    else { word += char; started = true; if (GLOB.test(char)) bareGlob = true; }
  }
  if (quote) throw new Error('Citation incomplète');
  flush();
  return tokens;
}

const MUTATIONS = new Set(['rm', 'mv', 'cp', 'mkdir', 'rmdir', 'touch', 'install', 'ln', 'tee', 'truncate', 'dd', 'rsync', 'chmod', 'chown', 'chgrp', 'patch']);
const EXECUTION = new Set(['node', 'npx', 'tsx', 'python', 'python3', 'perl', 'ruby', 'php', 'bash', 'sh', 'zsh', 'source', '.']);
const GIT_READS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'grep', 'blame']);
const READ_PROGRAMS = new Set(['cat', 'ls', 'head', 'tail', 'rg', 'grep', 'sed', 'pwd', 'wc', 'stat', 'file', 'sort', 'find']);
// Sous xargs, les arguments ajoutés par stdin restent inconnus. Ne pas traverser
// un lanceur, même lorsqu'un segment ordinaire sait le déballer (RTK, env…).
const XARGS_LAUNCHERS = new Set(['rtk', 'command', 'exec', 'sudo', 'env', 'xargs', 'eval', 'time', 'timeout', 'nice', 'nohup', 'npm', 'yarn', 'pnpm', 'bun', 'deno', 'awk', 'sed', 'cd', 'pushd', 'popd']);
const XARGS_FLAGS = new Set(['-0', '--null', '-r', '--no-run-if-empty', '-t', '--verbose', '-x']);
const XARGS_NUMBERS = new Set(['-n', '-L', '-P', '-s']);
// Plugins Claude Code installés : seuls ces points d'entrée s'exécutent, rien n'y est écrit.
// Chemins relatifs à ~/.claude/plugins/cache/ ; * remplace un nom de segment (la version).
const PLUGIN_INTERPRETERS = new Set(['python3', 'bash', 'node']);
const PLUGIN_SCRIPTS = [
  'claude-plugins-official/claude-security/*/scripts/*.py',
  'claude-plugins-official/claude-security/*/scripts/keep-waiting.sh',
];
// Même grammaire que validateTools : marketplace et plugin littéraux, ni . ni .. ensuite.
const PLUGIN_SCRIPT = /^[A-Za-z0-9@+_-][A-Za-z0-9@+._-]*\/[A-Za-z0-9@+_-][A-Za-z0-9@+._-]*(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9@+._*-]+)+$/u;

// Le dépôt complète la liste dans agent-policy/tools.json ; une source illisible n'ajoute rien.
function pluginScripts(root) {
  try {
    const declared = JSON.parse(fs.readFileSync(path.join(root, 'agent-policy/tools.json'), 'utf8')).pluginScripts;
    if (Array.isArray(declared) && declared.every(item => typeof item === 'string' && PLUGIN_SCRIPT.test(item))) return [...PLUGIN_SCRIPTS, ...declared];
  } catch { /* liste du socle seule */ }
  return PLUGIN_SCRIPTS;
}
function segmentMatches(pattern, name) {
  return new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('[^/]*')}$`, 'u').test(name);
}
// Fichier régulier d'un point d'entrée déclaré, liens résolus : un lien ou un .. qui sort est refusé.
function installedPluginScript(root, cwd, value) {
  if (!process.env.HOME || value.startsWith('-')) return false;
  const cache = path.join(process.env.HOME, '.claude', 'plugins', 'cache');
  const target = resolvePath(root, cwd, value);
  if (!fs.existsSync(cache) || !isWithin(cache, target)) return false;
  const parts = path.relative(canonical(cache), canonical(target)).split(path.sep);
  if (!pluginScripts(root).some(pattern => {
    const segments = pattern.split('/');
    return segments.length === parts.length && segments.every((segment, index) => segmentMatches(segment, parts[index]));
  })) return false;
  try { return fs.statSync(canonical(target)).isFile(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function xargsCommand(args) {
  let index = 1;
  while (index < args.length) {
    const option = args[index];
    if (option === '--') { index += 1; break; }
    if (!option.startsWith('-')) break;
    index += 1;
    if (XARGS_FLAGS.has(option)) continue;
    if (option === '-E') {
      if (args[index] === undefined) throw new Error('Option xargs incomplète');
      // Une expansion non résolue pourrait ajouter des mots et déplacer le
      // programme réel. Le lexer ne prouve pas les expansions des valeurs citées.
      if (/[$`*?{}\[\]~\\]/u.test(args[index])) throw new Error('Valeur xargs opaque');
      index += 1;
      continue;
    }
    if (XARGS_NUMBERS.has(option)) {
      const number = args[index++];
      if (!/^[0-9]+$/u.test(number ?? '') || (option !== '-P' && !/[1-9]/u.test(number))) throw new Error('Nombre xargs invalide');
      continue;
    }
    // Liste fermée : ni remplacement (-J/-I/-i/--replace), ni forme collée,
    // ni abréviation longue, ni option inconnue.
    throw new Error('Option xargs opaque');
  }
  const program = args[index];
  if (!program || program.startsWith('-') || /[\s{}$`*?\[\]~\\=]/u.test(program)) throw new Error('Programme xargs opaque');
  return args.slice(index);
}

function commandMutatesExternalPath(root, initialCwd, command) {
  const tokens = shellTokens(command);
  let cwd = initialCwd;
  let segment = [];
  // Mots dont les jokers étaient tous cités, sauf si le même texte apparaît aussi non cité.
  const bare = new Set(tokens.filter(token => token.word !== undefined && !token.literal).map(token => token.word));
  const literals = new Set(tokens.filter(token => token.literal && GLOB.test(token.word) && !bare.has(token.word)).map(token => token.word));
  const external = (value, quotedLiteral = false) =>
    !isWithin(root, resolvePath(root, cwd, value, quotedLiteral && literals.has(value)));
  // piped : l'entrée standard du segment vient du segment précédent.
  function inspect(piped) {
    const args = [];
    let stdin = piped;
    for (let i = 0; i < segment.length; i += 1) {
      const token = segment[i];
      if (!token.op) { args.push(token.word); continue; }
      const target = segment[++i]?.word;
      if (target === undefined) throw new Error('Redirection incomplète');
      if (token.op.startsWith('<')) stdin = true;
      if (token.op === '<') continue;
      if (token.op === '>&' && /^(?:\d+|-)$/u.test(target)) continue;
      if (target !== '/dev/null' && external(target)) return true;
    }
    return inspectArgs(args, false, stdin);
  }
  function inspectArgs(args, fromXargs = false, stdin = false) {
    if (fromXargs && XARGS_LAUNCHERS.has(path.basename(args[0]))) return true;
    // Une affectation préfixée peut désigner une sortie : sa valeur est contrôlée comme un argument.
    const assignments = [];
    while (/^[A-Za-z_][A-Za-z_0-9]*=/u.test(args[0] ?? '')) assignments.push(args.shift());
    while (['rtk', 'command', 'exec', 'sudo', 'env'].includes(args[0])) {
      const wrapper = args.shift();
      if (wrapper === 'rtk' && args[0] === 'proxy') args.shift();
      // Unknown wrapper options/assignments can change paths or execution.
      if (args[0]?.startsWith('-') || args[0]?.includes('=')) throw new Error('Wrapper opaque');
    }
    if (!args.length) return false;
    const program = path.basename(args[0]);
    if (args[0].includes('/') && external(args[0]) &&
        (!['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'].includes(path.dirname(args[0])) ||
         ![...MUTATIONS, ...EXECUTION, ...READ_PROGRAMS, 'git', 'npm'].includes(program))) return true;
    if (program === 'xargs') return inspectArgs(xargsCommand(args), true);
    if (['if', 'then', 'else', 'for', 'while', 'until', 'case', 'function', 'eval'].includes(program)) throw new Error('Structure ou exécution shell opaque');
    if (program === 'cd' || program === 'pushd' || program === 'popd') {
      const target = args.filter(value => value !== '--')[1];
      if (program !== 'cd' || !target || target.startsWith('-')) throw new Error('Changement de répertoire opaque');
      cwd = canonical(resolvePath(root, cwd, target));
      return false;
    }
    // Un point d'entrée de plugin suit directement l'interpréteur et ne lit pas un programme sur stdin.
    const pluginScript = !fromXargs && !stdin && PLUGIN_INTERPRETERS.has(program) && args[1] !== undefined && installedPluginScript(root, cwd, args[1]);
    // Après un script de plugin, -config ou -verbose appartiennent au script, pas à l'interpréteur.
    if (EXECUTION.has(program) && !pluginScript && args.slice(1).some(value => /^(?:-[^-]*[ec]|--eval)/u.test(value))) return true;
    // Sans script, un interpréteur exécute ce qu'il lit sur son entrée standard : code opaque.
    if (stdin && EXECUTION.has(program) && program !== 'npx' && args.slice(1).every(value => value.startsWith('-'))) return true;
    if (program === 'git' && args.includes('config') && args.some(value => ['--global', '--system'].includes(value))) return true;
    if (program === 'npm' && (args.includes('config') || args.includes('link') || args.some(value => ['-g', '--global'].includes(value)))) return true;

    let gitIndex = 1;
    let gitCwd = cwd;
    if (program === 'git') {
      while (args[gitIndex] === '-C') {
        if (!args[gitIndex + 1]) throw new Error('git -C incomplet');
        gitCwd = canonical(resolvePath(root, gitCwd, args[gitIndex + 1]));
        gitIndex += 2;
      }
    }
    const gitCommand = args[gitIndex];
    const gitRead = GIT_READS.has(gitCommand) ||
      (['worktree', 'stash'].includes(gitCommand) && args[gitIndex + 1] === 'list') ||
      (gitCommand === 'remote' && args[gitIndex + 1] === '-v');
    const mutates = MUTATIONS.has(program) || EXECUTION.has(program) ||
      (program === 'git' && (!gitRead || args.some(value => /^--(?:output|ext|upload|open-files)|^-c/u.test(value)))) ||
      (program === 'npm' && args.some(value => ['install', 'ci', 'run', 'exec'].includes(value))) ||
      (program === 'sed' && args.some(value => /^(?:-[^-]*i|--in-place)/u.test(value))) ||
      (program === 'find' && args.some(value => /^-(?:delete|exec|ok)/u.test(value))) ||
      (program === 'sort' && args.some(value => /^-o|^--output/u.test(value))) ||
      (program === 'curl' && args.some(value => /^-[oO]|^--output/u.test(value))) ||
      args[0].includes('/') && !READ_PROGRAMS.has(program);
    if (!mutates) return false;
    if (fromXargs) return true;
    if (!isWithin(root, cwd) || !isWithin(root, gitCwd)) return true;
    const escapes = value => {
      const attachedPath = /^-[A-Za-z]((?:\/|\.\.?\/|~\/).*)$/u.exec(value)?.[1];
      if (value.startsWith('-') && !value.includes('=') && !attachedPath) return false;
      const candidate = attachedPath ?? (value.includes('=') ? value.slice(value.indexOf('=') + 1) : value);
      // Seule une commande git (add, rm, restore, checkout -- …) lit un chemin cité comme littéral ;
      // les autres programmes gardent le refus de tout joker, même cité.
      return candidate !== '' && external(candidate, program === 'git' && candidate === value);
    };
    // Un script de plugin reçoit des arguments libres : chaque fragment de chemin (out:/x, a=b,/c) est contrôlé.
    const pluginEscapes = value => value.split(/[=:,]/u).some(part => {
      const candidate = part.startsWith('-') ? /[~/].*$/u.exec(part)?.[0] ?? '' : part;
      return /^[~/.$`]|\//u.test(candidate) && external(candidate);
    });
    const checked = pluginScript ? pluginEscapes : escapes;
    if (assignments.some(value => checked(value.slice(value.indexOf('=') + 1)))) return true;
    return args.some((value, index) => {
      // System interpreter binaries are not destinations. Their script argument is.
      if (index === 0) return !MUTATIONS.has(program) && !EXECUTION.has(program) && program !== 'git' && program !== 'npm' && value.includes('/') && external(value);
      // Seul le point d'entrée, juste après l'interpréteur, est exempté ; sorties et autres arguments restent contrôlés.
      if (index === 1 && pluginScript) return false;
      return checked(value);
    });
  }
  let piped = false;
  for (const token of [...tokens, { op: ';' }]) {
    if (token.op && [';', '&&', '||', '|', '&'].includes(token.op)) {
      if (inspect(piped)) return true;
      segment = [];
      piped = token.op === '|';
    } else segment.push(token);
  }
  return false;
}

async function main() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object') throw new Error('Entrée du hook invalide');
  // The deposited file lives in scripts/, including in linked worktrees.
  const root = canonical(
    process.env.CLAUDE_PROJECT_DIR
    || process.env.CURSOR_PROJECT_DIR
    || path.resolve(__dirname, '..'),
  );
  const cwd = data.cwd || root;
  const input = data.tool_input || {};
  const toolName = data.tool_name === 'Shell' ? 'Bash' : data.tool_name;
  const filePath = typeof input.file_path === 'string' && input.file_path
    ? input.file_path
    : (typeof input.path === 'string' ? input.path : '');
  if (['Write', 'Edit', 'MultiEdit', 'Delete'].includes(toolName)) {
    // Le chemin d'un outil de fichier n'est pas développé par un shell : « [id] » (route dynamique
    // Next.js) y est littéral. « ~ », « $ » et « ` » restent résolus ou refusés comme pour Bash.
    if (!filePath || !isWithin(root, resolvePath(root, cwd, filePath, true))) {
      block('Écriture refusée : cible hors du worktree actif. Utilise .agent-tmp/ pour un artefact non commité.');
      return;
    }
  } else if (toolName === 'Bash') {
    if (typeof input.command !== 'string' || commandMutatesExternalPath(root, cwd, input.command)) {
      block('Écriture ou exécution externe refusée : un agent ne modifie que son worktree actif.');
      return;
    }
  }
  allowCursor();
}
main().catch(() => block('Garde d’écriture : entrée, chemin ou commande opaque ; exécution refusée.'));
