# Fase A — Diagnóstico técnico y propuesta

Fecha: 2026-10-25 · Entorno: Windows 11 · DSH Desktop `0.2.1-rc.3` · perfil `desktop`

Estado: investigación terminada. **No se ha implementado ni instalado nada.**

---

## 0. Método y evidencia

Todo lo que sigue se comprobó sobre la instalación real, no sobre documentación genérica:

| Fuente | Cómo se obtuvo |
|---|---|
| Repositorio de referencia | `git clone https://github.com/jaychang1989/dsh-webchat` (commit `0d8c897`, versión `0.7.8`, Apache-2.0) |
| Shell de escritorio (Electron main + preload) | Extraído de `C:\Users\moren\AppData\Local\Programs\DeepSeek Harness\resources\app.asar` (`lib/main.js`, `lib/preload-app.cjs`) |
| Runtime de DSH | `app.asar/dsh/node_modules/@deepseek-ai/...` (mismos paquetes que carga el Host) |
| Servicios y slots vivos | `cordis_inspect_query` (Host `Service`, Cliente `Service`/`Slots`/`Builtin`) |
| Snapshot del plugin original | `%USERPROFILE%\.dsh\dsh-webchat\session.json` (solo estructura y claves; **ningún valor leído ni copiado**) |

Nota previa: la carpeta de trabajo `C:\Development\dsh-desktop-webchat` no era escribible por el sandbox
(faltaba un permiso de Windows). Se reparó con la herramienta de diagnóstico del propio sandbox; se añadió
control total para tu usuario en esa carpeta, con script de reversión en
`C:\Development\dsh-desktop-webchat-acl-report\`. No se modificó ningún otro objeto.

---

## 1. Estado real del entorno (hallazgo previo)

- El perfil `desktop` **no tiene instalado** `@jaychang1989/dsh-webchat` ahora mismo:
  - `~/.dsh/profiles/desktop/package.json` no lo lista en `dependencies` ni en `dsh.profile.bundles`;
  - `~/.dsh/profiles/desktop/node_modules/@jaychang1989/` existe pero está **vacío**;
  - no hay rastro en `.plugin-manager/logs/*/pnpm.log`.
- Sí queda su carpeta de datos `~/.dsh/dsh-webchat/session.json`, escrita hoy a las 00:56.
- El diagnóstico que citas (`http://127.0.0.1:60201/api/dsh-webchat/state`) corresponde por tanto a una
  instancia anterior o a otro perfil de ejecución; la GUI actual escucha en `127.0.0.1:59863`.

Consecuencia práctica: la Fase C tendrá que **reinstalar** el plugin de referencia (o el nuevo) para
comparar, partiendo de cero.

### Qué contiene el snapshot actual

```
version=1  savedAt=2026-10-24T22:56:14Z  cookies=0  storage=25  cookie=275 bytes
userToken            -> {"value":null,"__version":1}
settingsJwt          -> {"value":null,"__version":1}
__appKit_userInfo    -> {"value":"","__version":1}
deepseek-device-id   -> 36 car.   smidV2 -> 63 car.
```

Esto es relevante: **el snapshot guardado no contiene sesión**. `userToken.value` es `null`, o sea que se
guardó estando desconectado (o se sobrescribió con el estado desconectado). Es decir, `storage: 25` no es
prueba de que la persistencia funcione: es prueba de que el almacenamiento se escribe, pero estaba vacío de
credenciales. Cualquier conclusión del tipo "guarda almacenamiento, luego la sesión persiste" sería falsa.

---

## 2. Cómo funciona el plugin de referencia (lo reutilizable conceptualmente)

Es un paquete de **doble cara** (`dsh.client` en `package.json` + `cordis.patch.yml` con una fila `insert`):

- **Cara Host** (`lib/index.js`, proceso Host): registra 5 rutas en `ctx.webServer`
  (`/api/dsh-webchat/{state,open,session/restore,session/save,external}`) y guarda el snapshot en
  `~/.dsh/dsh-webchat/session.json` (respeta `DSH_HOME`, escritura atómica, `0600`).
- **Cara Cliente** (`lib/client.js`, servida en `/plugins/<id>/client.js`): registra una fila en el slot
  `sidebar.panellist` con id `webchat` y el panel en el slot `main` con la misma clave. El panel no contiene
  la web: pide un *guest* al puente nativo (`globalThis.dshDesktop.browser.acquire("dsh-webchat")`), crea un
  `<webview>` con `src=about:blank#<lease>`, `partition` y `useragent` sin el token `Electron/`, y **lo
  mantiene fuera del árbol de React** (contenedor en `document.body`), posicionado sobre el hueco del panel.
  Así, ocultar el panel no desmonta la página.
- **Persistencia**: al arrancar, el cliente pide `session/restore` (que intenta reponer cookies vía Electron
  y devuelve `storage` + `cookie` de la página); tras cargar el origen escribe `localStorage` y
  `document.cookie` y recarga. Después guarda cada 30 s, al terminar de cargar y en `beforeunload`.
- **Fallback**: si no hay puente nativo (perfil web puro), intenta `BrowserWindow` → ventana `msedge/chrome
  --app` con `--user-data-dir` propio → navegador del sistema.

Lo conceptualmente reutilizable: doble cara, fila + panel por slots, guest persistente fuera del árbol,
restauración antes de la primera navegación útil, snapshot atómico, diagnóstico sin valores.

Lo que **no** funciona en Desktop: todo lo que depende de `electron` (`session.fromPartition`,
`BrowserWindow`). Ahí está el `cookies: 0`.

Detalle del diagnóstico original que conviene no malinterpretar: `last: {ok:false, via:"none"}` **no** indica
que el guest fallara; `last` solo registra el *fallback de ventana*, que en Desktop nunca llega a intentarse.

---

## 3. Causa raíz verificada (no inferida)

### 3.1 El Host de plugins no es el proceso Electron

`app.asar/lib/main.js`:

```js
function desktopNodeEnvironment(executable, bin, environment) {
  return { ...environment, ELECTRON_RUN_AS_NODE: "1", ... }        // main.js:3649-3658
}
...
const entry = join(this.runtimeDir, "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "index.js");
const child = spawn(this.node, [ ... entry, ... ], { env: desktopNodeEnvironment(...), stdio: [..., "ipc"] })
                                                                   // main.js:3793-3811
```

El Host es un **hijo del ejecutable de Electron arrancado en modo Node** (`ELECTRON_RUN_AS_NODE=1`). En ese
modo el módulo `electron` no existe: ni `import('electron')` ni `createRequire()` lo resuelven. De ahí el
`Cannot find module 'electron'` y el mensaje complementario `esm import resolved but exposed neither
BrowserWindow nor session` (el import resuelve a un módulo que no expone la API).

### 3.2 El canal IPC Host ↔ shell es un protocolo cerrado

`main.js:3664-3701` valida cada mensaje del Host (`ready`, `shutdown-complete`, `platform-session`,
`update-tasks`, `quit-inspection`, `fatal`) y `main.js:3819-3822` **mata el Host** ante cualquier otro tipo.
No hay forma soportada de pedirle al shell "dame las cookies de esta partición", y no la habrá sin cambiar
la aplicación.

### 3.3 Las particiones de invitado son efímeras por diseño

`main.js:10481-10513`:

```js
acquire(owner, workspace) {
  let partition = this.partitions.get(workspace);
  if (partition === void 0) {
    partition = `dsh-sidebar-browser-${randomUUID()}`;   // sin prefijo "persist:"
    this.configureSession(session.fromPartition(partition));
```

- nombre aleatorio en cada ejecución → ni siquiera se reutiliza entre arranques;
- sin `persist:` → la sesión de Chromium vive en memoria;
- el mapa `workspace → partition` solo dura lo que dura el proceso.

Y el invitado no puede pedir otra partición: `will-attach-webview` (`main.js:10543-10568`) exige
`params.partition === lease.partition`, cierra `preferences` salvo `disablePopups` y fuerza
`sandbox/contextIsolation`, sin `preload` inyectable. Tampoco hay `<iframe>` posible: el sitio manda
`frame-ancestors 'none'`.

El propio paquete oficial `@deepseek-ai/dsh-client-ui-sidebar-browser` lo documenta (README, sección de
limitaciones): **"Cookies and Web storage do not survive application restart."**

### 3.4 La única partición persistente del shell no sirve

`main.js:6806` crea `persist:dsh-platform-<sha256(origin,userId)>`, pero solo para la vista nativa de cuenta
(`dshPlatform.open(page, bounds)`, con `page` limitado a `usage`/`top_up` dentro del origen de la cuenta DSH).
No es un navegador genérico.

### 3.5 Lo que sí expone el shell al renderer

`lib/preload-app.cjs:757-843` publica `window.dshDesktop` (solo en el frame principal del origen de la app):

```js
{ protocolVersion: 1,
  browser: { acquire(workspace), release(lease), onOpenRequested(lease, cb) },
  deviceInfo(), keyboard: {...}, shortcuts: {...}, updates: {...} }
```

Nada de cookies, almacenamiento ni sesión de Chromium.

**Conclusión:** `cookies: 0` no es un bug del plugin de referencia ni algo que un plugin pueda arreglar con
otra API pública. En `0.2.1-rc.3` es imposible acceder a las cookies de la partición del invitado, y por
tanto a las `HttpOnly`. No existe una vía soportada para "más `localStorage`" ni para importar `electron`.

---

## 4. Qué se puede persistir realmente

| Mecanismo | ¿Persistible por un plugin? | Notas |
|---|---|---|
| `localStorage` del origen | Sí, vía `executeJavaScript` sobre el guest | Requiere que la página esté en su origen |
| Cookies no `HttpOnly` (`document.cookie`) | Sí, como cadena | Se pierden atributos (`domain`, `expires`, `SameSite`) |
| Cookies `HttpOnly` (`cf_clearance`, `aws-waf-token`, sesión WAF…) | **No** | Solo el proceso main de Electron las ve |
| IndexedDB / Cache Storage / Service Workers | No de forma práctica | Sin API en el guest |
| Partición de sesión de Chromium | No | Efímera por diseño |

### ¿Basta con eso para DeepSeek?

Evidencia a favor: el cliente web de DeepSeek autentica con `localStorage["userToken"]` —
`JSON.parse(localStorage.getItem("userToken")).value`, que se envía como `Authorization` en cada petición.
Es lo que hacen los clientes de terceros ([DeepSeek4Free](https://github.com/xtekky/deepseek4free)) y encaja
con las claves del snapshot real (`userToken`, `settingsJwt`, `__appKit_userInfo`).

Evidencia en contra / límite: las cookies de WAF/Cloudflare (`cf_clearance`, `aws-waf-token`) son `HttpOnly`
y **no** se pueden reponer. Perderlas no cierra la sesión, pero puede provocar un desafío de seguridad tras
reiniciar. Eso no es "pedir login otra vez", pero tampoco es transparente.

Conclusión honesta: **la restauración de almacenamiento es condición necesaria, no prueba de persistencia de
sesión**. Solo la Fase C (login real + reinicio completo) lo demuestra.

---

## 5. Opciones técnicas

| # | Opción | Sesión tras reinicio | Integración en el panel | Coste |
|---|---|---|---|---|
| **A** | Snapshot de `localStorage` + `document.cookie` en disco, restaurado antes de cargar (referencia, sin código `electron`) | Sí, si DeepSeek se conforma con `userToken` (probable) | Sí, panel central | Bajo |
| **B** | Ventana propia con perfil de navegador dedicado (`msedge/chrome --app --user-data-dir=...`) | Sí, nativa y completa (cookies `HttpOnly` incluidas) | **No**: ventana aparte | Bajo |
| **C** | A como experiencia principal + B como escape explícito ("abrir en ventana persistente") | Sí en A; garantizada en B | Sí (con escape) | Bajo-medio |
| **D** | Pedir a DSH particiones `persist:` para invitados | Depende de upstream | Sí | Nulo ahora, incierto |
| E | `iframe`, APIs privadas, IPC no documentado, leer cookies del navegador personal | — | — | **Descartadas** |

Descartes razonados: el `iframe` lo bloquea el sitio; las APIs privadas rompen en cada `rc` y el shell mata
el Host ante mensajes no reconocidos; leer el navegador personal mezcla identidades y filtra credenciales
ajenas al plugin, justo lo que el encargo prohíbe.

### Recomendación

**A, con C como red de seguridad opcional.** Es el mínimo que puede funcionar dentro de lo soportado y es
además la única variante que conserva la experiencia pedida (web oficial en el panel central). B sola
resolvería la sesión pero rompe el requisito de integración; por eso queda como escape, no como base.

Mejoras concretas sobre la referencia (todas dentro de APIs soportadas):

1. No importar `electron` en ningún punto: sin rutas de cookies, sin `BrowserWindow`, sin fallbacks muertos.
2. Guardar con más frecuencia y en más momentos (cambio de título/URL, ocultar panel, `visibilitychange`,
   `beforeunload`, y un intervalo corto) en lugar de solo cada 30 s.
3. **No degradar un snapshot con sesión**: si el estado nuevo trae `userToken` nulo pero el anterior tenía
   token, se conserva el anterior salvo "Olvidar sesión" explícito. Esto ataca directamente el fallo
   observado (snapshot sobrescrito con `value:null`).
4. Diagnóstico sin secretos: edad del snapshot, `hasUserToken: true/false`, número de claves, último
   guardado/restaurado, error de restauración. Nunca valores ni cookies.
5. Acción "Olvidar sesión" que borra el snapshot (con el panel cerrado) y recarga.

Riesgo residual que hay que declarar en el README: si DeepSeek empieza a exigir una cookie `HttpOnly` para
considerar la sesión válida, A deja de bastar y solo B (o un cambio en DSH) lo resuelve.

---

## 6. Nombre propuesto

**`dsh-chatdock`** — "el chat oficial atracado en el panel".

- Corto, pronunciable en español e inglés, describe el comportamiento (dock = acoplar al panel).
- Sin ámbito (`@usuario/...`): instalación de una línea `dsh plugin --profile desktop add dsh-chatdock`.
- Distinguible del original (`dsh-webchat`, con ámbito `@jaychang1989`) y de los ya ocupados.

Verificación realizada hoy (HTTP real, no supuesta):

| Nombre | npm | GitHub `jmolo/<nombre>` |
|---|---|---|
| `dsh-chatdock` | 404 libre | 404 libre |
| `dsh-deepseek-pane` | 404 libre | — |
| `dsh-chat-panel` | 404 libre | — |
| `dsh-deepseek-chat` | **200 ocupado** | — |
| `dsh-deepseek-web` | **200 ocupado** | — |
| `dsh-webchat` | **200 ocupado** | — |

La cuenta `github.com/jmolo` existe. Falta confirmar que ese es tu handle y que el repo se llamará igual.

Alternativas si no te convence: `dsh-deepseek-pane`, `dsh-chat-panel`.

---

## 7. Licencia y atribución

- Referencia y su ancestro (`xmuwenxiang/dsh-web-chat`): **Apache-2.0**. El `NOTICE` del original declara
  reutilización de andamiaje (doble cara, fila de bundle, forma `window.__ModuleLoader__.load`).
- Plan: escribir implementación propia; si se reutiliza cualquier fragmento o andamiaje, el proyecto será
  **Apache-2.0** con `NOTICE` que acredite a `jaychang1989/dsh-webchat` y a `xmuwenxiang/dsh-web-chat`, y el
  README dirá qué es inspiración funcional y qué es código nuevo. No se copiarán `lib/*.js` ni el bundle.

---

## 8. Catálogo `dsh-plugin.org` (requisitos actuales)

Verificado en `https://dsh-plugin.org/submit`:

- repositorio público con el topic **`dsh-plugin`** (el hub escanea el topic; no hace falta formulario),
- `package.json` en la raíz (nombre y versión) para el escaneo automático,
- README con el comando de instalación completo,
- módulo que exporte `apply(ctx)`,
- licencia declarada, captura/demo, categoría (aquí: *UI & Experience*),
- **publicar en npm** solo si se quiere aparecer además en el Plugin Hub dentro de DSH;
  sin npm el repo se indexa igual y se instala con `dsh plugin add github:<owner>/<repo>`.

Nada de esto se ha enviado.

---

## 9. Riesgos

1. **Persistencia no demostrada**: hasta la Fase C no se puede afirmar que la sesión sobreviva a un reinicio.
2. **WAF/anti-bot**: sin cookies `HttpOnly`, el sitio puede pedir verificación tras reiniciar; es aleatorio y
   depende del sitio.
3. **Cambios del sitio**: DeepSeek puede mover su token fuera de `localStorage`; el diagnóstico y la acción
   "Olvidar sesión" deben permitir detectarlo sin leer credenciales.
4. **`engines.dsh`**: fijar `^0.2.1-rc.3` (o `>=0.2.1-rc.3`) para que el instalador rechace versiones no
   probadas; DSH está en *developer preview* y rompe entre `rc`.
5. **Doble instancia**: el plugin de referencia y el nuevo no deben convivir (ids de slot y de entrada
   distintos, pero dos invitados a la vez = dos sesiones). Instalar uno, desinstalar el otro.
6. **Datos sensibles en disco**: el snapshot contiene el token; `0600`, fuera del repo, y nunca en logs.

---

## 10. Pendientes / decisiones antes de la Fase B

1. ¿Apruebas el nombre **`dsh-chatdock`** (o prefieres `dsh-deepseek-pane` / `dsh-chat-panel`)?
2. ¿Arquitectura **A** sola, o **C** con el escape "abrir en ventana persistente" desde el primer día?
3. ¿Cuál es tu handle real de GitHub y quieres el paquete sin ámbito (`dsh-chatdock`) o con ámbito
   (`@jmolo/dsh-chatdock`)?

Con esas tres respuestas, la Fase B es: repositorio nuevo en esta carpeta, implementación mínima (cara Host
con 3 rutas + cara Cliente con el panel y el guest), pruebas `node --test`, README + SECURITY + CHANGELOG, y
`plugin_manager install_bundle` en el perfil `desktop` para la Fase C.
