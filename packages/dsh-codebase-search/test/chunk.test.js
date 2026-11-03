import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkSource, symbolOf, languageOf, shouldSkip, ftsQuery, fingerprintOf } from '../lib/index.js'

test('chunks Rust definitions by symbol', () => {
  const src = [
    'use std::collections::HashMap;',
    '',
    'pub struct OrderBook {',
    '    bids: Vec<Level>,',
    '}',
    '',
    'pub async fn parse_snapshot(raw: &str) -> Result<Snapshot> {',
    '    todo!()',
    '}',
    '',
    'impl OrderBook {',
    '    fn best_bid(&self) -> f64 { 0.0 }',
    '}',
  ].join('\n')
  const chunks = chunkSource(src, 'rust')
  const symbols = chunks.map((c) => c.symbol)
  assert.ok(symbols.includes('OrderBook'), `got ${symbols}`)
  assert.ok(symbols.includes('parse_snapshot'), `got ${symbols}`)
  assert.ok(symbols.includes('OrderBook') && symbols.filter((s) => s === 'OrderBook').length >= 1)
  assert.ok(chunks.every((c) => c.startLine >= 1 && c.endLine >= c.startLine))
})

test('chunks Python def and class', () => {
  const src = 'import os\n\nclass Grid:\n    pass\n\ndef place_order(side, qty):\n    return side\n'
  const symbols = chunkSource(src, 'python').map((c) => c.symbol)
  assert.deepEqual(symbols, ['Grid', 'place_order'])
})

test('unknown language yields one whole-file chunk', () => {
  const chunks = chunkSource('hello\nworld\n', '')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].symbol, '')
  assert.equal(chunks[0].body, 'hello\nworld\n')
})

test('file with no recognized definitions still produces a chunk', () => {
  const chunks = chunkSource('just some text\nmore text\n', 'rust')
  assert.equal(chunks.length, 1)
  assert.match(chunks[0].body, /just some text/)
})

test('empty file produces no chunks', () => {
  assert.deepEqual(chunkSource('   \n\n', 'rust'), [])
})

test('chunk body is capped', () => {
  const long = 'fn big() {\n' + 'x\n'.repeat(10000) + '}\n'
  const chunks = chunkSource(long, 'rust', 100)
  assert.ok(chunks.every((c) => c.body.length <= 100))
})

test('symbolOf extracts names across languages', () => {
  assert.equal(symbolOf('pub fn reconnect(&mut self)'), 'reconnect')
  assert.equal(symbolOf('pub struct OrderBook {'), 'OrderBook')
  assert.equal(symbolOf('export async function fetchOrder(id: string)'), 'fetchOrder')
  assert.equal(symbolOf('def place_order(side):'), 'place_order')
  assert.equal(symbolOf('func (s *Server) Handle()'), 'Handle')
})

test('languageOf maps extensions', () => {
  assert.equal(languageOf('a.rs'), 'rust')
  assert.equal(languageOf('a.tsx'), 'typescript')
  assert.equal(languageOf('a.py'), 'python')
  assert.equal(languageOf('a.go'), 'go')
  assert.equal(languageOf('a.cpp'), 'c')
  assert.equal(languageOf('a.unknownext'), '')
})

test('shouldSkip drops binaries, vendored and generated files', () => {
  const excluded = new Set(['node_modules', 'target', '.git'])
  assert.equal(shouldSkip('node_modules/x/index.js', excluded), true)
  assert.equal(shouldSkip('target/debug/x.rs', excluded), true)
  assert.equal(shouldSkip('.git/HEAD', excluded), true)
  assert.equal(shouldSkip('img/logo.png', excluded), true)
  assert.equal(shouldSkip('dist/app.min.js', excluded), true)
  assert.equal(shouldSkip('src/lib.rs', excluded), false)
  assert.equal(shouldSkip('src/index.ts', excluded), false)
})

test('ftsQuery neutralizes operators and short terms', () => {
  assert.equal(ftsQuery('order book'), '"order" OR "book"')
  assert.equal(ftsQuery('NEAR order OR book'), '"order" OR "book"')
  assert.equal(ftsQuery('"quoted phrase"'), '"quoted" OR "phrase"')
  assert.equal(ftsQuery('a b'), '')
  assert.equal(ftsQuery('   '), '')
  assert.equal(ftsQuery('*'), '')
})

test('fingerprintOf changes with content identity', () => {
  const a = fingerprintOf('a.rs', { size: 10, mtimeMs: 1000 })
  const b = fingerprintOf('a.rs', { size: 10, mtimeMs: 1000 })
  const c = fingerprintOf('a.rs', { size: 11, mtimeMs: 1000 })
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('expandIdentifier splits camelCase, PascalCase, and snake_case', async () => {
  const { expandIdentifier, expandBodyTokens } = await import('../lib/index.js')
  assert.equal(expandIdentifier('placeOrder'), 'place order')
  assert.equal(expandIdentifier('HTTPServer'), 'http server')
  assert.equal(expandIdentifier('parse_snapshot'), 'parse snapshot')
  assert.equal(expandIdentifier('getOrderBookSnapshot'), 'get order book snapshot')
  assert.equal(expandIdentifier(''), '')
  // Body expansion keeps the original token so exact searches still work.
  const body = expandBodyTokens('const placeOrder = 1')
  assert.match(body, /placeOrder/)
  assert.match(body, /place order/)
})

test('camelCase symbols are reachable by their word parts', async () => {
  const { CodebaseIndex } = await import('../lib/index.js')
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = await mkdtemp(join(tmpdir(), 'cbi-camel-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'order.ts'),
    'export function placeOrder(qty: number): number {\n  return qty\n}\n')
  const index = new CodebaseIndex(join(root, 'i.sqlite'), {
    refreshMs: 0, maxFiles: 100, maxFileBytes: 1 << 20, exclude: [],
  })
  try {
    await index.refresh(root, new AbortController().signal)
    // `quantity` is deliberately absent: the parameter is named `qty`, and a
    // literal index has no business inventing synonyms for it.
    for (const q of ['place order', 'order', 'placeOrder', 'qty']) {
      const rows = await index.search(q, 5)
      assert.ok(rows.some((r) => r.symbol === 'placeOrder'), `"${q}" must find placeOrder`)
    }
  } finally {
    await index.close()
    await rm(root, { recursive: true, force: true })
  }
})
