# Sync Tank Monitoring

Sincroniza lecturas del API Tothem (sitio 130 — monitoreo) hacia la tabla
`diesel_tank_monitoring` en Supabase. Esa tabla alimenta la gráfica
**Nivel del Tanque** del reporte `/dashboard/reports/diesel-inventory` en
`peribus-incidents-admin`.

## Por qué existe

- El API Tothem expone `GET /sitio/130/monitoreo?fecha_inicial=...&fecha_final=...`
  con lecturas cada ~10 minutos por tanque (volumen, volumen compensado,
  altura, temperatura, agua).
- Hasta abril 2026 había un job externo que llenaba `diesel_tank_monitoring`,
  pero dejó de correr el 26-feb-2026. Este script lo reemplaza.

## Archivos

- Script: `scripts/sync-tank-monitoring.mjs`
- Workflow PROD (cron 5 AM MX + manual sin inputs, modo auto): `.github/workflows/sync-tank-monitoring-prod.yml`
- Workflow DEV (manual sin inputs, modo auto): `.github/workflows/sync-tank-monitoring-dev.yml`
- Workflow PROD backfill (manual con inputs `from`/`to`): `.github/workflows/sync-tank-monitoring-backfill-prod.yml`
- Workflow DEV backfill (manual con inputs `from`/`to`): `.github/workflows/sync-tank-monitoring-backfill-dev.yml`

## Comportamiento

### Modo automático (default, sin args)

1. Lee `MAX(date) FROM diesel_tank_monitoring WHERE active = 1`.
2. Calcula `from = ultima_fecha + 1 día` y `to = ayer` (zona `America/Mexico_City`).
3. Procesa todos los días pendientes en una sola corrida.
4. Si ya está al día (`from > to`) imprime "Nada que sincronizar" y termina success.
5. Si la tabla está **vacía**, hace fallback a procesar solo "ayer" y deja un
   warning pidiendo backfill manual (no se quiere disparar un backfill de
   meses sin que el operador lo apruebe).

Esto significa que si el cron diario falla un día, al siguiente run tapa el
hueco automáticamente sin intervención.

### Modo manual

- `--from YYYY-MM-DD` y/o `--to YYYY-MM-DD` → cubre el rango exacto que pidas.
- Si solo pasas uno, el otro toma el mismo valor (un solo día).

### Eficiencia

- **Concurrencia controlada:** máximo 3 fetches simultáneos al API Tothem
  (configurable con `SYNC_TANKS_CONCURRENCY`). Evita saturar.
- **Reintentos con backoff:** 3 intentos en errores 5xx/429/red, con espera
  exponencial 1s → 2s → 4s.
- **Login compartido:** un solo login al inicio, reuso del token; refresh
  automático si el API devuelve 401.
- **Inserts en chunks** de 500 filas máximo por query.
- **Idempotente:** `INSERT ... ON CONFLICT (date, hour, tank_number) DO NOTHING`.
- Convierte `hora` del API (`HHmmss`) a `HH:MM` para casar con el `varchar(5)`
  de la columna `hour`.
- Imprime una línea `::SUMMARY_JSON::{...}` que el workflow consume para el
  email de notificación y el summary de GitHub.

### Warnings que pueden aparecer en el SUMMARY

- `"La tabla diesel_tank_monitoring está vacía..."` — primera corrida o tabla
  truncada. Hay que disparar el backfill manual.
- `"Procesando N días en una sola corrida (>7)..."` — el cron no corrió por
  varios días. La sincronización tapa el hueco igual; el warning es informativo.

## Ejecución local

```bash
# Modo auto (desde última fecha en BD hasta ayer)
npm run sync:tanks:dev

# Backfill manual
DOTENV_CONFIG_PATH=.env.development \
  node --env-file=.env.development \
  scripts/sync-tank-monitoring.mjs --from 2026-02-27 --to 2026-04-27
```

`.env.development` necesita `DATABASE_POOLER_URL`, `TOTHEM_HOST`,
`TOTHEM_API_USUARIO`, `TOTHEM_API_KEY`. Plantilla en `.env.example`.

Variables opcionales:
- `SYNC_TANKS_CONCURRENCY` (default 3) — fetches simultáneos al API.
- `TOTHEM_SITIO` (default 130).

## Ejecución en GitHub Actions

Hay **dos workflows por ambiente** con propósitos distintos:

### Modo auto (uso normal)

- **PROD diario:** corre solo a las 11:00 UTC (5:00 AM México). Sin inputs.
- **PROD manual:** Actions → "Sync Tank Monitoring (PROD)" → Run workflow.
  Sin formulario, click directo.
- **DEV manual:** Actions → "Sync Tank Monitoring (DEV)" → Run workflow.
  Sin formulario.

Procesan automáticamente desde la última fecha sincronizada en BD hasta ayer.

### Backfill (uso excepcional)

Solo cuando se necesita re-procesar un rango histórico o un día específico.

- **PROD:** Actions → "Sync Tank Monitoring — Backfill (PROD)" → Run workflow
  → ingresar `from` y `to` (ambos requeridos, formato `YYYY-MM-DD`).
- **DEV:** Actions → "Sync Tank Monitoring — Backfill (DEV)" → Run workflow
  → ingresar `from` y `to`.

Ambos siguen siendo idempotentes (`ON CONFLICT DO NOTHING`), así que correr
un backfill sobre días ya sincronizados no duplica datos.

## Backfill histórico (una sola vez)

Después de validar el flujo en DEV, correr en PROD:

```
from = 2026-02-27
to   = 2026-04-27
```

Esto hace ~60 fetches al API Tothem. Si rate-limita, partir en bloques de
20 días.

## Secrets requeridos

Ver `docs/SECRETS.md`. Los nuevos para este job son:

- `TOTHEM_HOST`
- `TOTHEM_API_USUARIO`
- `TOTHEM_API_KEY`

Y para el workflow DEV: `DATABASE_POOLER_URL_DEV`, `DATABASE_URL_DEV`.

## Salida (SUMMARY_JSON)

```json
{
  "script": "sync-tank-monitoring",
  "mode": "auto",
  "last_synced_date": "2026-04-27",
  "from": "2026-04-27",
  "to": "2026-04-27",
  "days": 1,
  "fetched": 432,
  "valid": 432,
  "inserted": 432,
  "skipped": 0,
  "errors": 0,
  "warnings": [],
  "elapsed_seconds": 4
}
```

- `mode` — `"auto"` (default) o `"manual"` (cuando se pasa `--from`/`--to`).
- `last_synced_date` — `MAX(date)` en BD al cierre del job (solo en modo auto).
- `fetched` — filas devueltas por el API.
- `valid` — filas con `date == día solicitado` (filtro local).
- `inserted` — nuevas insertadas en BD.
- `skipped` — ya existían (conflict en unique index).
- `errors` — días que fallaron al procesarse.
- `warnings` — array de strings con avisos no fatales.

Cuando no hay nada que sincronizar (`from > to` en modo auto), los contadores
quedan en 0 y `from`/`to` son `null`.

Exit code:
- `0` — éxito (incluye "nada que sincronizar").
- `1` — error fatal (sin BD, sin credenciales, etc.).
- `2` — al menos un día falló (workflow lo marca como failure).

## Troubleshooting

- **`Login Tothem fallo (401)`** → credenciales mal. Verifica `TOTHEM_API_USUARIO`
  y `TOTHEM_API_KEY`.
- **`Login Tothem fallo (5xx)`** → API Tothem caída. Reintentar más tarde
  con el workflow manual.
- **`fetched > 0` pero `valid = 0`** → el API devolvió lecturas de otra
  fecha calendario. Probablemente pediste un día que no tiene datos y el
  API te trajo lecturas adyacentes; revisa `from`/`to`.
- **`skipped > 0` en corrida diaria** → es normal si el job manual ya
  procesó ese día antes (idempotencia funciona).
- **`inserted = 0` y `fetched = 0`** durante varios días seguidos → revisar
  con un fetch manual al API Tothem si el sitio 130 sigue reportando.
