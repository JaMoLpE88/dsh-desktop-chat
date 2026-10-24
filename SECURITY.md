# Seguridad

## Qué guarda el plugin

Un único fichero: `<DSH_HOME o ~/.dsh>/dsh-desktop-chat/session.json`, con:

- pares de `localStorage` de `https://chat.deepseek.com` (incluye `userToken`, el token de sesión),
- la cadena `document.cookie` de ese mismo origen (cookies no `HttpOnly`).

Se escribe de forma atómica (`session.json.tmp` + rename), con modo `0600` y directorio `0700` al crearse.
Nunca sale del equipo, no se registra en logs y no se envía por red salvo a la propia página de DeepSeek.

## Qué **no** hace

- No lee ni copia cookies, sesiones ni perfiles de tu navegador personal.
- No guarda contraseñas ni el contenido de las conversaciones.
- No desactiva protecciones del navegador: la vista usa la partición aislada que impone DSH, con
  `sandbox`, `contextIsolation`, permisos denegados y descargas bloqueadas por el shell.
- No ejecuta código de la web fuera de la propia web: `executeJavaScript` solo se usa en el invitado, y
  siempre comprobando antes que el origen es `https://chat.deepseek.com`.
- No expone credenciales en las rutas de diagnóstico.

## Superficie local

Cuatro rutas HTTP en el servidor local de DSH (solo `127.0.0.1`):

| Ruta | Riesgo | Mitigación |
|---|---|---|
| `GET /state` | informa si hay sesión guardada | solo recuentos y booleanos; requiere cabecera |
| `POST /session/restore` | **devuelve el token** a quien la llame | requiere la cabecera `x-dsh-desktop-chat: 1`, que una web externa no puede añadir sin preflight CORS (denegado), y la respuesta no lleva CORS |
| `POST /session/save` | podría sobrescribir el snapshot | valida el cuerpo, exige la cabecera y no degrada un snapshot con sesión |
| `POST /session/forget` | borra el snapshot | exige la cabecera; el efecto es un cierre de sesión, no una fuga |

Cualquier proceso local con los mismos permisos de usuario puede leer el fichero directamente; eso es
inherente a guardar una sesión en disco y es el mismo modelo que usa DSH para sus propias credenciales.
Si eso no encaja con tu modelo de amenaza, no instales el plugin.

## Revocar

- Cierra sesión en la web: el plugin detecta la pantalla de acceso y limpia el snapshot.
- O borra `~/.dsh/dsh-desktop-chat/session.json` con DSH cerrado.
- O `POST /api/dsh-desktop-chat/session/forget` con la cabecera.

Tras revocar, el token deja de estar en disco; el servidor de DeepSeek puede tardar en invalidarlo, así que
si te preocupa, cambia también la contraseña o cierra la sesión desde la web de DeepSeek.

## Informar de un problema

Abre un issue en <https://github.com/JaMoLpE88/dsh-desktop-chat/issues> **sin adjuntar**
`session.json`, cookies, tokens ni capturas con datos de cuenta. El diagnóstico (`/state`) es seguro de
compartir: no contiene valores.
