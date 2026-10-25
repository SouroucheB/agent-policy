#!/usr/bin/env node
// agent-policy cast guard v1.4.0 — autonome ; actualiser par agent-policy init --upgrade.
// Hook Claude PostToolUse (Write|Edit|MultiEdit) : compte par l'API TypeScript les `as T`
// (hors `as const`), `<T>x` et `x!` d'un fichier src/**/*.ts(x) après écriture et refuse une
// hausse par rapport à HEAD (zéro pour un fichier nouveau). TypeScript est chargé depuis
// node_modules du dépôt ; sans lui, la garde est inactive.
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const SOURCE = /^src\/(?:[^/]+\/)*[^/]+\.tsx?$/u;
const CITED = 20;

function block(message) {
  process.stderr.write(message);
  process.exitCode = 2;
}
function loadTypeScript(root) {
  const location = path.join(root, 'node_modules', 'typescript');
  if (!fs.existsSync(path.join(location, 'package.json'))) return null;
  return require(location);
}

function casts(ts, fileName, text) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const isConst = type => type.kind === ts.SyntaxKind.TypeReference && ts.isIdentifier(type.typeName) && type.typeName.text === 'const';
  const visit = node => {
    const assertion = node.kind === ts.SyntaxKind.AsExpression || node.kind === ts.SyntaxKind.TypeAssertionExpression;
    if ((assertion && !isConst(node.type)) || node.kind === ts.SyntaxKind.NonNullExpression) {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: node.getText(source).replace(/\s+/gu, ' ') });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
// Version commitée : chemin relatif au dossier du projet, y compris dans un sous-dossier du dépôt Git.
function committed(root, relative) {
  const result = spawnSync('git', ['show', `HEAD:./${relative}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result.status === 0 ? result.stdout : null;
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const data = JSON.parse(input);
  if (!data || typeof data !== 'object') throw new Error('Entrée du hook invalide');
  if (!['Write', 'Edit', 'MultiEdit'].includes(data.tool_name)) return;
  const filePath = data.tool_input?.file_path;
  if (typeof filePath !== 'string' || filePath === '') throw new Error('file_path absent');
  const root = fs.realpathSync(process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..'));
  const absolute = path.resolve(typeof data.cwd === 'string' && data.cwd ? data.cwd : root, filePath);
  if (!fs.existsSync(absolute)) return;
  const relative = path.relative(root, fs.realpathSync(absolute)).split(path.sep).join('/');
  if (!SOURCE.test(relative)) return;
  const ts = loadTypeScript(root);
  if (ts === null) return;

  const current = casts(ts, relative, fs.readFileSync(absolute, 'utf8'));
  const previousText = committed(root, relative);
  const previous = previousText === null ? [] : casts(ts, relative, previousText);
  if (current.length <= previous.length) return;
  // Les occurrences au-delà du compte de HEAD pour un même texte sont citées comme nouvelles.
  const remaining = new Map();
  for (const cast of previous) remaining.set(cast.text, (remaining.get(cast.text) ?? 0) + 1);
  const added = current.filter(cast => {
    const count = remaining.get(cast.text) ?? 0;
    remaining.set(cast.text, count - 1);
    return count <= 0;
  });
  block([
    `Cast TypeScript ajouté dans ${relative} : ${current.length} assertion(s) de type contre ${previous.length} dans HEAD.`,
    ...added.slice(0, CITED).map(cast => `  ligne ${cast.line} : ${cast.text}`),
    ...(added.length > CITED ? [`  … ${added.length - CITED} autre(s)`] : []),
    'Retirer le cast : typer la valeur à la source, garde de type, satisfies ou validation. `as const` reste admis.',
  ].join('\n'));
}
main().catch(error => block(`Garde des casts : contrôle impossible (${error.message}) ; vérifier le fichier écrit.`));
