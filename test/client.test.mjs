/**
 * Browser-half tests.
 *
 * The client bundle only ever runs inside the GUI, so it executes here against a
 * minimal DOM stand-in plus a small React double. What matters:
 *
 *   - it registers the sidebar row and the page as slots, under one shared id;
 *   - the page reserves a guest and attaches the exact `<webview>` the desktop
 *     shell approves, with the Electron token stripped from the user agent;
 *   - the saved page state is written on the origin and the page reloads once;
 *   - the guest lives outside the panel mount: hiding it must not detach it;
 *   - without the native bridge it explains itself instead of failing silently.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const PAGE_URL = 'https://chat.deepseek.com/'
const PANEL_ID = 'deepseek-chat'
const OVERLAY = 'data-dsh-desktop-chat-overlay'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36 Electron/33.2.0'

/** A DOM element stub covering exactly what lib/client.js touches. */
function makeElement(tagName, stateReply) {
  const element = {
    tagName: tagName.toUpperCase(),
    attributes: {},
    style: {},
    children: [],
    parentElement: null,
    listeners: {},
    scripts: [],
    reloads: 0,
    loads: [],
    userAgents: [],
    url: 'about:blank',
    textContent: '',
    className: '',
    type: '',
    stateReply: stateReply === undefined ? 'null' : stateReply,
    setAttribute(name, value) { this.attributes[name] = String(value) },
    getAttribute(name) { return this.attributes[name] === undefined ? null : this.attributes[name] },
    addEventListener(type, listener) {
      if (this.listeners[type] === undefined) this.listeners[type] = []
      this.listeners[type].push(listener)
    },
    dispatch(type) {
      for (const listener of [...(this.listeners[type] ?? [])]) listener()
    },
    appendChild(child) {
      child.parentElement = this
      this.children.push(child)
      return child
    },
    replaceChildren(...next) {
      this.children = next
    },
    remove() {
      if (this.parentElement === null) return
      this.parentElement.children = this.parentElement.children.filter((entry) => entry !== this)
      this.parentElement = null
    },
    executeJavaScript(script) {
      this.scripts.push(script)
      if (script.indexOf('JSON.stringify({') !== -1) return Promise.resolve(this.stateReply)
      return Promise.resolve(true)
    },
    reload() { this.reloads += 1 },
    loadURL(url) { this.loads.push(url); this.url = url; return Promise.resolve() },
    getURL() { return this.url },
    setUserAgent(value) { this.userAgents.push(value) },
    getBoundingClientRect() { return { left: 10, top: 40, width: 900, height: 600 } },
  }
  return element
}

/** Build one isolated GUI stand-in and evaluate the bundle inside it. */
function harness(options = {}) {
  const calls = { acquire: [], release: [], fetch: [], intervals: 0, intervalCallbacks: [], cleared: 0 }
  const effects = []
  const refs = []
  const styleTags = new Map()
  const stateReply = JSON.stringify(options.state === undefined
    ? { url: PAGE_URL, cleared: false, storage: [['userToken', JSON.stringify({ value: 't', __version: 1 })], ['theme', '"dark"']], cookie: 'smidV2=abc' }
    : options.state)

  const body = makeElement('body', stateReply)
  const head = makeElement('head', stateReply)
  const html = { getAttribute: () => 'es-ES' }

  function createElement(tagName) {
    return makeElement(tagName, stateReply)
  }

  const document = {
    documentElement: html,
    head,
    body,
    getElementById(id) { return styleTags.get(id) ?? null },
    createElement(tagName) {
      const element = createElement(tagName)
      if (tagName === 'style') styleTags.set(element.id, element)
      return element
    },
    querySelector(selector) {
      if (selector !== '[' + OVERLAY + ']') return null
      return body.children.find((entry) => entry.getAttribute(OVERLAY) !== null) ?? null
    },
  }

  // A <style> element's id is assigned after creation; keep the map in sync.
  const rawCreate = document.createElement
  document.createElement = function (tagName) {
    const element = rawCreate(tagName)
    if (tagName === 'style') {
      Object.defineProperty(element, 'id', {
        get: () => element.attributes.id,
        set: (value) => { element.attributes.id = value; styleTags.set(value, element) },
      })
    }
    return element
  }

  const listeners = {}
  const fetch = async (url, init) => {
    calls.fetch.push({ url, init })
    if (url.indexOf('/restore') !== -1) {
      return {
        json: async () => ({
          ok: true,
          storage: options.restoreStorage === undefined
            ? [['userToken', JSON.stringify({ value: 'saved', __version: 1 })], ['theme', '"light"']]
            : options.restoreStorage,
          cookie: options.restoreCookie === undefined ? 'smidV2=restored' : options.restoreCookie,
          savedAt: '2026-01-01T00:00:00.000Z',
        }),
      }
    }
    return { json: async () => ({ ok: true, saved: true }) }
  }

  const bridge = options.bridge === false ? undefined : {
    async acquire(identity) {
      calls.acquire.push(identity)
      return { lease: 'lease-1', partition: 'dsh-sidebar-browser-1234abcd' }
    },
    async release(lease) { calls.release.push(lease) },
  }

  const window = {
    addEventListener(type, listener) { (listeners[type] ??= []).push(listener) },
    removeEventListener() {},
    dshDesktop: { protocolVersion: 1, browser: bridge },
  }

  let entry = null
  window.__ModuleLoader__ = { load(spec) { entry = spec } }

  const sandbox = {
    window,
    document,
    navigator: { userAgent: UA, language: 'es-ES' },
    fetch,
    console,
    URL,
    setInterval: (callback) => {
      calls.intervals += 1
      calls.intervalCallbacks.push(callback)
      return calls.intervals
    },
    clearInterval: () => {},
    dshDesktop: window.dshDesktop,
    __ModuleLoader__: window.__ModuleLoader__,
  }

  vm.runInContext(readFileSync(BUNDLE, 'utf8'), vm.createContext(sandbox), { filename: BUNDLE })

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useRef: (initial) => {
      const ref = { current: initial }
      refs.push(ref)
      return ref
    },
    useEffect: (callback) => { effects.push(callback) },
  }

  const registered = []
  const api = entry.factory((name) => {
    assert.equal(name, 'react', 'the bundle only requires react')
    return React
  })
  const ctx = {
    slots: {
      inject(name, register) {
        assert.ok(name === 'sidebar.panellist' || name === 'main', `unexpected slot ${name}`)
        register()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
    effect(callback) {
      callback()
      return () => {}
    },
  }
  api.apply(ctx)

  return {
    api,
    calls,
    registered,
    refs,
    effects,
    document,
    body,
    window,
    stateReply,
    sandbox,
    styleTags,
    guest() {
      const container = body.children.find((entry) => entry.getAttribute(OVERLAY) !== null)
      if (container === undefined) return { container: null, element: null }
      return { container, element: container.children[0] ?? null }
    },
  }
}

/** Let every pending microtask and queued promise settle. */
async function settle(times = 8) {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Mount the panel the layout would mount, and return its host element. */
async function mountPanel(bundle) {
  const panel = bundle.registered.find((entry) => entry.options.name === 'main')
  assert.ok(panel, 'the main panel is registered')
  const rendered = panel.component({})
  const host = makeElement('div', bundle.stateReply)
  rendered.props.ref.current = host
  const cleanup = bundle.effects[bundle.effects.length - 1]()
  await settle()
  return { host, cleanup }
}

test('the bundle registers one sidebar row and one main panel under one id', () => {
  const bundle = harness()
  const row = bundle.registered.find((entry) => entry.options.name === 'sidebar.panellist')
  const panel = bundle.registered.find((entry) => entry.options.name === 'main')
  assert.equal(row.options.id, PANEL_ID)
  assert.equal(panel.options.key, PANEL_ID)
  assert.equal(row.options.label(), 'Chat DeepSeek')
})

test('mounting reserves one guest and attaches the approved webview', async () => {
  const bundle = harness()
  const { host } = await mountPanel(bundle)

  assert.deepEqual(bundle.calls.acquire, ['dsh-desktop-chat'])
  const { container, element } = bundle.guest()
  assert.ok(element, 'the webview was attached')
  assert.equal(element.tagName, 'WEBVIEW')
  assert.equal(element.getAttribute('name'), 'lease-1')
  assert.equal(element.getAttribute('partition'), 'dsh-sidebar-browser-1234abcd')
  assert.equal(element.getAttribute('src'), 'about:blank#lease-1')
  assert.equal(element.getAttribute('allowpopups'), '')
  assert.equal(element.getAttribute('useragent'), UA.replace(' Electron/33.2.0', ''))
  assert.doesNotMatch(element.getAttribute('useragent'), /Electron/)

  // The guest lives at the document root, never inside the slot's host element.
  assert.equal(host.children.length, 0)
  assert.equal(container.parentElement, bundle.body)
  assert.equal(container.style.display, 'block')
  assert.equal(container.style.width, '900px')
  assert.equal(bundle.calls.intervals, 1, 'one save interval per guest')
})

test('the saved state is written on the origin and the page reloads once', async () => {
  const bundle = harness()
  await mountPanel(bundle)
  const { element } = bundle.guest()
  element.url = PAGE_URL

  element.dispatch('dom-ready')
  assert.deepEqual(element.loads, [PAGE_URL])
  assert.equal(element.userAgents.length, 1)

  element.dispatch('did-finish-load')
  await settle()

  const write = element.scripts.find((script) => script.indexOf('localStorage.setItem') !== -1)
  assert.ok(write, 'the guest storage was restored')
  assert.match(write, /saved/)
  assert.match(write, /smidV2=restored/)
  assert.equal(element.reloads, 1, 'one reload after restoring')

  element.url = PAGE_URL
  element.dispatch('did-finish-load')
  await settle()

  const save = bundle.calls.fetch.find((call) => call.url.indexOf('/session/save') !== -1)
  assert.ok(save, 'the refreshed state was saved')
  assert.equal(save.init.headers['x-dsh-desktop-chat'], '1')
  assert.deepEqual(JSON.parse(save.init.body).storage[0][0], 'userToken')
})

test('no restore means no reload, and the state is saved right away', async () => {
  const bundle = harness({ restoreStorage: [], restoreCookie: '', state: { url: PAGE_URL, cleared: false, storage: [['theme', '"dark"']], cookie: '' } })
  await mountPanel(bundle)
  const { element } = bundle.guest()
  element.url = PAGE_URL

  element.dispatch('dom-ready')
  element.dispatch('did-finish-load')
  await settle()

  assert.equal(element.reloads, 0)
  const save = bundle.calls.fetch.find((call) => call.url.indexOf('/session/save') !== -1)
  assert.ok(save, 'the state was saved')
})

test('hiding the panel hides the guest but keeps it in the document', async () => {
  const bundle = harness()
  const first = await mountPanel(bundle)
  const { container } = bundle.guest()

  first.cleanup()
  assert.equal(container.style.display, 'none')
  assert.equal(container.parentElement, bundle.body)
  assert.equal(bundle.calls.release.length, 0, 'the lease is kept for the next mount')

  await mountPanel(bundle)
  assert.equal(container.style.display, 'block')
  assert.equal(bundle.calls.acquire.length, 1, 'the guest is reused')
  assert.equal(bundle.calls.intervals, 1, 'no second guest timer')
})

test('an in-page login keeps the save loop alive', async () => {
  const bundle = harness({ restoreStorage: [], restoreCookie: '' })
  await mountPanel(bundle)
  const { element } = bundle.guest()
  element.url = PAGE_URL
  element.dispatch('dom-ready')
  element.dispatch('did-finish-load')
  await settle()

  const before = bundle.calls.fetch.filter((call) => call.url.indexOf('/session/save') !== -1).length
  assert.ok(before >= 1, 'the first full load saved')

  // The site is a single-page app: signing in navigates without a document
  // load, so `did-start-loading` fires and `did-finish-load` never does.
  element.dispatch('did-start-loading')
  element.url = PAGE_URL
  element.dispatch('did-stop-loading')
  await settle()

  const saves = bundle.calls.fetch.filter((call) => call.url.indexOf('/session/save') !== -1)
  assert.equal(saves.length, before + 1, 'the in-page navigation triggered a save')
  const body = JSON.parse(saves[saves.length - 1].init.body)
  assert.equal(body.skip, undefined, 'a settled guest posts real state')
  assert.ok(Array.isArray(body.storage))
})

test('a skipped attempt reports its reason instead of staying silent', async () => {
  const bundle = harness()
  await mountPanel(bundle)
  const { element } = bundle.guest()
  element.url = PAGE_URL
  element.dispatch('dom-ready')
  element.dispatch('did-finish-load')
  await settle()

  // Simulate the frozen case: the page started loading and nothing settled.
  element.dispatch('did-start-loading')
  bundle.calls.intervalCallbacks[0]()
  await settle()

  const last = bundle.calls.fetch[bundle.calls.fetch.length - 1]
  const body = JSON.parse(last.init.body)
  assert.equal(body.skip, 'not-ready')
  assert.equal(body.storage, undefined, 'a skip body carries no state')
  assert.equal(body.diag.ready, false)
})

test('without the native bridge the panel explains itself', async () => {
  const bundle = harness({ bridge: false })
  const panel = bundle.registered.find((entry) => entry.options.name === 'main')
  const rendered = panel.component({})
  const host = makeElement('div')
  rendered.props.ref.current = host
  const cleanup = bundle.effects[bundle.effects.length - 1]()
  await settle()

  assert.equal(bundle.calls.acquire.length, 0)
  assert.equal(host.children.length, 1)
  assert.match(host.children[0].textContent, /DeepSeek Harness Desktop/)
  assert.equal(bundle.guest().element, null)
  if (typeof cleanup === 'function') cleanup()
})
