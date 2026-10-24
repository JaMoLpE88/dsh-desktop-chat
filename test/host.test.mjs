/**
 * Host-half tests.
 *
 * The Host half owns one file and four routes. None of that needs a browser, a
 * window or the network: the snapshot path is injectable and the handlers take
 * plain request/response objects.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const {
  apply,
  createRoutes,
  dshHome,
  readSnapshot,
  ROUTES,
  SESSION_FILE,
  setSessionFile,
  snapshotHasToken,
  writeSnapshot,
} = await import('../lib/index.js')

/** A throwaway snapshot path, so no test touches the real profile. */
function tempSnapshot() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-chat-'))
  const file = join(dir, 'session.json')
  setSessionFile(file)
  return { dir, file, cleanup: () => { setSessionFile(null); rmSync(dir, { recursive: true, force: true }) } }
}

/** One JSON request body, or none. */
function request(method = 'POST', body, headers = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.headers = { 'x-dsh-desktop-chat': '1', ...headers }
  return stream
}

/** A response object that records the JSON it was given. */
function response() {
  const res = {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = body ?? '' },
  }
  res.json = () => JSON.parse(res.body)
  return res
}

/** Find one route by path. */
function route(path) {
  const found = createRoutes().find((entry) => entry.path === path)
  assert.ok(found, `route ${path} exists`)
  return found
}

const TOKEN_STATE = {
  storage: [
    ['userToken', JSON.stringify({ value: 'a-jwt', __version: 1 })],
    ['__appKit_userInfo', JSON.stringify({ value: 'u', __version: 1 })],
    ['__appKit_@deepseek/chat_themePreference', JSON.stringify({ value: 'dark', __version: 1 })],
  ],
  cookie: 'smidV2=abc; HWWAFSESID=def',
}

test('the Host half never imports electron', () => {
  const source = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert.doesNotMatch(source, /from\s+['"]electron['"]/)
  assert.doesNotMatch(source, /require\(['"]electron['"]\)/)
})

test('DSH_HOME wins over ~/.dsh and blank values are ignored', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  try {
    assert.equal(dshHome({ DSH_HOME: root }), root)
    assert.match(String(dshHome({ DSH_HOME: '   ' })), /\.dsh$/)
    assert.match(String(dshHome({})), /\.dsh$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('apply registers the four exact routes on the web server', () => {
  const registered = []
  apply({
    effect(fn) { fn() },
    webServer: { register(entry) { registered.push(entry) } },
  })
  assert.deepEqual(registered.map((entry) => entry.path).sort(), Object.values(ROUTES).sort())
  assert.ok(registered.every((entry) => entry.kind === 'exact'))
})

test('save then restore round-trips storage and the page cookie', async () => {
  const { file, cleanup } = tempSnapshot()
  try {
    const saved = response()
    await route(ROUTES.save).handler(request('POST', TOKEN_STATE), saved)
    assert.equal(saved.status, 200)
    assert.equal(saved.json().saved, true)
    assert.equal(saved.json().session.hasUserToken, true)

    const restored = response()
    await route(ROUTES.restore).handler(request('POST', {}), restored)
    const payload = restored.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.hasUserToken, true)
    assert.deepEqual(payload.storage, TOKEN_STATE.storage)
    assert.equal(payload.cookie, TOKEN_STATE.cookie)
    assert.match(payload.savedAt, /^\d{4}-\d{2}-\d{2}T/)

    assert.ok(existsSync(file))
    assert.equal(readSnapshot(file).storage.length, 3)
  } finally {
    cleanup()
  }
})

test('a logged-out save cannot erase a snapshot that holds a session', async () => {
  const { file, cleanup } = tempSnapshot()
  try {
    writeSnapshot(file, { version: 1, savedAt: '2026-01-01T00:00:00.000Z', ...TOKEN_STATE })

    const loggedOut = {
      storage: [
        ['userToken', JSON.stringify({ value: null, __version: 1 })],
        ['__appKit_userChat_themePreference', JSON.stringify({ value: 'light', __version: 1 })],
      ],
      cookie: 'smidV2=abc',
    }
    const kept = response()
    await route(ROUTES.save).handler(request('POST', loggedOut), kept)
    assert.equal(kept.status, 200)
    assert.equal(kept.json().saved, false)
    assert.equal(kept.json().kept, true)
    assert.equal(snapshotHasToken(readSnapshot(file)), true)
    assert.equal(readSnapshot(file).storage.length, 3)
  } finally {
    cleanup()
  }
})

test('an explicit logout clears the snapshot when the page reports it', async () => {
  const { file, cleanup } = tempSnapshot()
  try {
    writeSnapshot(file, { version: 1, savedAt: '2026-01-01T00:00:00.000Z', ...TOKEN_STATE })
    const cleared = response()
    await route(ROUTES.save).handler(request('POST', {
      storage: [['userToken', JSON.stringify({ value: null, __version: 1 })]],
      cookie: '',
      cleared: true,
    }), cleared)
    assert.equal(cleared.json().saved, true)
    assert.equal(snapshotHasToken(readSnapshot(file)), false)
  } finally {
    cleanup()
  }
})

test('an empty page state never erases an existing snapshot', async () => {
  const { file, cleanup } = tempSnapshot()
  try {
    writeSnapshot(file, { version: 1, savedAt: '2026-01-01T00:00:00.000Z', ...TOKEN_STATE })
    const empty = response()
    await route(ROUTES.save).handler(request('POST', { storage: [], cookie: '' }), empty)
    assert.equal(empty.json().saved, false)
    assert.equal(empty.json().kept, true)
    assert.equal(readSnapshot(file).storage.length, 3)
  } finally {
    cleanup()
  }
})

test('forget deletes the snapshot and the state reports it', async () => {
  const { file, cleanup } = tempSnapshot()
  try {
    writeSnapshot(file, { version: 1, savedAt: '2026-01-01T00:00:00.000Z', ...TOKEN_STATE })
    const forgotten = response()
    await route(ROUTES.forget).handler(request('POST', {}), forgotten)
    assert.equal(forgotten.json().deleted, true)
    assert.equal(existsSync(file), false)

    const state = response()
    route(ROUTES.state).handler(request('GET'), state)
    assert.equal(state.json().ok, true)
    assert.equal(state.json().session.exists, false)
    assert.equal(state.json().session.hasUserToken, false)
  } finally {
    cleanup()
  }
})

test('state never returns credential values', async () => {
  const { file, cleanup } = tempSnapshot()
  try {
    writeSnapshot(file, { version: 1, savedAt: '2026-01-01T00:00:00.000Z', ...TOKEN_STATE })
    const state = response()
    route(ROUTES.state).handler(request('GET'), state)
    const text = state.body
    assert.doesNotMatch(text, /a-jwt/)
    assert.doesNotMatch(text, /HWWAFSESID/)
    assert.equal(state.json().session.storageKeys, 3)
    assert.equal(state.json().session.hasUserToken, true)
  } finally {
    cleanup()
  }
})

test('credential routes refuse a request without the plugin header', async () => {
  const { cleanup } = tempSnapshot()
  try {
    for (const path of Object.values(ROUTES)) {
      const res = response()
      await route(path).handler(request('GET', undefined, { 'x-dsh-desktop-chat': '' }), res)
      assert.equal(res.status, 403, `${path} refused`)
    }
  } finally {
    cleanup()
  }
})

test('a wrong method is answered with 405 before the handler runs', () => {
  const registered = []
  apply({
    effect(fn) { fn() },
    webServer: { register(entry) { registered.push(entry) } },
  })
  const save = registered.find((entry) => entry.path === ROUTES.save)
  const res = response()
  save.handler(request('GET'), res)
  assert.equal(res.status, 405)
})

test('a malformed body is rejected without touching the snapshot', async () => {
  const { file, cleanup } = tempSnapshot()
  try {
    const res = response()
    const bad = Readable.from([Buffer.from('{not json')])
    bad.method = 'POST'
    bad.headers = { 'x-dsh-desktop-chat': '1' }
    await route(ROUTES.save).handler(bad, res)
    assert.equal(res.status, 400)
    assert.equal(existsSync(file), false)
  } finally {
    cleanup()
  }
})

test('the default snapshot lives under the DSH home', () => {
  setSessionFile(null)
  assert.match(SESSION_FILE(), /dsh-desktop-chat[\\/]session\.json$/)
})
