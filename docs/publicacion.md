# Fase D — Publicación

Estado a 2026-10-25: **GitHub y npm publicados**; catálogo y jmolo.es preparados y sin enviar.

## 0. Estado real

| Destino | Estado | Evidencia |
|---|---|---|
| GitHub | ✅ público | `https://github.com/JaMoLpE88/dsh-desktop-chat`, rama `main`, tag `v0.1.0`, release publicada, topics `dsh-plugin` incluido |
| npm | ✅ `0.1.0` | `dist-tags.latest = 0.1.0`; tarball 200; instalado en el perfil `desktop` desde el registro |
| Perfil `desktop` | ✅ desde npm | `"@jamolpe88/dsh-desktop-chat": "^0.1.0"`; ficheros instalados idénticos al repo |
| dsh-plugin.org | ⏳ pendiente de escaneo | la ficha aún da 404; el hub indexa por el topic `dsh-plugin` |
| jmolo.es | ⏳ preparado | texto en la sección 4; no publicado |

- 22 pruebas en verde (`node --test`).
- Validado en Windows 11 con DSH Desktop `0.2.1-rc.3`: la sesión sobrevive al cierre completo.

Nota: el primer intento de publicación creó un marcador `0.0.0-stage` («temporary package placeholder for
staged publishing»). No es instalable como versión normal y no debe usarse; la versión buena es `0.1.0`.
Deprecarlo requiere OTP: `npm deprecate "@jamolpe88/dsh-desktop-chat@0.0.0-stage" "usa 0.1.0"`.

## 1. GitHub (hecho)

Repositorio: `https://github.com/JaMoLpE88/dsh-desktop-chat` (público).

```bash
git remote add origin https://github.com/JaMoLpE88/dsh-desktop-chat.git
git push -u origin main
git tag -a v0.1.0 -m "dsh-desktop-chat 0.1.0"
git push origin v0.1.0
```

En la web del repositorio (Settings → Topics) añadir:

```
dsh-plugin, dsh, deepseek-harness, deepseek, deepseek-chat, webview, desktop
```

`dsh-plugin` es obligatorio para el catálogo. Descripción sugerida:

> Official DeepSeek Chat inside DSH Desktop: one sidebar panel, the real chat.deepseek.com page, and a
> session that survives restarts — no Electron internals, no chat reimplementation.

## 2. npm (hecho)

Paquete: `@jamolpe88/dsh-desktop-chat` (npm no admite mayúsculas en el ámbito, por eso `jamolpe88`; el
usuario de GitHub sigue siendo `JaMoLpE88`).

```bash
npm login
npm publish --access public
```

Publicado `0.1.0`; `dist-tags.latest = 0.1.0`. El perfil `desktop` ya consume la versión del registro:

```bash
dsh plugin --profile desktop add @jamolpe88/dsh-desktop-chat
```

`package.json` lleva `publishConfig.access: public`, `files` acotado (`lib/`, `cordis.patch.yml`, `NOTICE`,
`README.md`, `CHANGELOG.md`, `LICENSE`) y `engines.dsh: >= 0.2.1-rc.3`.

## 3. dsh-plugin.org (pendiente de escaneo)

Requisitos verificados en <https://dsh-plugin.org/submit>:

| Requisito | Estado |
|---|---|
| Repositorio público | ✅ |
| Topic `dsh-plugin` | ✅ |
| `package.json` en la raíz | ✅ |
| README con comando de instalación | ✅ (`dsh plugin --profile desktop add @jamolpe88/dsh-desktop-chat`) |
| Módulo con `apply(ctx)` | ✅ (`lib/index.js`) |
| Licencia declarada | ✅ Apache-2.0 |
| Publicado en npm (para el Plugin Hub interno) | ✅ |

El hub escanea el topic; además se puede abrir un issue con la plantilla. Texto listo:

```markdown
[Plugin submission] JaMoLpE88/dsh-desktop-chat — The official DeepSeek Chat inside DSH Desktop, signed in across restarts

### Repository
https://github.com/JaMoLpE88/dsh-desktop-chat

### One-line value
Opens chat.deepseek.com in a DSH Desktop panel and keeps the manual login across full app restarts.

### Category
UI & Experience

### Install command
dsh plugin --profile desktop add @jamolpe88/dsh-desktop-chat

### Compatibility
DSH Desktop >= 0.2.1-rc.3 (tested on 0.2.1-rc.3, Windows 11); Node >= 22; profile `desktop`.

### License
Apache-2.0

### Screenshots / demo
<screenshot of the panel with the official page>

### Notes
No Electron imports; no agent tools; no network service. Session persistence carries the page's own
localStorage and non-HttpOnly cookies; HttpOnly cookies (WAF clearance) cannot be carried because DSH does
not expose the guest partition's cookie store to plugins.

### Pre-submission checklist
- [x] Repository is public
- [x] GitHub topic `dsh-plugin` added
- [x] README includes the install command
- [x] Plugin exports an `apply(ctx)` module
- [x] Repository root includes a `package.json`
```

(La captura hay que hacerla después de publicar; no se incluye ninguna en el repo todavía.)

## 4. jmolo.es — descripción lista para pegar

> **dsh-desktop-chat — DeepSeek Chat dentro de DeepSeek Harness Desktop**
>
> Abre la web oficial de DeepSeek Chat en un panel de DSH Desktop, sin reimplementar el chat y sin añadir
> modelos ni herramientas al agente. La diferencia con otros intentos: la sesión no se pierde al cerrar la
> aplicación.
>
> El problema venía de la arquitectura de DSH: las vistas de navegador usan una partición de sesión que vive
> solo en memoria, y el plugin corre en un proceso donde la API de Electron no está disponible. La solución
> no pelea contra eso: guarda el estado que la propia página puede leer —su `localStorage` y sus cookies
> visibles— y lo repone antes de cargar la web. Las cookies `HttpOnly` quedan fuera, y se dice.
>
> Verificado en Windows 11 con DSH Desktop 0.2.1-rc.3: inicio de sesión manual, cierre completo, reapertura y
> sesión activa. 22 pruebas automatizadas. Licencia Apache-2.0, código en
> `github.com/JaMoLpE88/dsh-desktop-chat`, instalación:
> `dsh plugin --profile desktop add @jamolpe88/dsh-desktop-chat`.
>
> Inspirado en el plugin `jaychang1989/dsh-webchat`, con implementación propia y atribución en el repositorio.

Nada de esto se ha publicado en jmolo.es ni se ha enviado al catálogo.

## 5. Orden recomendado

1. Autorizas la creación del repositorio y el push.
2. `npm publish`.
3. Instalación limpia desde npm y repetición de la prueba de reinicio (una vez, con la versión publicada).
4. Topic `dsh-plugin` + issue de catálogo (o esperar al escaneo).
5. Captura del panel para el README y la ficha del catálogo.
6. Publicar la descripción en jmolo.es.

## 6. Pendientes técnicos (no bloquean publicar)

- Botón «Olvidar sesión» en la interfaz (hoy: ruta documentada o cierre de sesión en la web).
- Interceptar F5/Ctrl+R para recargar el panel.
- Probar en macOS/Linux (el shell comparte el invitado nativo, pero no está verificado).
- `README.en.md` si el catálogo lo pide (hoy el README está en español).
