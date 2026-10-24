# Changelog

Todas las versiones notables de este proyecto se documentan aquí. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el versionado es
[SemVer](https://semver.org/lang/es/).

## [0.1.0] — 2026-10-25

### Añadido

- Panel «Chat DeepSeek» en la barra lateral que muestra `https://chat.deepseek.com/` en el panel central
  mediante el invitado nativo de DSH Desktop.
- Persistencia de la página entre reinicios: snapshot de `localStorage` y `document.cookie` en
  `~/.dsh/dsh-desktop-chat/session.json`, restaurado antes de la primera navegación útil.
- Invitado persistente entre cambios de panel: ocultar el panel no destruye ni recarga la página.
- Guarda anti-degradación: un guardado sin sesión no sobrescribe un snapshot que sí la tenía; un cierre de
  sesión explícito sí lo limpia.
- Rutas de diagnóstico y mantenimiento: `state`, `session/restore`, `session/save`, `session/forget`,
  protegidas por cabecera y sin exponer credenciales.
- Pruebas `node --test` para ambas caras (19 casos).

### Corregido (antes de publicar)

- El guardado se congelaba tras iniciar sesión: la web navega dentro de la SPA y no dispara
  `did-finish-load`, así que el invitado quedaba marcado como «no listo» y solo se guardaba el estado
  anterior al login. Ahora `did-stop-loading` y `did-navigate-in-page` rearman el guardado.
- Los intentos descartados ya no son silenciosos: se envían como `{ skip, diag }` y `/state` muestra el
  motivo y los contadores.

### Limitaciones conocidas

- Las cookies `HttpOnly` (WAF/Cloudflare) no se persisten: el shell no las expone a plugins y el Host no
  puede importar `electron`.
- La persistencia de sesión tras reinicio está pendiente de validación manual en DSH Desktop.
- Sin botón de «olvidar sesión» en la interfaz; se usa la ruta documentada o el cierre de sesión en la web.
