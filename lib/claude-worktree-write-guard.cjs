#!/usr/bin/env node
// agent-policy write guard v1.3.0 — autonome ; actualiser par agent-policy init --upgrade.
// Repris de CoproOS/scripts/claude-worktree-write-guard.cjs et de ses tests.
// Contrôle préalable conservateur, pas un sandbox OS : les scripts du dépôt,
// hooks Git et outils configurés restent de confiance. Aucune commande exécutée ici.
const path = require('node:path');
const fs = require('node:fs');

function block(message) {
  process.stderr.write(JSON.stringify({ result: 'block', message }));
  process.exitCode = 2;
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
function resolvePath(root, cwd, value) {
  const expanded = value.replace(/^~(?=\/|$)/u, process.env.HOME || '~')
    .replace(/\$\{HOME\}|\$HOME(?=\/|$)/gu, process.env.HOME || '$HOME')
    .replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR(?=\/|$)/gu, root);
  if (/[\$`*?{}\[\]~]/u.test(expanded)) throw new Error('Chemin dynamique');
  return path.isAbsolute(expanded) ? expanded : `${cwd}/${expanded}`;
}

// Grammaire limitée : mots cités/échappés, séparateurs et redirections simples.
// Les substitutions, heredocs et structures shell ne sont jamais évalués.
function shellTokens(command) {
  const tokens = [];
  let word = '';
  let started = false;
  let quote = '';
  const flush = () => { if (started) tokens.push({ word }); word = ''; started = false; };
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
    else { word += char; started = true; }
  }
  if (quote) throw new Error('Citation incomplète');
  flush();
  return tokens;
}

const MUTATIONS = new Set(['rm', 'mv', 'cp', 'mkdir', 'rmdir', 'touch', 'install', 'ln', 'tee', 'truncate', 'dd', 'rsync', 'chmod', 'chown', 'chgrp', 'patch']);
const EXECUTION = new Set(['node', 'npx', 'tsx', 'python', 'python3', 'perl', 'ruby', 'php', 'bash', 'sh', 'zsh', 'source', '.']);
const GIT_READS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'grep', 'blame']);
const READ_PROGRAMS = new Set(['cat', 'ls', 'head', 'tail', 'rg', 'grep', 'sed', 'pwd', 'wc', 'stat', 'file', 'sort', 'find']);

function commandMutatesExternalPath(root, initialCwd, command) {
  const tokens = shellTokens(command);
  let cwd = initialCwd;
  let segment = [];
  const external = value => !isWithin(root, resolvePath(root, cwd, value));
  function inspect() {
    const args = [];
    for (let i = 0; i < segment.length; i += 1) {
      const token = segment[i];
      if (!token.op) { args.push(token.word); continue; }
      const target = segment[++i]?.word;
      if (target === undefined) throw new Error('Redirection incomplète');
      if (token.op === '<') continue;
      if (token.op === '>&' && /^(?:\d+|-)$/u.test(target)) continue;
      if (target !== '/dev/null' && external(target)) return true;
    }
    while (/^[A-Za-z_][A-Za-z_0-9]*=/u.test(args[0] ?? '')) args.shift();
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
    if (['if', 'then', 'else', 'for', 'while', 'until', 'case', 'function', 'eval', 'xargs'].includes(program)) throw new Error('Structure ou exécution shell opaque');
    if (program === 'cd' || program === 'pushd' || program === 'popd') {
      const target = args.filter(value => value !== '--')[1];
      if (program !== 'cd' || !target || target.startsWith('-')) throw new Error('Changement de répertoire opaque');
      cwd = canonical(resolvePath(root, cwd, target));
      return false;
    }
    if (EXECUTION.has(program) && args.slice(1).some(value => /^(?:-[^-]*[ec]|--eval)/u.test(value))) return true;
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
    if (!isWithin(root, cwd) || !isWithin(root, gitCwd)) return true;
    return args.some((value, index) => {
      // System interpreter binaries are not destinations. Their script argument is.
      if (index === 0) return !MUTATIONS.has(program) && !EXECUTION.has(program) && program !== 'git' && program !== 'npm' && value.includes('/') && external(value);
      const attachedPath = /^-[A-Za-z]((?:\/|\.\.?\/|~\/).*)$/u.exec(value)?.[1];
      if (value.startsWith('-') && !value.includes('=') && !attachedPath) return false;
      const candidate = attachedPath ?? (value.includes('=') ? value.slice(value.indexOf('=') + 1) : value);
      return candidate !== '' && external(candidate);
    });
  }
  for (const token of [...tokens, { op: ';' }]) {
    if (token.op && [';', '&&', '||', '|', '&'].includes(token.op)) {
      if (inspect()) return true;
      segment = [];
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
  const root = canonical(process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..'));
  const cwd = data.cwd || root;
  const input = data.tool_input || {};
  if (['Write', 'Edit', 'MultiEdit'].includes(data.tool_name)) {
    if (typeof input.file_path !== 'string' || !input.file_path || !isWithin(root, resolvePath(root, cwd, input.file_path))) {
      block('Écriture refusée : cible hors du worktree actif. Utilise .agent-tmp/ pour un artefact non commité.');
    }
  } else if (data.tool_name === 'Bash') {
    if (typeof input.command !== 'string' || commandMutatesExternalPath(root, cwd, input.command)) {
      block('Écriture ou exécution externe refusée : un agent ne modifie que son worktree actif.');
    }
  }
}
main().catch(() => block('Garde d’écriture : entrée, chemin ou commande opaque ; exécution refusée.'));
