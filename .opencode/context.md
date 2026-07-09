# Project Context - Sesión guardada

## Estado actual (9 Julio 2026)

### Cambios realizados en esta sesión:

1. **Plantillas como archivos DOC/PDF**
   - Editor modal: upload de archivo en vez de textarea HTML
   - Servidor extrae contenido (mammoth para DOCX, pdf-parse para PDF)
   - Archivo original guardado como BLOB en SQLite
   - Endpoint GET /:id/file para descargar archivo original
   - Cards con icono según tipo (PDF rojo, DOCX azul)

2. **Fix Railway build**
   - `better-sqlite3` downgraded a `11.7.0` (compatible Node 18)
   - `node-cron` downgraded a `3.0.3`
   - `pdf-parse` downgraded a `1.1.1`
   - `railway.json` configurado con nixpacks y Node 20

3. **Botón "Nuevo colaborador"**
   - Botón en vista Colaboradores (solo admin)
   - Modal con: nombre, email, contraseña, rol
   - Llama a `POST /api/v1/collaborators`

### Variables de entorno necesarias en Railway:
| Variable | Valor |
|----------|-------|
| `SESSION_SECRET` | Del .env local |
| `ENCRYPTION_KEY` | Del .env local |
| `GOOGLE_CLIENT_ID` | `1090540545557-9gaok1hq2a9j30jgv8o2le3qh18p8k7m.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Del .env local |
| `NODE_VERSION` | `20` |

### Google Cloud Console - Redirect URIs:
```
https://[DOMINIO-RAILWAY].up.railway.app/api/v1/auth/google/callback
```

### Archivos modificados:
- `package.json` — dependencias downgrade
- `railway.json` — config nixpacks + Node 20
- `public/index.html` — editor plantillas + modal nuevo colaborador
- `routes/templates.js` — multipart CRUD + extracción archivos
- (Sin cambios en db/sqlite.js — better-sqlite3 compatible)

### Pendiente:
- Subir a GitHub
- Conectar Railway
- Poner variables de entorno
- Actualizar Google Cloud Console con URL de Railway
- Verificar login con Google

