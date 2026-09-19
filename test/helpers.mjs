import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const CLI = path.join(ROOT, 'bin/agent-policy.mjs');
export function temporary(t) {
  const parent = path.join(ROOT, '.agent-tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
export function put(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
}
export function cli(root, args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, ...options,
  });
}
export function policy(entries = []) { return { version: 1, entries }; }
export function entry(overrides = {}) {
  return {
    pattern: ['gh', 'pr', 'merge'], decision: 'prompt', riskClass: 'remote-publication',
    justification: 'La fusion appartient au user.', match: ['gh pr merge 12 --squash'], notMatch: ['gh pr view 12'],
    ...overrides,
  };
}
