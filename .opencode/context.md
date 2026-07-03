# Project Context

## Goal
- SPA (Vue 3 CDN) para gestión de giras de HADADANZA con autenticación real, RBAC granular, y sincronización Google Calendar.

## Constraints & Preferences
- **Sin Vue Router** — navegación por `globalView` + `activeEventTab`
- **Sin build step** — todo inline en `public/index.html`, servido por Express
- **CDN externas**: Vue 3, Tailwind, Leaflet, jsPDF, Font Awesome, mammoth.js
- **Imágenes de contrato** (logo + firma) como base64 en `currentEvent.contract_logo` / `contract_signature`
- **Contrato**: `<div contenteditable>` en vez de `<textarea>` para preservar HTML con imágenes
- **Crew**: edición horizontal (tabla + panel derecho), CRUD via API REST
- **Técnico**: upload de PDFs rider y contra-rider con download y delete
- **Colaboradores autenticados** con email+password (no más selector de impersonación)
- **Roles y permisos**: RBAC con matriz granular de checkboxes por módulo/acción
- **Google Calendar**: OAuth 2.0 con Web application credentials, tokens cifrados AES-256-GCM

## Progress
### ✅ Done — Fases 1-5 completadas
- **Bug tabs 6-15**: cerrado `w-2/3` con `</div>` antes de `v-if hasPerm` en Contrato
- **Upload PDFs Técnico**: rider/contra-rider con upload, download, delete
- **Tareas**: función `addSingleTask` creada y expuesta
- **Contrato UI + PDF**: logo/firma base64, `generateContractPDF` con `doc.html()`
- **Import .docx**: mammoth.js integrado
- **Exportar hoja de ruta**: simple y completa multi-página
- **Crew**: horizontal (tabla + panel), CRUD API REST

#### Fase 1 — Fundación (Auth + SQLite)
- SQLite: 10 tablas (collaborators, roles, modules, module_actions, role_permissions, user_permissions, google_tokens, event_mapping, sync_queue, audit_log)
- Middleware: `requireAuth`, `requirePermission`, `getUserPermissions`, `logAudit`
- Login/logout/me con sessions HTTP-only
- Migración db.json → SQLite con backup
- Pantalla login + sidebar con usuario autenticado
- Seed: 6 roles, 20 módulos, admin por defecto

#### Fase 2 — Roles CRUD + RBAC Matrix
- 20 módulos x 6 acciones (CRUD + share + manage_permissions)
- CRUD roles + colaboradores con matriz de checkboxes
- Botones: Seleccionar todo, Solo lectura, Acceso completo, Copiar desde rol, Buscador
- Admin pasa todos los permisos automáticamente

#### Fase 3 — Google Calendar OAuth
- OAuth2 flow completo (redirect, callback, exchange code)
- Tokens cifrados AES-256-GCM en SQLite
- Calendar API v3: list, create, update, delete
- Sync engine: pull de Google, push desde app, cola de trabajo
- Widget en calendario: estado, email, conectar/sincronizar/desconectar
- `session.save()` antes de redirect + detección `?google=connected`

#### Fase 4 — Sincronización automática
- `enqueueSync(eventId, action)` en cola para usuarios conectados
- Auto-enqueue en POST/PUT/DELETE de eventos
- `performSync` exportada desde `routes/google-calendar.js`
- Cron cada 15 min (8:00-22:00) procesa `sync_queue`

#### Fase 5 — Visor de Auditoría
- `GET /api/v1/audit-log` con paginación (50 por página)
- Overlay modal en frontend (sidebar → "Auditoría" solo admin)
- Timestamp, acción, usuario, target
- Watch `showAuditLog` → carga automática

### Blocked
- **Google Calendar OAuth requiere añadir test user** en Google Cloud Console → OAuth consent screen → Test users

## Next Steps
1. Añadir test user en Google Cloud Console para desbloquear OAuth
2. (Opcional) Multi-calendario / Google Calendar por colaborador

## Critical Context
- **Server**: Express puerto 3000, `public/index.html` estático + API REST sobre `db.json` + `hadadanza.db`
- **Auth**: sessions HTTP-only, login `/api/v1/auth/login`, logout `/api/v1/auth/logout`
- **Demo**: admin@hadadanza.com / admin123
- **Google Cloud**: Client ID `1090540545557-9gaok1hq2a9j30jgv8o2le3qh18p8k7m.apps.googleusercontent.com`, Redirect URI `http://localhost:3000/api/v1/auth/google/callback`
- **Sin git, Vite, vue-router ni .vue** — todo inline CDN
- **Tabs 6-15 corregido** — si se ven vacíos, Ctrl+F5

## Relevant Files
- `C:\Users\M0M0\Desktop\App2\public\index.html` — app completa (Vue 3 inline)
- `C:\Users\M0M0\Desktop\App2\server.js` — Express + sessions + auth + Google Calendar + auto-sync cron
- `C:\Users\M0M0\Desktop\App2\db\sqlite.js` — esquema SQLite + seed
- `C:\Users\M0M0\Desktop\App2\middleware\auth.js` — requireAuth, requirePermission
- `C:\Users\M0M0\Desktop\App2\middleware\audit.js` — logAudit, audit middleware
- `C:\Users\M0M0\Desktop\App2\routes\auth.js` — login, logout, me
- `C:\Users\M0M0\Desktop\App2\routes\roles.js` — CRUD roles + permisos
- `C:\Users\M0M0\Desktop\App2\routes\collaborators.js` — CRUD colaboradores + permisos override
- `C:\Users\M0M0\Desktop\App2\routes\modules.js` — catálogo de módulos
- `C:\Users\M0M0\Desktop\App2\routes\google-calendar.js` — OAuth + sync endpoints (exporta performSync)
- `C:\Users\M0M0\Desktop\App2\services\google-calendar.js` — OAuth2 client, Calendar API, sync engine
- `C:\Users\M0M0\Desktop\App2\config.js` — loader de .env
- `C:\Users\M0M0\Desktop\App2\.env` — credenciales Google + secrets
- `C:\Users\M0M0\Desktop\App2\db.json` — base de datos JSON (artistas, eventos, crew)
- `C:\Users\M0M0\Desktop\App2\hadadanza.db` — SQLite (auth, permisos, tokens, logs)
- `C:\Users\M0M0\Desktop\App2\start-hadadanza.bat` — script de arranque
