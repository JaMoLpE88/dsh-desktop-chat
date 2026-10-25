# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versioning is
[SemVer](https://semver.org/).

## [0.1.2] — 2026-10-25

### Changed

- Both READMEs now show the plugin: a hero screenshot, the sidebar entry and the chat inside the panel, plus
  badges for npm, GitHub release, license, DSH target, platform and the dsh-plugin.org listing.
- Screenshots live in `docs/images/` and are referenced through absolute URLs, so they render on GitHub, npm
  and the plugin catalog alike.

## [0.1.1] — 2026-10-25

### Changed

- The README is now in English, because that is what the npm and catalog pages show. The Spanish version
  lives in [README.es.md](README.es.md) and is shipped in the package too.

## [0.1.0] — 2026-10-25

### Added

- A **Chat DeepSeek** sidebar panel that shows `https://chat.deepseek.com/` in the center column through the
  DSH Desktop native browser guest.
- Page persistence across restarts: a snapshot of `localStorage` and `document.cookie` in
  `~/.dsh/dsh-desktop-chat/session.json`, restored before the first useful navigation.
- A guest that survives panel switches: hiding the panel neither destroys nor reloads the page.
- A degradation guard: a save with no session cannot overwrite a snapshot that had one; an explicit sign-out
  does clear it.
- Diagnostics and maintenance routes: `state`, `session/restore`, `session/save`, `session/forget`, guarded
  by a header and never exposing credentials.
- `node --test` coverage for both halves (22 cases).

### Validated

- 2026-10-25, Windows 11, DSH Desktop `0.2.1-rc.3`: manual sign-in, full exit and restart; the session
  survived (27 keys restored, token included, before the page loaded). 22 tests green.

### Fixed (before release)

- Saving froze after signing in: the site navigates inside its single-page app and never fires
  `did-finish-load`, so the guest stayed marked as not ready and only the pre-login state was saved.
  `did-stop-loading` and `did-navigate-in-page` now re-arm saving.
- Skipped attempts are no longer silent: they are sent as `{ skip, diag }` and `/state` reports the reason
  and counters.

### Known limitations

- `HttpOnly` cookies (WAF/Cloudflare) are not persisted: the shell does not expose them to plugins and the
  Host cannot import `electron`.
- No "forget session" button in the interface; use the documented route or sign out on the website.
