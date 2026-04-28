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
- Workflow PROD (cron 5 AM MX + manual): `.github/workflows/sync-tank-monitoring-prod.yml`
- Workflow DEV (manual): `.github/workflows/sync-tank-monitoring-dev.yml`

## Comportamiento

- **Sin args** → trae el día anterior en zona `America/Mexico_City`.
- **Con `--from YYYY-MM-DD --to YYYY-MM-DD`** → backfill, paginando día a día.
- **Idempotente:** `INSERT ... ON CONFLICT (date, hour, tank_number) DO NOTHING`.
  El unique index ya existe en la tabla.
- Convierte `hora` del API (`HHmmss`) a `HH:MM` para casar con el `varchar(5)`
  de la columna `hour`.
- Imprime una línea `::SUMMARY_JSON::{...}` que el workflow consume para el
  email de notificación y el summary de GitHub.

## Ejecución local

```bash
# Día anterior (default)
npm run sync:tanks:dev

# Backfill
DOTENV_CONFIG_PATH=.env.development \
  node --env-file=.env.development \
  scripts/sync-tank-monitoring.mjs --from 2026-02-27 --to 2026-04-27
```

`.env.development` necesita `DATABASE_POOLER_URL`, `TOTHEM_HOST`,
`TOTHEM_API_USUARIO`, `TOTHEM_API_KEY`. Plantilla en `.env.example`.

## Ejecución en GitHub Actions

- **Diario PROD:** automático a las 11:00 UTC (5:00 AM México). Sin acción
  necesaria una vez activos los secrets.
- **Manual (PROD o DEV):** Actions → "Sync Tank Monitoring (PROD/DEV)" →
  Run workflow → completar `from` / `to` para backfill.

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
  "from": "2026-04-27",
  "to": "2026-04-27",
  "days": 1,
  "fetched": 432,
  "valid": 432,
  "inserted": 432,
  "skipped": 0,
  "errors": 0,
  "elapsed_seconds": 4
}
```

- `fetched` — filas devueltas por el API.
- `valid` — filas con `date == día solicitado` (filtro local).
- `inserted` — nuevas insertadas en BD.
- `skipped` — ya existían (conflict en unique index).
- `errors` — días que fallaron al procesarse.

Exit code:
- `0` — éxito.
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
