# dsh-desktop-chat

Abre la web oficial de **DeepSeek Chat** (`chat.deepseek.com`) dentro de **DeepSeek Harness Desktop**, en el
panel central, a través del navegador nativo integrado del escritorio. Una entrada en la barra lateral, la
página real, y la sesión no se pierde al cerrar la aplicación.

**English** → [README.md](README.md)

## Qué hace

- Añade una entrada «Chat DeepSeek» a la barra lateral de DSH Desktop.
- Muestra `https://chat.deepseek.com/` en el panel central, con su interfaz oficial intacta.
- Repone la sesión al arrancar, para no tener que iniciar sesión cada vez que abres DSH.
- Mantiene la página viva al cambiar de panel: ocultar y volver no recarga ni cierra la sesión.
- Ofrece diagnóstico (`/api/dsh-desktop-chat/state`) y una ruta para olvidar la sesión guardada.

## Qué no hace

- No reimplementa el chat ni sustituye la web oficial por una interfaz propia.
- No convierte DeepSeek en un proveedor de modelo, agente o herramienta de automatización.
- No toca modelos, agentes, plugins ni proveedores de DSH.
- No guarda contraseñas, ni lee el perfil de tu navegador personal, ni envía credenciales a ningún sitio.
- No puede conservar cookies `HttpOnly`: DSH no expone a los plugins el almacén de cookies de la vista.

## Requisitos

- **DSH Desktop** `>= 0.2.1-rc.3`, perfil `desktop` (el perfil web no ofrece navegador integrado).
- Windows 11 (probado), macOS/Linux sin probar.
- Sin dependencias en tiempo de ejecución; no hace falta Node instalado aparte.

## Instalación

Con el paquete publicado en npm:

```bash
dsh plugin --profile desktop add @jamolpe88/dsh-desktop-chat
```

Desde el repositorio:

```bash
dsh plugin --profile desktop add github:JaMoLpE88/dsh-desktop-chat
```

Durante el desarrollo, con el paquete en local:

```bash
dsh plugin --profile desktop add C:\ruta\a\dsh-desktop-chat
```

Después de instalar, **reinicia DSH Desktop**. La entrada aparece en la barra lateral como
«Chat DeepSeek».

## Uso

1. Pulsa «Chat DeepSeek» en la barra lateral: la página se carga en el panel central.
2. Inicia sesión una vez, a mano, en la propia web.
3. Vuelve a entrar cuando quieras (ocultar y mostrar el panel no recarga la página ni cierra la sesión).
4. Al reiniciar DSH, el plugin repone el estado de la página antes de mostrarla: deberías seguir dentro.

Si tras reiniciar aparece la pantalla de acceso, no vuelvas a iniciar sesión sin antes revisar el
diagnóstico (abajo): puede que el snapshot no se esté guardando y conviene saber por qué.

## Qué persiste y qué no

DSH Desktop entrega a cada vista de navegador una **partición de sesión que vive solo en memoria** (nombre
aleatorio nuevo en cada arranque). No es configurable desde un plugin y no hay API pública para leer sus
cookies. Por eso la sesión se conserva a nivel de página:

| Dato | ¿Se conserva? | Dónde |
|---|---|---|
| `localStorage` de `chat.deepseek.com` (incluye `userToken`) | Sí | `%USERPROFILE%\.dsh\dsh-desktop-chat\session.json` (o `$DSH_HOME`) |
| Cookies visibles por la página (`document.cookie`) | Sí | mismo fichero |
| Cookies `HttpOnly` (WAF/Cloudflare: `cf_clearance`, `aws-waf-token`…) | **No** | inalcanzables desde un plugin en este DSH |
| Contraseñas | Nunca | — |

Consecuencia honesta: DeepSeek autentica con el token de `localStorage`, así que la sesión debería
sobrevivir. Perder las cookies de WAF puede provocar una verificación anti-bot tras reiniciar; eso depende
del sitio, no del plugin.

## Diagnóstico

Con DSH abierto, en la misma URL de la interfaz (por ejemplo `http://127.0.0.1:59863`):

```bash
curl -H "x-dsh-desktop-chat: 1" http://127.0.0.1:59863/api/dsh-desktop-chat/state
```

Devuelve solo recuentos y booleanos, nunca credenciales:

```json
{
  "ok": true,
  "panelId": "deepseek-chat",
  "url": "https://chat.deepseek.com/",
  "session": {
    "file": "C:\\Users\\<usuario>\\.dsh\\dsh-desktop-chat\\session.json",
    "exists": true,
    "savedAt": "2026-10-25T09:12:44.120Z",
    "hasUserToken": true,
    "storageKeys": 24,
    "cookieBytes": 275
  },
  "last": { "restore": { "...": "..." }, "save": { "...": "..." } }
}
```

`hasUserToken` es la señal que importa: si es `false` después de iniciar sesión, el guardado no está
llegando y la sesión no puede sobrevivir.

### Olvidar la sesión

Cierra la pestaña/panel, y con DSH abierto:

```bash
curl -X POST -H "x-dsh-desktop-chat: 1" http://127.0.0.1:59863/api/dsh-desktop-chat/session/forget
```

Borra el snapshot. En el siguiente arranque la página pedirá acceso de nuevo. Si cierras sesión en la propia
web, el plugin lo detecta y también limpia el snapshot.

También puedes borrar a mano `~/.dsh/dsh-desktop-chat/session.json` con DSH cerrado.

## Cómo funciona

- **Cara Host** (`lib/index.js`, proceso Host de DSH): registra cuatro rutas en `ctx.webServer`, guarda el
  snapshot de forma atómica y con permisos de usuario, y nunca importa `electron`. Detalle y evidencia en
  [docs/architecture.md](docs/architecture.md).
- **Cara Cliente** (`lib/client.js`): registra la fila de la barra lateral (`sidebar.panellist`) y el panel
  (`main`) con el mismo id, reserva un invitado nativo, y mantiene el `<webview>` fuera del árbol de React
  para que ocultar el panel no lo destruya.
- **Restauración**: al cargar el origen, escribe `localStorage` y `document.cookie`, recarga una vez y a
  partir de ahí guarda cada 10 s y al ocultar el panel.
- **Guardas**: un guardado con la sesión vacía no puede machacar un snapshot que sí la tenía; un cierre de
  sesión explícito sí lo limpia.

## Compatibilidad

| | |
|---|---|
| DSH | `>= 0.2.1-rc.3` (única versión probada por el autor) |
| Node | `>= 22` |
| SO | Windows 11 (probado); macOS y Linux sin probar |
| Perfil | `desktop` (el perfil web no tiene invitado nativo) |
| `@jaychang1989/dsh-webchat` | no lo necesita; no conviene tener ambos instalados |

Estado de validación: **probado en Windows 11 con DSH Desktop 0.2.1-rc.3** (2026-10-25). Inicio de sesión
manual en el panel, cierre completo de DSH, reapertura y la sesión seguía activa: en el nuevo arranque el
plugin repuso 27 claves —token incluido— antes de cargar la página, que entró sin pedir credenciales.
Ocultar y volver a mostrar el panel conserva la misma página (el invitado no se desmonta).

No validado: macOS, Linux, otras versiones de DSH, y el comportamiento si DeepSeek empieza a exigir cookies
`HttpOnly`.

## Desarrollo

```bash
node --test
```

Las pruebas cubren la cara Host (rutas, snapshot, guardas, diagnóstico sin secretos) y la cara Cliente
(registro de slots, reserva del invitado, restauración, ocultación sin desmontaje) con un DOM simulado.

## Atribución y licencia

Implementación propia, inspirada en [jaychang1989/dsh-webchat](https://github.com/jaychang1989/dsh-webchat)
y en su predecesor [xmuwenxiang/dsh-web-chat](https://github.com/xmuwenxiang/dsh-web-chat), ambos
Apache-2.0. Detalle de qué se reutilizó (conceptos, no código) en [NOTICE](NOTICE).

[Apache-2.0](LICENSE).
