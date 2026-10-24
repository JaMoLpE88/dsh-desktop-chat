# Arquitectura

## Piezas

| Pieza | Dónde corre | Responsabilidad |
|---|---|---|
| `lib/index.js` (cara Host) | Proceso Host de DSH (Electron en modo Node) | Rutas `/api/dsh-desktop-chat/*`, snapshot en disco, diagnóstico |
| `lib/client.js` (cara Cliente) | Renderer de la Web UI de DSH | Fila lateral, panel central, invitado `<webview>`, lectura/escritura del estado de la página |
| `cordis.patch.yml` | Carga del perfil | Inserta la fila `desktop-chat` en el perfil `desktop` |

Las dos caras se comunican por HTTP en el mismo servidor local de DSH (el mismo al que sirve la GUI), con la
cabecera `x-dsh-desktop-chat: 1` como marca; no hay IPC nuevo ni canal privilegiado.

## Flujo

```
arranque
  └─ client: bridge.acquire('dsh-desktop-chat')  ──► { lease, partition }   (efímera)
  └─ client: POST /session/restore              ──► { storage, cookie }
  └─ webview src=about:blank#<lease>
       └─ dom-ready → loadURL(https://chat.deepseek.com/)
            └─ did-finish-load (origen correcto)
                 ├─ escribe storage + document.cookie
                 ├─ reload()  ──► la página arranca ya autenticada
                 └─ did-finish-load
                      └─ guarda cada 10 s y al ocultar el panel
```

## Por qué no hay cookies `HttpOnly`

Comprobado sobre `app.asar` de DSH Desktop `0.2.1-rc.3`:

1. El Host de plugins es un hijo del ejecutable de Electron lanzado con `ELECTRON_RUN_AS_NODE=1`
   (`lib/main.js:3649-3658`, `3793-3811`). En ese modo el módulo `electron` no existe, de ahí
   `Cannot find module 'electron'`.
2. El IPC Host→shell es un conjunto cerrado y validado (`lib/main.js:3664-3701`); un mensaje desconocido
   termina el Host. No hay canal de cookies.
3. Las particiones de invitado son `dsh-sidebar-browser-<uuid>` sin `persist:`, nuevas en cada arranque
   (`lib/main.js:10495-10513`); el `will-attach-webview` impone esa partición y borra las preferencias
   restantes (`10543-10568`).
4. El paquete oficial `@deepseek-ai/dsh-client-ui-sidebar-browser` lo documenta: *"Cookies and Web storage do
   not survive application restart."*
5. La única partición `persist:` del shell es la de la vista de cuenta (`lib/main.js:6806`), limitada a
   `usage`/`top_up` del origen de la cuenta.
6. Lo que el renderer recibe es `dshDesktop.browser.{acquire,release,onOpenRequested}` más utilidades
   (`lib/preload-app.cjs:757-843`). Nada de sesión.

Conclusión: la persistencia posible es la que la propia página puede leer y escribir. DeepSeek guarda su
token en `localStorage["userToken"]`, que sí está a nuestro alcance.

## Decisiones

- **Sin `electron`, sin `BrowserWindow`, sin ventanas externas.** No funcionan en el Host de Desktop y
  añadirían rutas muertas. El panel muestra un mensaje si no hay puente nativo (perfil web).
- **Invitado fuera del árbol de React.** Un `<webview>` se destruye al salir del documento; mantenerlo en un
  contenedor propio en `document.body` permite ocultar el panel sin recargar.
- **Snapshot que una página desconectada no puede degradar.** Si el snapshot guardado tiene token y el nuevo
  estado no, no se escribe, salvo que la página informe de un cierre de sesión explícito (`cleared`). Es la
  guarda que evita el fallo clásico "se guardó el estado desconectado y se perdió la sesión".
- **Diagnóstico sin secretos.** La ruta `/state` publica recuentos y `hasUserToken`, nunca valores.
- **Sin beacon en `beforeunload`.** No hay nada que capturar en el Host al cerrar (no hay cookies de
  proceso), así que el último guardado es el del intervalo o el de ocultar el panel.

## Rutas

| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| GET | `/api/dsh-desktop-chat/state` | — | recuentos, `hasUserToken`, último guardado/restaurado |
| POST | `/api/dsh-desktop-chat/session/restore` | `{}` | `{ storage, cookie, savedAt, hasUserToken }` |
| POST | `/api/dsh-desktop-chat/session/save` | `{ storage, cookie, cleared? }` | `{ saved, kept, session }` |
| POST | `/api/dsh-desktop-chat/session/forget` | `{}` | `{ deleted, session }` |

Todas exigen la cabecera `x-dsh-desktop-chat: 1`; sin ella responden 403.

## Snapshot

```json
{
  "version": 1,
  "savedAt": "2026-10-25T09:12:44.120Z",
  "storage": [["userToken", "{\"value\":\"…\",\"__version\":1}"]],
  "cookie": "smidV2=…; HWWAFSESID=…"
}
```

Ruta: `<DSH_HOME o ~/.dsh>/dsh-desktop-chat/session.json`, escritura atómica (`tmp` + rename), modo `0600`,
directorio `0700` cuando se crea.

## Límites conocidos

- Si DeepSeek pasa a exigir una cookie `HttpOnly` para validar la sesión, este diseño deja de bastar.
- El sitio puede pedir verificación anti-bot tras perder su cookie de WAF.
- El panel no ofrece navegación propia (atrás/adelante/recargar) salvo la de la página; F5/Ctrl+R no se
  interceptan.
- No hay botón de "olvidar sesión" en la interfaz: se usa la ruta documentada en el README o el cierre de
  sesión en la propia web.
