import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TurnStore } from '../lib/index.js'

const opts = { maxFileBytes: 1 << 20, maxFilesPerTurn: 100, timeoutMs: 5000 }

async function fresh() {
  const root = await mkdtemp(join(tmpdir(), 'rewind-'))
  return { root, store: new TurnStore(root, opts) }
}

test('records first capture only, and reads it back', async () => {
  const { root, store } = await fresh()
  try {
    assert.equal(await store.record('s1', 1, '/tmp/a.rs', 'ORIGINAL'), 'captured')
    assert.equal(await store.record('s1', 1, '/tmp/a.rs', 'MUTATED'), 'already-captured')
    const files = await store.manifest('s1', 1)
    assert.ok(files.has('/tmp/a.rs'))
    const text = await store.readBlob('s1', 1, files.get('/tmp/a.rs'))
    assert.equal(text, 'ORIGINAL', 'baseline must stay the pre-mutation content')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('records absence so rewind can delete created files', async () => {
  const { root, store } = await fresh()
  try {
    await store.record('s1', 2, '/tmp/new.rs', undefined)
    const files = await store.manifest('s1', 2)
    assert.deepEqual(files.get('/tmp/new.rs'), { absent: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('turnsFor lists turn directories in order', async () => {
  const { root, store } = await fresh()
  try {
    await store.record('s1', 3, '/tmp/a.rs', 'a')
    await store.record('s1', 1, '/tmp/b.rs', 'b')
    await store.record('s1', 2, '/tmp/c.rs', 'c')
    assert.deepEqual(await store.turnsFor('s1'), [1, 2, 3])
    assert.deepEqual(await store.turnsFor('other'), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('manifest survives a fresh store instance (restart durability)', async () => {
  const { root, store } = await fresh()
  try {
    await store.record('s1', 1, '/tmp/a.rs', 'PERSISTED')
    const reopened = new TurnStore(root, opts)
    const files = await reopened.manifest('s1', 1)
    assert.ok(files !== undefined)
    const text = await reopened.readBlob('s1', 1, files.get('/tmp/a.rs'))
    assert.equal(text, 'PERSISTED')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('oversized content is not captured', async () => {
  const { root, store } = await fresh()
  try {
    const small = new TurnStore(root, { ...opts, maxFileBytes: 10 })
    assert.equal(await small.record('s1', 1, '/tmp/big.rs', 'x'.repeat(100)), 'skipped')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('per-turn file cap is enforced', async () => {
  const { root, store } = await fresh()
  try {
    const capped = new TurnStore(root, { ...opts, maxFilesPerTurn: 2 })
    assert.equal(await capped.record('s1', 1, '/tmp/a', 'a'), 'captured')
    assert.equal(await capped.record('s1', 1, '/tmp/b', 'b'), 'captured')
    assert.equal(await capped.record('s1', 1, '/tmp/c', 'c'), 'skipped')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('discard removes one turn and leaves the others', async () => {
  const { root, store } = await fresh()
  try {
    await store.record('s1', 1, '/tmp/a.rs', 'a')
    await store.record('s1', 2, '/tmp/b.rs', 'b')
    await store.discard('s1', 1)
    assert.deepEqual(await store.turnsFor('s1'), [2])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('session ids are sanitized into safe directory names', async () => {
  const { root, store } = await fresh()
  try {
    await store.record('../../etc/passwd', 1, '/tmp/a.rs', 'x')
    assert.deepEqual(await store.turnsFor('../../etc/passwd'), [1])
    // Nothing escaped the store root.
    const escaped = await readdir(join(root, '..')).catch(() => [])
    assert.ok(!escaped.includes('etc'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
