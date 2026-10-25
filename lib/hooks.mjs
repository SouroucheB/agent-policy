import { isObject, parseSettings, jsonPositions, insertProperties } from './generate.mjs';

export const WRITE_GUARD_FILE = 'scripts/claude-worktree-write-guard.cjs';
export const ENV_GUARD_FILE = 'scripts/agent-env-read-guard.cjs';
export const CAST_GUARD_FILE = 'scripts/claude-cast-guard.cjs';
export const CURSOR_HOOKS_FILE = '.cursor/hooks.json';

const claudeCommand = file => `node "$CLAUDE_PROJECT_DIR/${file}"`;
const claudeHook = (matcher, file, timeout) => ({ matcher, hooks: [{ type: 'command', command: claudeCommand(file), timeout }] });
export const WRITE_GUARD_HOOK = claudeHook('Bash|Write|Edit|MultiEdit', WRITE_GUARD_FILE, 5);
export const ENV_GUARD_HOOK = claudeHook('Bash|Read|Grep', ENV_GUARD_FILE, 5);
export const CAST_GUARD_HOOK = claudeHook('Write|Edit|MultiEdit', CAST_GUARD_FILE, 30);
// Only these complete invocations belong to us, never a substring of another hook.
const invocations = file => [claudeCommand(file), `node "\${CLAUDE_PROJECT_DIR}/${file}"`, `node ${file}`, `node ./${file}`];
// Cursor lance les hooks de projet depuis la racine du dépôt.
const cursorHook = extra => ({ command: `node ${ENV_GUARD_FILE}`, ...extra, failClosed: true, timeout: 5 });
const cursorInvocations = [`node ${ENV_GUARD_FILE}`, `node ./${ENV_GUARD_FILE}`];

const CLAUDE = {
  label: 'Claude',
  nested: true,
  specs: [
    { event: 'PreToolUse', declaration: WRITE_GUARD_HOOK, commands: invocations(WRITE_GUARD_FILE) },
    { event: 'PreToolUse', declaration: ENV_GUARD_HOOK, commands: invocations(ENV_GUARD_FILE) },
    { event: 'PostToolUse', declaration: CAST_GUARD_HOOK, commands: invocations(CAST_GUARD_FILE) },
  ],
  base: {},
  parse(text) {
    const value = parseSettings(text);
    if (value.disableAllHooks === true) throw new Error('Claude : disableAllHooks empêche les gardes ; aucune écriture');
    return value;
  },
};
const CURSOR = {
  label: 'Cursor',
  nested: false,
  specs: [
    { event: 'beforeReadFile', declaration: cursorHook({}), commands: cursorInvocations },
    { event: 'beforeShellExecution', declaration: cursorHook({}), commands: cursorInvocations },
    { event: 'preToolUse', declaration: cursorHook({ matcher: 'Grep' }), commands: cursorInvocations },
  ],
  base: { version: 1 },
  parse(text) {
    const value = text === null ? {} : JSON.parse(text);
    if (isObject(value) === false || (text !== null && value.version !== 1)) throw new Error(`Cursor : objet ${CURSOR_HOOKS_FILE} de version 1 requis`);
    return value;
  },
};
export const CLAUDE_HOOKS = CLAUDE.specs;
export const CURSOR_HOOKS = CURSOR.specs;

const events = format => [...new Set(format.specs.map(spec => spec.event))];
function owns(format, spec, hook) {
  return isObject(hook) && spec.commands.includes(hook.command) && (format.nested ? hook.type === 'command' : [undefined, 'command'].includes(hook.type));
}
function settings(format, text) {
  const value = format.parse(text);
  if (Object.hasOwn(value, 'hooks') && !isObject(value.hooks)) throw new Error(`${format.label} : hooks doit être un objet`);
  for (const event of events(format).filter(name => Object.hasOwn(value.hooks ?? {}, name))) {
    const list = value.hooks[event];
    if (!Array.isArray(list) || list.some(entry => !isObject(entry) || (format.nested && !Array.isArray(entry.hooks)))) {
      throw new Error(`${format.label} : ${event} doit contenir des ${format.nested ? 'listes de hooks' : 'hooks'}`);
    }
  }
  return value;
}
// Déclarations possédées d'un événement, chacune ramenée à sa forme canonique isolée.
function declared(format, spec, list) {
  return list.flatMap(entry => format.nested
    ? entry.hooks.filter(hook => owns(format, spec, hook)).map(hook => ({ matcher: entry.matcher, hooks: [hook] }))
    : (owns(format, spec, entry) ? [entry] : []));
}
function withoutOwned(format, value, before) {
  const copy = structuredClone(value);
  for (const event of events(format)) {
    if (!Array.isArray(copy.hooks?.[event])) continue;
    const mine = hook => format.specs.some(spec => spec.event === event && owns(format, spec, hook));
    copy.hooks[event] = copy.hooks[event].flatMap(entry => {
      if (!format.nested) return mine(entry) ? [] : [entry];
      if (!entry.hooks.some(mine)) return [entry];
      const hooks = entry.hooks.filter(hook => !mine(hook));
      return hooks.length ? [{ ...entry, hooks }] : [];
    });
    if (!Object.hasOwn(before.hooks ?? {}, event)) delete copy.hooks[event];
  }
  if (!Object.hasOwn(before, 'hooks')) delete copy.hooks;
  return copy;
}
function assertPostcondition(format, previous, result) {
  const label = `Post-condition ${format.label} hook`;
  const before = previous === null ? format.base : settings(format, previous);
  const after = settings(format, result);
  for (const spec of format.specs) {
    if (JSON.stringify(declared(format, spec, after.hooks?.[spec.event] ?? [])) !== JSON.stringify([spec.declaration])) {
      throw new Error(`${label} : déclaration du garde différente`);
    }
  }
  // A missing parent may only be introduced to contain owned declarations.
  const mine = (event, hook) => format.specs.some(spec => spec.event === event && owns(format, spec, hook));
  if ((!Object.hasOwn(before, 'hooks') && Object.keys(after.hooks).some(key => !events(format).includes(key))) ||
      events(format).some(event => !Object.hasOwn(before.hooks ?? {}, event) && after.hooks[event].some(entry => format.nested
        ? entry.hooks.length === 0 || entry.hooks.some(hook => !mine(event, hook))
        : !mine(event, entry)))) {
    throw new Error(`${label} : autre hook ajouté`);
  }
  if (JSON.stringify(withoutOwned(format, before, before)) !== JSON.stringify(withoutOwned(format, after, before))) {
    throw new Error(`${label} : réglages, permissions ou autres hooks modifiés`);
  }
}

// Une déclaration ajoutée suit l'indentation du tableau qui la reçoit.
function formatted(text, node, value) {
  const leading = node.items.length ? text.slice(node.start + 1, node.items[0].start) : '';
  if (!leading.includes('\n')) return JSON.stringify(value);
  const indent = leading.slice(leading.lastIndexOf('\n') + 1);
  const unit = text.match(/\n([\t ]+)"/u)?.[1] ?? '  ';
  return JSON.stringify(value, null, unit).replaceAll('\n', (text.includes('\r\n') ? '\r\n' : '\n') + indent);
}
function editArray(text, node, render, extra = []) {
  const parts = node.items.flatMap((item, index) => {
    const raw = render(item, index);
    if (raw === null) return [];
    const leading = index === 0 ? text.slice(node.start + 1, item.start) : text.slice(node.items[index - 1].end, item.start).replace(/^\s*,/u, '');
    return [leading + raw];
  });
  const leading = node.items.length ? text.slice(node.start + 1, node.items[0].start) : '';
  const tail = text.slice(node.items.at(-1)?.end ?? node.start + 1, node.end - 1);
  return `[${[...parts, ...extra.map(raw => leading + raw)].join(',')}${tail}]`;
}
function ensure(format, text, spec) {
  const value = settings(format, text);
  const root = jsonPositions(text);
  const hooks = root.properties.get('hooks')?.value;
  const listNode = hooks?.properties.get(spec.event)?.value;
  if (!listNode) {
    const edit = hooks
      ? insertProperties(text, hooks, { [spec.event]: [spec.declaration] })
      : insertProperties(text, root, { hooks: { [spec.event]: [spec.declaration] } });
    return text.slice(0, edit.start) + edit.content + text.slice(edit.end);
  }
  const list = value.hooks[spec.event];
  // A canonical declaration, even amongst other hooks, needs no reformatting.
  if (JSON.stringify(declared(format, spec, list)) === JSON.stringify([spec.declaration])) return text;
  const content = editArray(text, listNode, (entryNode, index) => {
    const entry = list[index];
    if (!format.nested) return owns(format, spec, entry) ? null : text.slice(entryNode.start, entryNode.end);
    if (!entry.hooks.some(hook => owns(format, spec, hook))) return text.slice(entryNode.start, entryNode.end);
    if (entry.hooks.every(hook => owns(format, spec, hook))) return null;
    const nested = entryNode.properties.get('hooks').value;
    const updated = editArray(text, nested, (item, i) => owns(format, spec, entry.hooks[i]) ? null : text.slice(item.start, item.end));
    return text.slice(entryNode.start, nested.start) + updated + text.slice(nested.end, entryNode.end);
  }, [formatted(text, listNode, spec.declaration)]);
  return text.slice(0, listNode.start) + content + text.slice(listNode.end);
}
// Un fichier absent reçoit un rendu complet ; sinon seules les déclarations possédées changent.
function generate(format, previous) {
  settings(format, previous);
  let result;
  if (previous === null) {
    const hooks = {};
    for (const spec of format.specs) (hooks[spec.event] ??= []).push(spec.declaration);
    result = JSON.stringify({ ...format.base, hooks }, null, 2) + '\n';
  } else {
    result = format.specs.reduce((text, spec) => ensure(format, text, spec), previous);
  }
  assertPostcondition(format, previous, result);
  return result;
}

export function generateClaudeHooks(previous = null) { return generate(CLAUDE, previous); }
export function assertClaudeHooksPostcondition(previous, result) { assertPostcondition(CLAUDE, previous, result); }
export function generateCursorHooks(previous = null) { return generate(CURSOR, previous); }
export function assertCursorHooksPostcondition(previous, result) { assertPostcondition(CURSOR, previous, result); }
