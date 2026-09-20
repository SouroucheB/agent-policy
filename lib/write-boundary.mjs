import { isObject, parseSettings, jsonPositions, insertProperties } from './generate.mjs';

export const WRITE_GUARD_FILE = 'scripts/claude-worktree-write-guard.cjs';
export const WRITE_GUARD_HOOK = {
  matcher: 'Bash|Write|Edit|MultiEdit',
  hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/${WRITE_GUARD_FILE}"`, timeout: 5 }],
};

// Only these complete invocations belong to us, never a substring of another hook.
function owned(hook) {
  return isObject(hook) && hook.type === 'command' && [
    `node "$CLAUDE_PROJECT_DIR/${WRITE_GUARD_FILE}"`,
    `node "\${CLAUDE_PROJECT_DIR}/${WRITE_GUARD_FILE}"`,
    `node ${WRITE_GUARD_FILE}`, `node ./${WRITE_GUARD_FILE}`,
  ].includes(hook.command);
}
function settings(text) {
  const value = parseSettings(text);
  if (Object.hasOwn(value, 'hooks') && !isObject(value.hooks)) throw new Error('Claude : hooks doit être un objet');
  if (Object.hasOwn(value.hooks ?? {}, 'PreToolUse')) {
    if (!Array.isArray(value.hooks.PreToolUse) || value.hooks.PreToolUse.some(group => !isObject(group) || !Array.isArray(group.hooks))) {
      throw new Error('Claude : PreToolUse doit contenir des listes de hooks');
    }
  }
  if (value.disableAllHooks === true) throw new Error('Claude : disableAllHooks empêche la frontière d’écriture ; aucune écriture');
  return value;
}
function withoutOwned(value, before) {
  const copy = structuredClone(value);
  if (copy.hooks?.PreToolUse) {
    copy.hooks.PreToolUse = copy.hooks.PreToolUse.flatMap(group => {
      if (!group.hooks.some(owned)) return [group];
      const hooks = group.hooks.filter(hook => !owned(hook));
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (!Object.hasOwn(before.hooks ?? {}, 'PreToolUse')) delete copy.hooks.PreToolUse;
  }
  if (!Object.hasOwn(before, 'hooks')) delete copy.hooks;
  return copy;
}
export function assertWriteGuardPostcondition(previous, result) {
  const before = settings(previous);
  const after = settings(result);
  const groups = after.hooks?.PreToolUse ?? [];
  const ours = groups.flatMap(group => group.hooks.filter(owned).map(hook => ({ matcher: group.matcher, hooks: [hook] })));
  if (JSON.stringify(ours) !== JSON.stringify([WRITE_GUARD_HOOK])) throw new Error('Post-condition Claude hook : déclaration du garde différente');
  // A missing parent may only be introduced to contain the owned declaration.
  if ((!Object.hasOwn(before, 'hooks') && Object.keys(after.hooks).some(key => key !== 'PreToolUse')) ||
      (!Object.hasOwn(before.hooks ?? {}, 'PreToolUse') && groups.some(group => group.hooks.some(hook => !owned(hook)) || group.hooks.length === 0))) {
    throw new Error('Post-condition Claude hook : autre hook ajouté');
  }
  if (JSON.stringify(withoutOwned(before, before)) !== JSON.stringify(withoutOwned(after, before))) {
    throw new Error('Post-condition Claude hook : réglages, permissions ou autres hooks modifiés');
  }
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

export function generateWriteGuardSettings(previous = null) {
  const before = settings(previous);
  const text = previous ?? '{}\n';
  const root = jsonPositions(text);
  const hooks = root.properties.get('hooks')?.value;
  const pre = hooks?.properties.get('PreToolUse')?.value;
  let edit;
  if (!pre) {
    edit = hooks ? insertProperties(text, hooks, { PreToolUse: [WRITE_GUARD_HOOK] }) : insertProperties(text, root, { hooks: { PreToolUse: [WRITE_GUARD_HOOK] } });
  } else {
    // A canonical declaration, even amongst other hooks, needs no reformatting.
    const ours = before.hooks.PreToolUse.flatMap(group => group.hooks.filter(owned).map(hook => ({ matcher: group.matcher, hooks: [hook] })));
    if (JSON.stringify(ours) === JSON.stringify([WRITE_GUARD_HOOK])) {
      assertWriteGuardPostcondition(previous, text);
      return text;
    }
    const content = editArray(text, pre, (groupNode, index) => {
      const group = before.hooks.PreToolUse[index];
      if (!group.hooks.some(owned)) return text.slice(groupNode.start, groupNode.end);
      if (group.hooks.every(owned)) return null;
      const list = groupNode.properties.get('hooks').value;
      const updated = editArray(text, list, (item, i) => owned(group.hooks[i]) ? null : text.slice(item.start, item.end));
      return text.slice(groupNode.start, list.start) + updated + text.slice(list.end, groupNode.end);
    }, [JSON.stringify(WRITE_GUARD_HOOK)]);
    edit = { start: pre.start, end: pre.end, content };
  }
  const result = text.slice(0, edit.start) + edit.content + text.slice(edit.end);
  assertWriteGuardPostcondition(previous, result);
  return result;
}
