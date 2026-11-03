import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodebaseIndex, chunkIsTest, looksLikeTest, renderResult } from '../lib/index.js'

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'cbi-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'target'), { recursive: true })
  await writeFile(join(root, 'src', 'ob.rs'), [
    'pub struct OrderBook {',
    '    bids: Vec<Level>,',
    '}',
    '',
    'pub fn parse_snapshot(raw: &str) -> Snapshot {',
    '    decode(raw)',
    '}',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    #[test]',
    '    fn parses_snapshot() {}',
    '}',
  ].join('\n'))
  await writeFile(join(root, 'src', 'app.py'), 'def place_order(side):\n    return side\n')
  await writeFile(join(root, 'target', 'junk.rs'), 'fn should_not_be_indexed() {}')
  await writeFile(join(root, 'README.md'), 'not source')
  return root
}

test('indexes source, skips excluded dirs, and searches by symbol', async () => {
  const root = await workspace()
  const index = new CodebaseIndex(join(root, 'idx.sqlite'), {
    refreshMs: 0, maxFiles: 1000, maxFileBytes: 1 << 20, exclude: ['target', '.git'],
  })
  try {
    await index.refresh(root, new AbortController().signal)
    const stats = await index.stats()
    assert.equal(stats.files, 2, 'only the two source files')

    const rows = await index.search('order book snapshot', 5)
    assert.ok(rows.length > 0)
    assert.ok(rows.some((r) => r.symbol === 'parse_snapshot' || r.symbol === 'OrderBook'))

    const py = await index.search('place order', 5)
    assert.ok(py.some((r) => r.symbol === 'place_order'))

    const excluded = await index.search('should_not_be_indexed', 5)
    assert.equal(excluded.length, 0, 'target/ is excluded')
  } finally {
    await index.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('refresh is incremental and honours the TTL', async () => {
  const root = await workspace()
  const index = new CodebaseIndex(join(root, 'idx.sqlite'), {
    refreshMs: 0, maxFiles: 1000, maxFileBytes: 1 << 20, exclude: ['target'],
  })
  try {
    const first = await index.refresh(root, new AbortController().signal)
    assert.ok(first.added >= 2)
    const second = await index.refresh(root, new AbortController().signal)
    assert.equal(second.added, 0, 'unchanged files are not re-indexed')

    await writeFile(join(root, 'src', 'new.ts'), 'export function reconcileLedger(): void {}\n')
    const third = await index.refresh(root, new AbortController().signal)
    assert.equal(third.added, 1)

    await rm(join(root, 'src', 'new.ts'))
    const fourth = await index.refresh(root, new AbortController().signal)
    assert.equal(fourth.removed, 1)

    const hit = await index.search('reconcile ledger', 5)
    assert.equal(hit.length, 0, 'removed file leaves no stale rows')
  } finally {
    await index.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('production code outranks test code for the same term', async () => {
  const root = await workspace()
  const index = new CodebaseIndex(join(root, 'idx.sqlite'), {
    refreshMs: 0, maxFiles: 1000, maxFileBytes: 1 << 20, exclude: ['target'],
  })
  try {
    await index.refresh(root, new AbortController().signal)
    const rows = await index.search('snapshot', 10)
    const production = rows.findIndex((r) => r.symbol === 'parse_snapshot')
    const test = rows.findIndex((r) => r.symbol === 'parses_snapshot')
    assert.ok(production >= 0, 'production symbol present')
    if (test >= 0) assert.ok(production < test, 'production ranked before its test')
  } finally {
    await index.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('chunkIsTest distinguishes Rust production from its test module', () => {
  assert.equal(chunkIsTest({ symbol: 'parse_snapshot', startLine: 5, body: 'fn parse_snapshot() {}' }, 'rust'), false)
  assert.equal(chunkIsTest({ symbol: 'parses_snapshot', startLine: 12, body: '#[test]\nfn parses_snapshot() {}' }, 'rust'), true)
  assert.equal(chunkIsTest({ symbol: 'test_balance', startLine: 3, body: 'fn test_balance() {}' }, 'rust'), true)
  assert.equal(chunkIsTest({ symbol: 'handle_order', startLine: 3, body: 'fn handle_order() {}' }, 'rust'), false)
})

test('looksLikeTest matches test paths only', () => {
  assert.equal(looksLikeTest('crates/x/tests/integration.rs'), true)
  assert.equal(looksLikeTest('src/foo.test.ts'), true)
  assert.equal(looksLikeTest('tests/test_order.py'), true)
  assert.equal(looksLikeTest('src/order.rs'), false)
})

test('renderResult anchors file and line range', () => {
  const text = renderResult({ file: 'src/a.rs', symbol: 'f', body: 'fn f() {}', start_line: 3, end_line: 4 }, 100)
  assert.match(text, /^src\/a\.rs:3-4  f/)
  assert.match(text, /fn f\(\) \{\}/)
})
