#!/usr/bin/env node
// agent-policy env read guard v1.4.0 — autonome ; actualiser par agent-policy init --upgrade.
// Hooks Claude (PreToolUse Bash|Read|Grep) et Cursor (beforeReadFile, beforeShellExecution,
// preToolUse Grep) : toute référence à un fichier .env ou .env.* est refusée. Contrôle
// préalable conservateur, pas un sandbox : aucune commande exécutée, aucun .env ouvert ici.
const path = require('node:path');
const fs = require('node:fs');

// Séparateurs shell et de chemin. Guillemets et antislashs sont retirés avant la recherche :
// .e""nv, '.env' et \.env désignent le même fichier pour le shell.
const SEPARATORS = '\\s=:<>|;&(){},/`$';
const ENV_NAME = new RegExp(`(?:^|[${SEPARATORS}])\\.env(?:[.*?\\[][^${SEPARATORS}]*)?(?=$|[${SEPARATORS}])`, 'u');
// Motif shell pouvant se développer en .env : .*, .e*, .en?, .[e]nv, .{e,x}nv…
const ENV_GLOB = new RegExp(`(?:^|[${SEPARATORS}])\\.(?:e(?:n(?:v)?)?)?[*?\\[{]`, 'u');
const CURSOR_EVENTS = ['beforeReadFile', 'beforeShellExecution', 'preToolUse'];

function mentionsEnv(text, glob) {
  const plain = text.replace(/['"\\]/gu, '');
  return ENV_NAME.test(plain) || (glob && ENV_GLOB.test(plain));
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
  if (data.tool_name === 'Bash') return [{ text: text(input.command, 'command'), glob: true }];
  if (data.tool_name === 'Read') return [{ text: text(input.file_path, 'file_path'), file: true }];
  if (data.tool_name === 'Grep') {
    return [['path', { file: true }], ['glob', { glob: true }]].filter(([key]) => input[key] !== undefined)
      .map(([key, kind]) => ({ text: text(input[key], key), ...kind }));
  }
  return [];
}
function cursorTargets(data) {
  if (data.hook_event_name === 'beforeShellExecution') return [{ text: text(data.command, 'command'), glob: true }];
  if (data.hook_event_name === 'beforeReadFile') {
    const attachments = Array.isArray(data.attachments) ? data.attachments : [];
    return [data.file_path, ...attachments.map(item => item?.file_path)].filter(value => value !== undefined)
      .map(value => ({ text: text(value, 'file_path'), file: true }));
  }
  // preToolUse Grep : champs non documentés ; tout texte est inspecté, les jokers des chemins aussi.
  return Object.entries(data.tool_input || {}).filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => ({ text: value, glob: /glob|path|include|file/iu.test(key) }));
}

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
