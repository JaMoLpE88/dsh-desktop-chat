/**
 * dsh-desktop-chat — Host half.
 *
 * One job: keep the DeepSeek login alive across DSH Desktop restarts.
 *
 * The desktop shell gives every browser guest a process-lifetime storage
 * partition (a random `dsh-sidebar-browser-<uuid>` name, no `persist:` prefix),
 * so the guest's cookies and web storage are gone after every restart. The
 * shell's main process *does* have the Electron session API, but this plugin
 * runs in the Desktop Host — an Electron executable started with
 * ELECTRON_RUN_AS_NODE=1 — where the `electron` module does not exist, and the
 * shell→Host IPC protocol is a closed, validated set that has no cookie
 * channel. HttpOnly cookies are therefore unreachable from a plugin here.
 *
 * What remains reachable is what the page itself can see: `localStorage` and
 * `document.cookie`. DeepSeek's web client authenticates with
 * `localStorage["userToken"]`, so carrying those across restarts is enough to
 * reopen the page already signed in. The browser half reads and writes them;
 * this half only owns the file on disk.
 *
 * Routes: GET  /state, POST /session/restore, POST /session/save,
 *         POST /session/forget.
 *
 * The snapshot holds live session credentials, so the file stays user-private,
 * route responses carry no credentials except to the page that owns them, and
 * diagnostics report counts and booleans only.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Stable cordis plugin name. */
export const name = 'desktop-chat'

/** The web server is the only Host service this plugin needs. */
export const inject = ['webServer']

/** The page this plugin exists to show. */
export const PAGE_URL = 'https://chat.deepseek.com/'

/** Sidebar entry id, shared by the entry row and the main panel key. */
export const PANEL_ID = 'deepseek-chat'

/** Route family; the browser half spells the same paths. */
export const ROUTES = {
  state: '/api/dsh-desktop-chat/state',
  restore: '/api/dsh-desktop-chat/session/restore',
  save: '/api/dsh-desktop-chat/session/save',
  forget: '/api/dsh-desktop-chat/session/forget',
}

/** Header the browser half sends; blocks cross-site reads of a credential route. */
const GUARD_HEADER = 'x-dsh-desktop-chat'

/**
 * Expand a leading `~` prefix against the OS home, as the harness's own home
 * helper accepts it.
 * @param path - a path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the input unchanged.
 */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * The single DSH home root, resolved the way the harness resolves it:
 * `$DSH_HOME` when set to a non-blank value, otherwise `~/.dsh`.
 * @param env - environment mapping; defaults to `process.env` (test seam).
 * @returns the normalized absolute harness home path.
 */
export function dshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  const override = fromEnv !== undefined && fromEnv.trim().length > 0 ? expandHome(fromEnv) : undefined
  return resolve(override ?? join(homedir(), '.dsh'))
}

/** Overridable snapshot path, so tests never touch the real profile directory. */
let sessionFilePath = null

/**
 * The snapshot path: `<dsh home>/dsh-desktop-chat/session.json`.
 * @returns the absolute snapshot path.
 */
export function SESSION_FILE() {
  return sessionFilePath === null ? join(dshHome(), 'dsh-desktop-chat', 'session.json') : sessionFilePath
}

/**
 * Point the snapshot somewhere else.
 * @param path - replacement path, or null to restore the default.
 */
export function setSessionFile(path) {
  sessionFilePath = path
}

/**
 * Keep only `[key, value]` pairs with string members, preserving order.
 * @param value - candidate list from a request body or a file.
 * @returns the normalized list.
 */
export function normalizeStorage(value) {
  if (!Array.isArray(value)) return []
  const pairs = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) continue
    const [key, stored] = entry
    if (typeof key !== 'string' || typeof stored !== 'string') continue
    pairs.push([key, stored])
  }
  return pairs
}

/**
 * Read the snapshot.
 * @param file - snapshot path.
 * @returns the normalized snapshot, or null when there is nothing usable.
 */
export function readSnapshot(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    return {
      version: 1,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
      storage: normalizeStorage(parsed.storage),
      cookie: typeof parsed.cookie === 'string' ? parsed.cookie : '',
    }
  } catch {
    return null
  }
}

/**
 * Write the snapshot atomically and user-private, so a crash cannot truncate it.
 * @param file - snapshot path.
 * @param snapshot - normalized snapshot.
 */
export function writeSnapshot(file, snapshot) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

/**
 * Whether the snapshot carries a non-empty DeepSeek session token.
 *
 * `userToken` is DeepSeek's persisted-state entry: `{"value":"<jwt>","__version":1}`
 * when signed in, `{"value":null,...}` when signed out.
 * @param snapshot - normalized snapshot, or null.
 * @returns true when a token is present.
 */
export function snapshotHasToken(snapshot) {
  if (snapshot === null || !Array.isArray(snapshot.storage)) return false
  for (const [key, value] of snapshot.storage) {
    if (key !== 'userToken' || typeof value !== 'string') continue
    try {
      const parsed = JSON.parse(value)
      if (parsed !== null && typeof parsed === 'object' && 'value' in parsed) {
        return typeof parsed.value === 'string' && parsed.value.length > 0
      }
    } catch {
      // A plain string token is still a token.
    }
    return value.trim().length > 0
  }
  return false
}

/** Read a JSON request body; a malformed or oversized body reads as null. */
async function readJsonBody(req, limit = 4 * 1024 * 1024) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) {
        req.destroy?.()
        return null
      }
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    return null
  }
}

/** Send one JSON response. */
function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/** Whether the caller carries the plugin header. */
function guarded(req) {
  return req.headers[GUARD_HEADER] === '1'
}

/** Last outcome of each session operation, for diagnostics only. */
const last = {
  restore: { at: '', ok: false, error: '', storage: 0 },
  save: { at: '', ok: false, error: '', storage: 0, kept: false },
}

/**
 * Describe the snapshot for the state route: counts and booleans, never values.
 * @param file - snapshot path.
 */
function describeSession(file) {
  const snapshot = readSnapshot(file)
  return {
    file,
    exists: snapshot !== null,
    savedAt: snapshot === null ? '' : snapshot.savedAt,
    hasUserToken: snapshotHasToken(snapshot),
    storageKeys: snapshot === null ? 0 : snapshot.storage.length,
    cookieBytes: snapshot === null ? 0 : Buffer.byteLength(snapshot.cookie, 'utf8'),
  }
}

/** Every route this plugin owns, in registration order. */
export function createRoutes() {
  return [
    {
      path: ROUTES.state,
      method: 'GET',
      handler: (req, res) => {
        if (!guarded(req)) return json(res, 403, { ok: false, error: 'missing plugin header' })
        const file = SESSION_FILE()
        return json(res, 200, {
          ok: true,
          panelId: PANEL_ID,
          url: PAGE_URL,
          pageOnly: ['localStorage', 'document.cookie'],
          notPersisted: ['HttpOnly cookies (WAF/Cloudflare clearance)'],
          session: describeSession(file),
          last: { restore: last.restore, save: last.save },
        })
      },
    },
    {
      path: ROUTES.restore,
      method: 'POST',
      handler: async (req, res) => {
        if (!guarded(req)) return json(res, 403, { ok: false, error: 'missing plugin header' })
        const body = await readJsonBody(req)
        if (body === null || typeof body !== 'object') return json(res, 400, { ok: false, error: 'invalid body' })
        const file = SESSION_FILE()
        const snapshot = readSnapshot(file)
        if (snapshot === null) {
          last.restore = { at: new Date().toISOString(), ok: true, error: '', storage: 0 }
          return json(res, 200, { ok: true, storage: [], cookie: '', savedAt: '', hasUserToken: false })
        }
        last.restore = { at: new Date().toISOString(), ok: true, error: '', storage: snapshot.storage.length }
        return json(res, 200, {
          ok: true,
          storage: snapshot.storage,
          cookie: snapshot.cookie,
          savedAt: snapshot.savedAt,
          hasUserToken: snapshotHasToken(snapshot),
        })
      },
    },
    {
      path: ROUTES.save,
      method: 'POST',
      handler: async (req, res) => {
        if (!guarded(req)) return json(res, 403, { ok: false, error: 'missing plugin header' })
        const body = await readJsonBody(req)
        if (body === null || typeof body !== 'object') return json(res, 400, { ok: false, error: 'invalid body' })
        const file = SESSION_FILE()
        const previous = readSnapshot(file)
        const diag = body.diag !== null && typeof body.diag === 'object' ? body.diag : undefined
        // A browser half that could not read the page reports why instead of
        // staying silent; the snapshot is untouched and the reason is public.
        if (typeof body.skip === 'string' && body.skip !== '') {
          last.save = { at: new Date().toISOString(), ok: true, error: '', storage: 0, kept: false, skipped: body.skip, diag }
          return json(res, 200, { ok: true, saved: false, skipped: body.skip, session: describeSession(file) })
        }
        const incoming = {
          version: 1,
          savedAt: new Date().toISOString(),
          storage: normalizeStorage(body.storage),
          cookie: typeof body.cookie === 'string' ? body.cookie : '',
        }
        // A page that has not finished loading reports nothing; never let that
        // erase a usable snapshot. The browser half additionally reports an
        // explicit logout, which is the one case that may clear the token.
        const incomingEmpty = incoming.storage.length === 0 && incoming.cookie === ''
        const previousHasToken = snapshotHasToken(previous)
        const incomingHasToken = snapshotHasToken(incoming)
        const cleared = body.cleared === true
        if (previousHasToken && !incomingHasToken && !cleared) {
          last.save = { at: incoming.savedAt, ok: true, error: '', storage: 0, kept: true, diag }
          return json(res, 200, {
            ok: true,
            saved: false,
            kept: true,
            reason: 'the previous snapshot holds a session and this save has none',
            session: describeSession(file),
          })
        }
        if (incomingEmpty && previous !== null) {
          last.save = { at: incoming.savedAt, ok: true, error: '', storage: 0, kept: true, diag }
          return json(res, 200, {
            ok: true,
            saved: false,
            kept: true,
            reason: 'the page reported no storage or cookies',
            session: describeSession(file),
          })
        }
        writeSnapshot(file, incoming)
        last.save = { at: incoming.savedAt, ok: true, error: '', storage: incoming.storage.length, kept: false, diag }
        return json(res, 200, {
          ok: true,
          saved: true,
          kept: false,
          session: describeSession(file),
        })
      },
    },
    {
      path: ROUTES.forget,
      method: 'POST',
      handler: async (req, res) => {
        if (!guarded(req)) return json(res, 403, { ok: false, error: 'missing plugin header' })
        const file = SESSION_FILE()
        const existed = existsSync(file)
        rmSync(file, { force: true })
        last.restore = { at: new Date().toISOString(), ok: true, error: '', storage: 0 }
        return json(res, 200, { ok: true, deleted: existed, session: describeSession(file) })
      },
    },
  ]
}

/**
 * Register the session routes.
 * @param ctx - Host context carrying the web server.
 */
export function apply(ctx) {
  for (const route of createRoutes()) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: route.path,
      handler: (req, res) => {
        if (req.method !== route.method) {
          res.writeHead(405, { allow: route.method })
          res.end()
          return
        }
        Promise.resolve(route.handler(req, res)).catch((error) => {
          json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        })
      },
    }), `dsh-desktop-chat: ${route.path}`)
  }
}
