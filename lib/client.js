/**
 * dsh-desktop-chat — browser half.
 *
 * One sidebar entry renders the official chat.deepseek.com web app inside the
 * DSH window, filling the center column. Both halves of that are slots the
 * shell owns:
 *
 *   - `sidebar.panellist` gets the label and icon; the sidebar owns the button
 *     and selects the main panel whose id matches;
 *   - `main` (keyed by the same id) gets the page. The layout renders only the
 *     selected key, so switching panels is the shell's business.
 *
 * The page is the desktop shell's native browser guest, not an iframe (the site
 * sends `frame-ancestors 'none'`): the renderer asks
 * `globalThis.dshDesktop.browser` for a reservation and attaches a `<webview>`
 * whose `src` is `about:blank#<lease>` and whose `partition` matches. The shell
 * approves that attach and rewrites the web preferences.
 *
 * The guest element deliberately lives outside the React tree, in a container
 * this plugin owns at the document root: a `<webview>` is destroyed when it
 * leaves the document, so a guest owned by the slot would be torn down and
 * reloaded — losing nothing but wasting a navigation — every time the user
 * looked at another panel. Instead the slot hands this plugin a measured area
 * and the persistent guest is positioned onto it while selected, and hidden
 * when not.
 *
 * Session survival is page-side only: the shell's partitions are
 * process-lifetime, and this plugin's Host half cannot reach Electron's cookie
 * store (see lib/index.js). So the guest's `localStorage` and `document.cookie`
 * are snapshotted through the Host routes and written back before the page is
 * reloaded. DeepSeek keeps its auth token in `localStorage["userToken"]`, which
 * is what makes that work; HttpOnly cookies cannot be carried and are reported
 * as such.
 */

window.__ModuleLoader__.load({
  id: '@jamolpe88/dsh-desktop-chat',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /** This plugin's panel id: the sidebar row and the main cell share it. */
    const PANEL_ID = 'deepseek-chat'
    /** The page this plugin exists to show. */
    const PAGE_URL = 'https://chat.deepseek.com/'
    /** The only origin whose storage this plugin ever touches. */
    const PAGE_ORIGIN = 'https://chat.deepseek.com'
    /** Storage identity for the guest reservation. */
    const STORAGE_IDENTITY = 'dsh-desktop-chat'
    /** Routes served by the Host half. */
    const ROUTES = {
      restore: '/api/dsh-desktop-chat/session/restore',
      save: '/api/dsh-desktop-chat/session/save',
      forget: '/api/dsh-desktop-chat/session/forget',
    }
    /** Header the Host half checks; a cross-site form post cannot set it. */
    const GUARD_HEADER = 'x-dsh-desktop-chat'
    /** How often the guest's own storage is snapshotted while it is open. */
    const SAVE_INTERVAL_MS = 10000

    const STYLE_ID = 'dsh-desktop-chat-style'
    const OVERLAY_ATTR = 'data-dsh-desktop-chat-overlay'

    /** Locale at read time, so the label follows the app's language. */
    function localeTag() {
      return String(document.documentElement.getAttribute('lang')
        || (typeof navigator === 'object' ? navigator.language : '')
        || '').toLowerCase()
    }

    function isSpanish() {
      return localeTag().indexOf('es') === 0
    }

    /** Every visible string this plugin owns. */
    function copy() {
      if (isSpanish()) return {
        label: 'Chat DeepSeek',
        failed: 'No se pudo cargar DeepSeek',
        noBridge: 'Esta vista necesita DeepSeek Harness Desktop: el perfil web no ofrece el navegador nativo integrado.',
        retry: 'Reintentar',
      }
      return {
        label: 'Chat DeepSeek',
        failed: 'Could not load DeepSeek',
        noBridge: 'This view needs DeepSeek Harness Desktop: a plain web profile provides no native browser guest.',
        retry: 'Retry',
      }
    }

    const CSS = [
      '.dsh-dc-host{width:100%;height:100%;min-width:0;min-height:0;display:flex;align-items:center;justify-content:center}',
      '[' + OVERLAY_ATTR + ']{position:fixed;display:none;z-index:40}',
      '[' + OVERLAY_ATTR + '] webview{-webkit-app-region:no-drag;border:0;flex:auto;width:100%;min-width:0;height:100%;min-height:0;display:flex}',
      '.dsh-dc-message{max-width:460px;padding:22px;text-align:center;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family)}',
      '.dsh-dc-action{margin-top:14px;padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-elevated);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px;font-family:var(--dsw-font-family)}',
    ].join('\n')

    /**
     * The desktop shell's browser bridge, when this renderer is the desktop
     * app's primary frame. A plain web profile exposes only a protocol version.
     */
    const carrier = globalThis.dshDesktop
    const bridge = carrier !== null && typeof carrier === 'object' && carrier.protocolVersion === 1
      ? carrier.browser
      : undefined

    /**
     * The only state that outlives a panel mount. `container` and `element`
     * stay in the document for the whole app run so the guest is never torn
     * down; the slot only decides where they are shown.
     */
    let guest = null
    /** In-flight acquisition, so two mounts cannot reserve two guests. */
    let acquiring = null
    /** Last acquisition failure, if any. */
    let failure = ''

    /** Render any thrown value as a message. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** Inject the stylesheet — and re-inject it: a hot swap runs new code under the old CSS. */
    function ensureStyle() {
      let tag = document.getElementById(STYLE_ID)
      if (tag === null) {
        tag = document.createElement('style')
        tag.id = STYLE_ID
        document.head.appendChild(tag)
      }
      tag.textContent = CSS
    }

    /** A centred message, optionally with a retry button. */
    function messageBox(text, action) {
      const box = document.createElement('div')
      box.className = 'dsh-dc-message'
      box.textContent = text
      if (action !== undefined) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'dsh-dc-action'
        button.textContent = action.label
        button.addEventListener('click', async function () {
          if (button.disabled) return
          button.disabled = true
          try {
            await action.run()
          } finally {
            button.disabled = false
          }
        })
        box.appendChild(button)
      }
      return box
    }

    /** The document-root container that keeps the guest alive. */
    function overlayContainer() {
      const existing = document.querySelector('[' + OVERLAY_ATTR + ']')
      if (existing !== null && existing !== undefined) return existing
      const box = document.createElement('div')
      box.setAttribute(OVERLAY_ATTR, '')
      document.body.appendChild(box)
      return box
    }

    /** The JSON text the guest returns with its own credentials. */
    const READ_STATE_SCRIPT = [
      "location.origin !== 'https://chat.deepseek.com' ? null : JSON.stringify({",
      '  url: location.href,',
      '  cleared: /sign_?in|log_?in|passport/i.test(location.pathname),',
      '  storage: Object.keys(localStorage)',
      '    .filter(function (key) { return !/^(aws_waf|awswaf)/i.test(key) })',
      '    .map(function (key) { return [key, localStorage.getItem(key)] }),',
      '  cookie: document.cookie.split(";")',
      '    .map(function (pair) { return pair.trim() })',
      '    .filter(function (pair) { return pair && !/^aws-waf-token=/i.test(pair) })',
      '    .join("; ")',
      '})',
    ].join('\n')

    /**
     * Read everything the guest page itself can reach: its storage, its own
     * cookie string and whether it is showing a sign-in screen.
     * @param element - the live webview.
     * @returns the guest state, or null when the page is elsewhere.
     */
    function readGuestState(element) {
      return element.executeJavaScript(READ_STATE_SCRIPT)
    }

    /**
     * Write a guest state back into the page.
     * Cookies are re-scoped to the site root, which is where a login cookie
     * belongs; the original attributes are not recoverable from `document.cookie`.
     * @param element - the live webview.
     * @param state - `{ storage, cookie }`.
     * @returns true when the page accepted it.
     */
    function writeGuestState(element, state) {
      return element.executeJavaScript(
        '(function () { if (location.origin !== "https://chat.deepseek.com") return false; var state = '
        + JSON.stringify(state) + ';'
        + ' var storage = Array.isArray(state.storage) ? state.storage : [];'
        + ' for (var i = 0; i < storage.length; i++) {'
        + '   if (!Array.isArray(storage[i]) || typeof storage[i][0] !== "string") continue;'
        + '   try { localStorage.setItem(storage[i][0], String(storage[i][1])) } catch (error) {}'
        + ' }'
        + ' if (typeof state.cookie === "string" && state.cookie !== "") {'
        + '   var parts = state.cookie.split(";");'
        + '   for (var j = 0; j < parts.length; j++) {'
        + '     var pair = parts[j].trim();'
        + '     if (pair.indexOf("=") === -1) continue;'
        + '     try { document.cookie = pair + "; path=/" } catch (error) {}'
        + '   }'
        + ' }'
        + ' return true })()',
      )
    }

    /** Clear the guest's own storage and cookies (a real logout, not a snapshot edit). */
    function clearGuestState(element) {
      return element.executeJavaScript(
        '(function () { if (location.origin !== "https://chat.deepseek.com") return false;'
        + ' try { localStorage.clear() } catch (error) {}'
        + ' var names = document.cookie.split(";").map(function (pair) { return pair.split("=")[0].trim() }).filter(Boolean);'
        + ' for (var i = 0; i < names.length; i++) {'
        + '   document.cookie = names[i] + "=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT"'
        + ' }'
        + ' return true })()',
      )
    }

    /** Check the live URL before any session operation. */
    function onDeepSeek(element) {
      try {
        return new URL(element.getURL()).origin === PAGE_ORIGIN
      } catch {
        return false
      }
    }

    /** Ask the Host for the saved page-state before the first navigation. */
    async function restoreSession() {
      const response = await fetch(ROUTES.restore, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
        body: '{}',
      })
      const payload = await response.json()
      if (payload === null || typeof payload !== 'object') return null
      if (payload.ok !== true) return null
      const storage = Array.isArray(payload.storage) ? payload.storage : []
      const cookie = typeof payload.cookie === 'string' ? payload.cookie : ''
      if (storage.length === 0 && cookie === '') return null
      return { storage, cookie }
    }

    /**
     * Ask the Host to refresh the snapshot with what the guest can read.
     * @param withState - whether to include the guest's own state.
     * @param target - the guest record; defaults to the live one.
     */
    async function saveSession(withState, target) {
      const record = target === undefined ? guest : target
      if (!record || !record.ready || !onDeepSeek(record.element)) return
      const body = {}
      if (withState) {
        try {
          const raw = await readGuestState(record.element)
          if (raw === null) return
          const state = JSON.parse(raw)
          if (!record.ready || !onDeepSeek(record.element) || state === null || typeof state !== 'object') return
          if (!Array.isArray(state.storage) || typeof state.cookie !== 'string') return
          body.storage = state.storage
          body.cookie = state.cookie
          body.cleared = state.cleared === true
        } catch (error) {
          return
        }
      }
      try {
        await fetch(ROUTES.save, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
          body: JSON.stringify(body),
        })
      } catch (error) {
        console.warn('[dsh-desktop-chat] session save failed:', error)
      }
    }

    /**
     * Forget the saved session and clear the live guest, so the next start
     * shows the sign-in screen instead of restoring a stale token.
     * @returns whether the snapshot was deleted.
     */
    async function forgetSession() {
      let deleted = false
      try {
        const response = await fetch(ROUTES.forget, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [GUARD_HEADER]: '1' },
          body: '{}',
        })
        const payload = await response.json()
        deleted = payload !== null && payload.ok === true && payload.deleted === true
      } catch (error) {
        console.warn('[dsh-desktop-chat] session forget failed:', error)
      }
      if (guest !== null) {
        try {
          await clearGuestState(guest.element)
        } catch (error) {
          console.warn('[dsh-desktop-chat] could not clear the live page:', error)
        }
        try {
          guest.ready = false
          guest.element.reload()
        } catch (error) {
          console.warn('[dsh-desktop-chat] reload failed:', error)
        }
      }
      return deleted
    }

    /**
     * Reserve a guest and attach its webview, once per app run.
     * @returns a promise resolving once the attempt settled.
     */
    function ensureGuest() {
      if (guest !== null || bridge === undefined) return Promise.resolve()
      if (acquiring !== null) return acquiring
      acquiring = (async () => {
        try {
          const reservation = await bridge.acquire(STORAGE_IDENTITY)
          if (reservation === null || typeof reservation !== 'object'
            || typeof reservation.lease !== 'string' || typeof reservation.partition !== 'string') {
            throw new Error('the desktop browser bridge returned no reservation')
          }
          // Read the saved page-state before anything is requested: the guest
          // gets it as soon as the origin is loaded, then one reload.
          const restored = await restoreSession()
          const element = document.createElement('webview')
          element.setAttribute('name', reservation.lease)
          element.setAttribute('partition', reservation.partition)
          element.setAttribute('allowpopups', '')
          element.setAttribute('data-sidebar-browser-frame', '')
          element.setAttribute('src', 'about:blank#' + reservation.lease)
          // The site greets a UA containing "electron" with its unsafe-environment
          // dialog, and its check is a literal substring test. Drop ONLY the
          // Electron token; the Chrome version stays exactly as the engine
          // reports it so client hints stay consistent.
          const userAgent = typeof navigator === 'object' && typeof navigator.userAgent === 'string'
            ? navigator.userAgent.replace(/\s*Electron\/[\d.]+/i, '')
            : ''
          if (userAgent !== '') element.setAttribute('useragent', userAgent)

          let restoreState = restored === null ? 'none' : 'pending'
          const record = { lease: reservation.lease, partition: reservation.partition, element, ready: false }

          element.addEventListener('dom-ready', function () {
            if (userAgent !== '') {
              try {
                element.setUserAgent(userAgent)
              } catch (error) {
                console.warn('[dsh-desktop-chat] could not set the guest user agent:', error)
              }
            }
            element.loadURL(PAGE_URL).catch(function (error) {
              failure = messageOf(error)
            })
          }, { once: true })

          element.addEventListener('did-start-loading', function () {
            record.ready = false
          })

          // Storage can only be written while the page is on its own origin, so
          // it is restored after the first load and the page is then asked to
          // load once more — this time already signed in. Until that settles,
          // snapshots are skipped: the freshly loaded page still has empty
          // storage, and saving that would erase the snapshot being restored.
          element.addEventListener('did-finish-load', async function () {
            if (guest !== record || !onDeepSeek(element) || restoreState === 'restoring') return
            if (restoreState === 'pending') {
              restoreState = 'restoring'
              try {
                const applied = await writeGuestState(element, restored)
                if (guest !== record) return
                if (applied !== true || !onDeepSeek(element)) {
                  restoreState = 'pending'
                  return
                }
                restoreState = 'reloading'
                element.reload()
              } catch (error) {
                restoreState = 'pending'
                console.warn('[dsh-desktop-chat] could not restore site storage:', error)
              }
              return
            }
            restoreState = 'done'
            record.ready = true
            void saveSession(true, record)
          })

          const container = overlayContainer()
          container.appendChild(element)
          record.container = container
          record.timer = setInterval(function () {
            void saveSession(true, record)
          }, SAVE_INTERVAL_MS)
          guest = record
          failure = ''
        } catch (error) {
          failure = messageOf(error)
        } finally {
          acquiring = null
        }
      })()
      return acquiring
    }

    /** Release the guest, for plugin disposal. */
    function disposeGuest() {
      if (guest === null) return
      const releasing = guest
      guest = null
      if (releasing.timer !== undefined) clearInterval(releasing.timer)
      // Last chance to keep the login: the page is about to be torn down.
      void saveSession(true, releasing)
      releasing.container.remove()
      if (bridge !== undefined) {
        try {
          void bridge.release(releasing.lease)
        } catch (error) {
          // Already gone.
        }
      }
    }

    /** Position the persistent guest over the area the slot gave this panel. */
    function syncBounds(host) {
      if (guest === null) return
      const rect = host.getBoundingClientRect()
      const style = guest.container.style
      style.left = rect.left + 'px'
      style.top = rect.top + 'px'
      style.width = rect.width + 'px'
      style.height = rect.height + 'px'
    }

    /** The center-column panel the layout mounts while this id is selected. */
    function DeepSeekPanel() {
      const hostRef = React.useRef(null)

      React.useEffect(function () {
        const host = hostRef.current
        if (host === null || host === undefined) return undefined
        let alive = true
        let observer
        let reposition = null

        const showMessage = function (text) {
          host.replaceChildren()
          host.appendChild(messageBox(text, {
            label: copy().retry,
            run: function () {
              failure = ''
              void ensureGuest().then(function () {
                if (alive) mount()
              })
            },
          }))
        }

        const mount = function () {
          if (!alive) return
          if (guest === null) {
            showMessage(copy().failed + ': ' + (failure || 'unknown'))
            return
          }
          host.replaceChildren()
          syncBounds(host)
          guest.container.style.display = 'block'
          reposition = function () {
            if (alive) syncBounds(host)
          }
          if (typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(reposition)
            observer.observe(host)
          }
          window.addEventListener('resize', reposition)
        }

        if (bridge === undefined) {
          showMessage(copy().noBridge)
          return undefined
        }

        void ensureGuest().then(mount)

        return function () {
          alive = false
          if (observer !== undefined) observer.disconnect()
          if (reposition !== null) window.removeEventListener('resize', reposition)
          // Hidden, never detached: the guest keeps its page and its login.
          if (guest !== null) {
            void saveSession(true)
            guest.container.style.display = 'none'
          }
        }
      }, [])

      return h('div', { ref: hostRef, className: 'dsh-dc-host' })
    }

    /** The sidebar row's icon. The sidebar owns the button around it. */
    function DeepSeekIcon(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M2.6 5.1h7.2a3.6 3.6 0 0 1 0 7.2H6.4L3 14.3l.4-2.1A3.6 3.6 0 0 1 2.6 5.1z' }),
      h('path', { d: 'M5.2 8.2h4.6M5.2 10.3h3.1' }))
    }

    /** Register the nav row and the page, then own the guest's lifetime. */
    function apply(ctx) {
      ensureStyle()
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 0,
        label: () => copy().label,
      }, DeepSeekIcon))
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, DeepSeekPanel))
      ctx.effect(() => () => {
        disposeGuest()
      }, 'dsh-desktop-chat: native guest')
    }

    return { inject: ['slots'], apply }
  },
})
