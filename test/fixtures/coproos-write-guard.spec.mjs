import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const guard = path.join(repositoryRoot, 'scripts/claude-worktree-write-guard.cjs')

function run(input) {
  return spawnSync(process.execPath, [guard], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: repositoryRoot },
  })
}

assert.equal(run({ tool_name: 'Write', tool_input: { file_path: path.join(repositoryRoot, '.agent-tmp/run/report.json') } }).status, 0)
assert.equal(run({ tool_name: 'Edit', tool_input: { file_path: '/private/tmp/coproos.json' } }).status, 2)
assert.equal(run({ tool_name: 'Write', tool_input: { file_path: path.join(repositoryRoot, '..', 'outside.json') } }).status, 2)
assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'npm run test:hooks' } }).status, 0)
assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'mv .agent-tmp/a /Users/sourouche/.local/state/coproos/a' } }).status, 2)
assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'node /private/tmp/scratch.mjs' } }).status, 2)
assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'echo audit > /private/tmp/coproos-audit.txt' } }).status, 2)
assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'git config --global user.name test' } }).status, 2)
assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'npm install -g typescript' } }).status, 2)
assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'node -e "require(\"node:fs\").writeFileSync(\"/tmp/x\", \"x\")"' } }).status, 2)
assert.equal(run({ tool_name: 'Bash', tool_input: { command: 'cat /Users/sourouche/.local/state/coproos/read-only.json' } }).status, 0)

const symlinkRoot = path.join(repositoryRoot, '.agent-tmp', 'guard-symlink-test')
const externalLink = path.join(symlinkRoot, 'external')
mkdirSync(symlinkRoot, { recursive: true })
symlinkSync('/private/tmp', externalLink)
try {
  assert.equal(run({ tool_name: 'Write', tool_input: { file_path: path.join(externalLink, 'blocked.json') } }).status, 2)
} finally {
  rmSync(symlinkRoot, { recursive: true, force: true })
}

process.stdout.write('[claude-worktree-write-guard] boundary verified\n')
