# ALFRED API v2

Incluye:
- listado de todas las keys: GET /api/licenses (admin)
- bloquear/desbloquear: POST /api/licenses/:key/block
- resetear vínculo de dispositivo: POST /api/licenses/:key/reset-device
- eliminar: DELETE /api/licenses/:key
- vinculación a un solo dispositivo: deviceHash
- creación 1, 7, 15 y 30 días desde el panel
- panel web de administración

## Render
Build: npm install
Start: npm start
Variable:
ADMIN_TOKEN = tu token secreto

## Panel
El servidor sirve:
https://TU-SERVICIO.onrender.com/panel

## Importante
Para una IPA nativa, el deviceId debe ser un identificador estable guardado en
Keychain. Un ID creado con localStorage sirve para una web/demo, pero puede
cambiar al borrar los datos o reinstalar.
