import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mutatedFile, renderDiagnostics, diagnosticsFrom } from '../lib/index.js'

test('mutatedFile recognises write and edit on file_path', () => {
  assert.equal(mutatedFile('write', { file_path: 'a.ts', content: 'x' }), 'a.ts')
  assert.equal(mutatedFile('edit', { file_path: 'b.rs', old_string: 'a', new_string: 'b' }), 'b.rs')
})

test('mutatedFile ignores reads, unknown tools, and blank paths', () => {
  assert.equal(mutatedFile('read', { file_path: 'a.ts' }), undefined)
  assert.equal(mutatedFile('bash', { command: 'ls' }), undefined)
  assert.equal(mutatedFile('write', { file_path: '   ' }), undefined)
  assert.equal(mutatedFile('write', {}), undefined)
  assert.equal(mutatedFile('write', null), undefined)
})

test('mutatedFile only accepts mutating str_replace_editor subcommands', () => {
  assert.equal(
    mutatedFile('str_replace_editor', { command: 'create', path: '/tmp/a.ts', file_text: '' }),
    '/tmp/a.ts',
  )
  assert.equal(
    mutatedFile('str_replace_editor', { command: 'str_replace', path: '/tmp/a.ts' }),
    '/tmp/a.ts',
  )
  assert.equal(mutatedFile('str_replace_editor', { command: 'view', path: '/tmp/a.ts' }), undefined)
  assert.equal(mutatedFile('str_replace_editor', { path: '/tmp/a.ts' }), undefined)
})

test('renderDiagnostics is empty for no findings', () => {
  assert.equal(renderDiagnostics('a.ts', [], 10), '')
})

test('renderDiagnostics renders one-based positions, severity, and source', () => {
  const text = renderDiagnostics(
    'src/a.ts',
    [
      {
        severity: 1,
        range: { start: { line: 11, character: 4 } },
        message: "Cannot find name 'foo'.",
        source: 'ts',
      },
      { severity: 2, range: { start: { line: 0, character: 0 } }, message: 'unused' },
    ],
    10,
  )
  assert.match(text, /<lsp-diagnostics file="src\/a.ts">/)
  assert.match(text, /12:5 error \[ts\]: Cannot find name 'foo'\./)
  assert.match(text, /1:1 warning: unused/)
  assert.match(text, /<\/lsp-diagnostics>/)
})

test('renderDiagnostics caps findings and reports the omitted count', () => {
  const diagnostics = Array.from({ length: 5 }, (_, i) => ({
    severity: 1,
    range: { start: { line: i, character: 0 } },
    message: `problem ${i}`,
  }))
  const text = renderDiagnostics('a.ts', diagnostics, 2)
  assert.match(text, /problem 0/)
  assert.match(text, /problem 1/)
  assert.doesNotMatch(text, /problem 2/)
  assert.match(text, /3 more diagnostic\(s\) not shown/)
})

test('diagnosticsFrom accepts only a diagnostics payload', () => {
  assert.deepEqual(diagnosticsFrom({ kind: 'diagnostics', diagnostics: [] }), [])
  assert.deepEqual(diagnosticsFrom({ kind: 'diagnostics', diagnostics: [{ severity: 1 }] }), [{ severity: 1 }])
  assert.equal(diagnosticsFrom({ kind: 'symbols' }), undefined)
  assert.equal(diagnosticsFrom({ kind: 'diagnostics' }), undefined)
  assert.equal(diagnosticsFrom(null), undefined)
  assert.equal(diagnosticsFrom('text'), undefined)
})
