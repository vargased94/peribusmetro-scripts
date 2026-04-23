# Plan de migración — peribus-scripts

Repositorio centralizado para scripts de automatización, ETL y backups del ecosistema Peribus. Los workflows de GitHub Actions viven aquí y consumen minutos de la cuenta donde ya hay plan de pago.

---

## 1. Objetivo

Sacar los scripts y workflows que hoy viven acoplados a `peribus-incidents-admin` (Next.js) y llevarlos a un repo dedicado con tres beneficios:

1. **Minutos de Actions** consumidos en la cuenta de pago, no en la del repo de la app.
2. **Responsabilidad única**: este repo no tiene UI, es solo automatización.
3. **Migración gradual con validación en DEV** antes de apagar los workflows originales.

---

## 2. Alcance de la migración

### Workflows a migrar (en orden de prioridad)

| # | Workflow origen | Frecuencia actual | Prioridad |
|---|---|---|---|
| 1 | `backup-prod-to-dev.yml` | Diario 02:00 AM CST | Alta |
| 2 | `comercial-sync-daily-prod.yml` | Diario 05:00 AM CST | Alta |
| 3 | `odometers-daily-prod.yml` | Diario 04:00 AM CST | Media (posterior) |
| 4 | `odometers-daily-dev.yml` | Diario | Media (posterior) |
| 5 | `odometers-monthly-prod.yml` | Mensual | Baja (posterior) |
| 6 | `odometers-monthly-dev.yml` | Mensual | Baja (posterior) |
| 7 | `preventive-maintenance-daily-dev.yml` | Diario | Baja (posterior) |

Foco de esta primera fase: **#1 y #2** (backup + comercial). El resto se migra en fases siguientes para no saturar.

### Scripts a traer al repo

Ligados a los workflows #1 y #2:

- `scripts/backup-prod-to-dev.sh` — copia tal cual (shell puro, sin dependencias del proyecto Next).
- `scripts/sync-incremental.mjs` — copia tal cual (usa `mssql`, `postgres`, `dotenv` — todas deps estándar).
- `scripts/sync-update-extra-fields.mjs` — copia tal cual (mismas deps).
- `scripts/comercial-auto-link.mjs` — **se reescribe** (hoy es `.ts` con imports a `@/features/...` y Drizzle). La lógica real son 5 queries SQL que se migran a `sql.unsafe(...)` de la lib `postgres`. El comportamiento se mantiene 1:1.

### Lo que NO se migra (se queda en `peribus-incidents-admin`)

- Todos los workflows no listados arriba (CI, drift check, etc.).
- Scripts utilitarios del proyecto Next que usan Drizzle a fondo (`fix-comercial-sequences.ts`, `comercial-diagnostico.ts`, etc.) — esos viven con su código.
- Los `.sql` y `lib/db/schemas/` — son del proyecto Next.

---

## 3. Estructura del repo

```
peribus-scripts/
├── README.md                                # Overview del repo y cómo usarlo
├── PLAN.md                                  # Este archivo
├── package.json                             # deps: mssql, postgres, dotenv
├── .gitignore                               # .env*, backups/, node_modules, *.dump, *.csv.gz
├── docs/
│   ├── SECRETS.md                           # Secrets requeridos y para qué sirve cada uno
│   ├── RUNBOOK.md                           # Cómo correr manualmente cada script, troubleshooting
│   └── MIGRATION.md                         # Checklist de migración desde peribus-incidents-admin
├── scripts/
│   ├── backup-prod-to-dev.sh                # Copia literal del actual
│   ├── sync-incremental.mjs                 # Copia literal del actual
│   ├── sync-update-extra-fields.mjs         # Copia literal del actual
│   └── comercial-auto-link.mjs              # Reescrito sin Drizzle
└── .github/
    └── workflows/
        ├── backup-prod-to-dev.yml           # Copia adaptada (sin schedule al inicio)
        ├── comercial-sync-daily-dev.yml     # Nuevo — para validar contra DEV
        └── comercial-sync-daily-prod.yml    # Copia adaptada (sin schedule al inicio)
```

---

## 4. Secrets requeridos en el repo nuevo

Todos se configuran en **Settings → Secrets and variables → Actions → Repository secrets** (o en Environments si quieres separar dev/prod).

### Compartidos

| Secret | Valor actual (referencia) | Usado por |
|---|---|---|
| `RESEND_API_KEY` | Mismo que el repo actual | Ambos workflows |
| `BACKUP_NOTIFY_EMAILS` | Lista de emails separados por coma | Ambos workflows |

### Base de datos (Supabase)

| Secret | Qué contiene | Usado por |
|---|---|---|
| `DATABASE_URL_PROD` | URL directa de Postgres PROD (sin pooler) | `backup-prod-to-dev.yml` (pg_dump) |
| `DATABASE_URL_DEV` | URL directa de Postgres DEV | `backup-prod-to-dev.yml` (pg_restore) |
| `DATABASE_POOLER_URL` | URL del pooler PROD (puerto 6543) | `comercial-sync-daily-prod.yml` (los scripts Node usan pooler) |
| `DATABASE_POOLER_URL_DEV` | URL del pooler DEV (puerto 6543) | `comercial-sync-daily-dev.yml` (solo fase de pruebas) |

### SQL Server (AdminPAQ)

| Secret | Qué contiene | Usado por |
|---|---|---|
| `SQL_SERVER_HOST` | Host/IP de SQL Server | `comercial-sync-*.yml` |
| `SQL_SERVER_PORT` | Puerto (usualmente 1433) | `comercial-sync-*.yml` |
| `SQL_SERVER_USER` | Usuario de SQL Server | `comercial-sync-*.yml` |
| `SQL_SERVER_PASSWORD` | Password | `comercial-sync-*.yml` |

### Total

- **9 secrets** en total (ninguno nuevo: todos ya existen en `peribus-incidents-admin`, solo hay que copiar los valores).

---

## 5. Fases de migración

### Fase 0 — Setup del repo (ANTES de tocar GitHub)

- [ ] Revisar y aprobar este plan.
- [ ] Crear estructura de carpetas local (ya hecho con `PLAN.md`).
- [ ] Poblar `package.json` con deps mínimas.
- [ ] Copiar scripts portables (backup, sync-incremental, sync-update-extra-fields).
- [ ] Reescribir `comercial-auto-link.mjs`.
- [ ] Crear los 3 workflows (`.yml`) con **solo `workflow_dispatch`** (sin `schedule:`). Esto es clave: nada corre automático hasta validar.
- [ ] Crear `README.md`, `docs/SECRETS.md`, `docs/RUNBOOK.md`, `docs/MIGRATION.md`.
- [ ] `.gitignore`.

### Fase 1 — Crear repo remoto y subir

- [ ] Crear repo `peribus-scripts` en la cuenta de pago (privado).
- [ ] `git init && git add . && git commit && git remote add origin ... && git push`.
- [ ] Configurar los 9 secrets en Settings → Actions secrets.

### Fase 2 — Validación en DEV

- [ ] Ejecutar `comercial-sync-daily-dev` manualmente (`workflow_dispatch`).
- [ ] Comparar output (JSON summary + email) contra una corrida reciente del workflow actual en `peribus-incidents-admin`.
- [ ] Revisar tabla `comercial_adm_movements`, `comercial_adm_documents`, `comercial_document_links`, `comercial_movement_unit_links` en DEV: ¿cambió algo inesperado?
- [ ] Ejecutar `backup-prod-to-dev` manualmente con el input `skip_restore=true` primero (solo genera artefacto). Verificar tamaño razonable.
- [ ] Ejecutar `backup-prod-to-dev` completo y verificar que DEV quedó consistente.

### Fase 3 — Activar en PROD (manual primero)

- [ ] Ejecutar `comercial-sync-daily-prod` manualmente. Verificar email de éxito.
- [ ] Ejecutar 3-5 días seguidos a mano para ganar confianza.

### Fase 4 — Activar crons

- [ ] Agregar `schedule:` al `backup-prod-to-dev.yml`. Commit + push.
- [ ] Agregar `schedule:` al `comercial-sync-daily-prod.yml`. Commit + push.
- [ ] **Los workflows viejos en `peribus-incidents-admin` siguen corriendo** — ambiente de doble ejecución durante 2-3 días.
- [ ] Los scripts son idempotentes: ejecutar dos veces en el mismo día no duplica datos ni rompe nada (el sync compara IDs antes de insertar; el auto-link usa `NOT EXISTS`).

### Fase 5 — Apagar los workflows viejos

- [ ] En `peribus-incidents-admin`, renombrar `backup-prod-to-dev.yml` → `backup-prod-to-dev.yml.disabled` (o borrar directo con commit).
- [ ] Mismo con `comercial-sync-daily-prod.yml`.
- [ ] Verificar durante una semana que solo los nuevos se están ejecutando.
- [ ] Borrar el secret `DATABASE_POOLER_URL_DEV` del repo nuevo si ya no se va a usar (solo sirvió en Fase 2).

### Fase 6 — Migrar los workflows restantes

- [ ] Repetir el ciclo (Fase 2 a 5) con `odometers-daily-prod.yml` y el resto. Cada uno en su PR.

---

## 6. Riesgos y cómo se mitigan

| Riesgo | Mitigación |
|---|---|
| Los scripts reescritos (`comercial-auto-link.mjs`) cambien comportamiento | Se mantiene el mismo SQL literal; solo cambia la librería (`postgres` en lugar de Drizzle). Se valida en DEV antes de PROD. |
| Doble ejecución rompa algo durante la transición | Scripts son idempotentes por diseño. Comprobado antes de Fase 4. |
| Pérdida de notificaciones por mal copy-paste de secrets | Checklist explícito en `docs/SECRETS.md`. Primera corrida manual para ver si llega el email. |
| El `backup-prod-to-dev.sh` tiene un `read -p` interactivo que rompe en CI | El workflow ya no usa el `.sh` directo, llama los comandos `pg_dump/pg_restore` inline (igual que hoy). El `.sh` se trae solo como referencia local. |
| Conflicto si alguien vuelve a correr el workflow viejo manualmente | Una vez deshabilitados (Fase 5), no hay cómo. |

---

## 7. Criterios de éxito

- Dos corridas consecutivas en PROD (backup + comercial-sync) terminan con email de éxito y resumen idéntico al que generaba el workflow original.
- `comercial_document_links` y `comercial_movement_unit_links` no tienen registros duplicados tras la doble ejecución de Fase 4.
- `peribus-incidents-admin` no tiene workflows activos de backup/comercial una vez terminada Fase 5.
- Billing de Actions en la cuenta destino muestra consumo; el origen baja a casi 0.

---

## 8. Entregables de esta primera sesión

1. Este `PLAN.md` ✅
2. `README.md` del repo
3. `docs/SECRETS.md` con tabla detallada
4. `docs/RUNBOOK.md` con comandos locales para probar cada script
5. `docs/MIGRATION.md` con checklist paso a paso de la Fase 2 y 3
6. `package.json` con las deps
7. `.gitignore`
8. Scripts portables copiados y `comercial-auto-link.mjs` reescrito
9. Los 3 workflows YAML (sin `schedule:` — solo `workflow_dispatch`)

**NO se hace en esta sesión** (requiere tu acción):
- Crear el repo en GitHub.
- Configurar los secrets.
- Ejecutar los workflows.
