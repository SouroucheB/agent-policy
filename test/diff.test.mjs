import assert from 'node:assert/strict';
import test from 'node:test';
import { unifiedDiff } from '../lib/system.mjs';

test('diff : longs préfixe et suffixe communs, plusieurs blocs et numéros de lignes originaux', () => {
  const prefix = Array.from({ length: 4500 }, (_, index) => `prefix-${index}\n`).join('');
  const suffix = Array.from({ length: 5000 }, (_, index) => `suffix-${index}\n`).join('');
  const before = prefix + 'old\nkeep\nold-again\n' + suffix;
  const after = prefix + 'new\nextra\nkeep\nnew-again\n' + suffix;
  assert.equal(unifiedDiff('example', before, after), [
    '--- example', '+++ example',
    '@@ -4501,1 +4501,2 @@', '+new', '+extra', '-old',
    '@@ -4503,1 +4504,1 @@', '+new-again', '-old-again', '',
  ].join('\n'));
});

test('diff dégradé : milieu trop grand affiché intégralement, retraits puis ajouts', () => {
  const before = Array.from({ length: 2100 }, (_, index) => `old-${index}`);
  const after = Array.from({ length: 2101 }, (_, index) => `new-${index}`);
  // Le mode dégradé peut réafficher des lignes communes à l’intérieur du milieu.
  before[1000] = 'common-inside';
  after[1000] = 'common-inside';
  const prefix = 'common-start-1\ncommon-start-2\n';
  const suffix = '\ncommon-end\n';
  assert.equal(unifiedDiff('example', prefix + before.join('\n') + suffix, prefix + after.join('\n') + suffix), [
    '--- example', '+++ example',
    '@@ -3,2100 +3,2101 @@ Diff simplifié : remplacement du milieu',
    ...before.map(line => '-' + line), ...after.map(line => '+' + line), '',
  ].join('\n'));
  const noNewline = unifiedDiff('example', before.join('\n'), after.join('\n'));
  assert.match(noNewline, /-old-2099\n\\ No newline at end of file\n\+new-0/);
  assert.ok(noNewline.endsWith('+new-2100\n\\ No newline at end of file\n'));
});

test('diff : insertions et suppressions aux frontières, fichiers absents et fin sans saut de ligne', () => {
  for (const [before, after, body] of [
    ['a\nb\n', 'x\na\nb\n', '@@ -0,0 +1,1 @@\n+x\n'],
    ['a\nb\n', 'a\nx\nb\n', '@@ -1,0 +2,1 @@\n+x\n'],
    ['a\nb\n', 'a\nb\nx\n', '@@ -2,0 +3,1 @@\n+x\n'],
    ['x\na\nb\n', 'a\nb\n', '@@ -1,1 +0,0 @@\n-x\n'],
    ['a\nx\nb\n', 'a\nb\n', '@@ -2,1 +1,0 @@\n-x\n'],
    ['a\nb\nx\n', 'a\nb\n', '@@ -3,1 +2,0 @@\n-x\n'],
    ['a\n', 'a\nlast', '@@ -1,0 +2,1 @@\n+last\n\\ No newline at end of file\n'],
    ['a\nlast', 'a\n', '@@ -2,1 +1,0 @@\n-last\n\\ No newline at end of file\n'],
    [null, 'x\n', '@@ -0,0 +1,1 @@\n+x\n'],
    ['x\n', null, '@@ -1,1 +0,0 @@\n-x\n'],
    [null, '', ''],
    ['', null, ''],
  ]) {
    const header = `--- ${before === null ? '/dev/null' : 'example'}\n+++ ${after === null ? '/dev/null' : 'example'}\n`;
    assert.equal(unifiedDiff('example', before, after), header + body);
  }
  assert.equal(unifiedDiff('example', 'unchanged\n', 'unchanged\n'), '');
});
