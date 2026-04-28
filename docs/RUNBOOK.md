# Runbook — ejecución y troubleshooting

## Preparación local

```bash
npm install
cp .env.example .env.development    # y .env.production
```

Ambos archivos deben contener `DATABASE_URL`, `DATABASE_POOLER_URL`, las 4 variables `SQL_SERVER_*` y las 3 variables `TOTHEM_*` (para `sync-tank-monitoring`).

---

## Scripts

### 1. `sync-incremental.mjs`

**Qué hace.** Trae registros nuevos y modificados desde AdminPAQ (SQL Server) hacia Supabase. Por cada tabla: compara IDs para encontrar faltantes y, si la tabla tiene `CTIMESTAMP`, también trae los modificados.

**Comando.**
```bash
DOTENV_CONFIG_PATH=.env.development node --env-file=.env.development scripts/sync-incremental.mjs
# o
npm run sync:incremental:dev
```

**Duración típica.** 30-90 segundos.

**Errores comunes.**
- `ECONNREFUSED 127.0.0.1:5432` → `DATABASE_POOLER_URL` vacío. Verifica `.env.development`.
- `Login failed for user` → credenciales SQL Server equivocadas.
- `timeout` en SQL Server → el host no es accesible desde donde corres. En GitHub Actions necesita ser un host público o accesible por el runner.

---

### 2. `sync-update-extra-fields.mjs`

**Qué hace.** Re-sincroniza los campos `extra_text_one/two/three` de `comercial_adm_documents` que pueden haberse editado en AdminPAQ sin disparar cambio en `CTIMESTAMP`.

**Comando.**
```bash
npm run sync:extra:dev
```

**Duración típica.** 10-30 segundos.

---

### 3. `comercial-auto-link.mjs`

**Qué hace.** Vincula:
- **Documentos** (facturas) con mantenimientos (`M-YYMMDD-N`) o accidentes (`S-YYMMDD-N`) en base al campo `extra_text_three`.
- **Movimientos** con unidades (`AP-001`, `TP-015`, etc.) en base al campo `extra_text_one`.

5 pasos para documentos + 3 pasos para movimientos. Todo con `ON CONFLICT DO NOTHING` — idempotente.

**Comando.**
```bash
npm run autolink:dev
```

**Duración típica.** 5-20 segundos.

**Notas.**
- Si el resumen dice `Movs: 55 → 55 (+0)`, no significa que no llegaron movimientos nuevos: significa que no se crearon vínculos nuevos. Los movimientos importados se reportan en el paso anterior (`sync-incremental`).

---

### 4. `sync-tank-monitoring.mjs`

**Qué hace.** Trae lecturas del API Tothem (sitio 130 — monitoreo) y las inserta en `diesel_tank_monitoring`. Alimenta la gráfica "Nivel del Tanque" del reporte `/dashboard/reports/diesel-inventory`.

**Comando.**
```bash
# Día anterior (default)
npm run sync:tanks:dev

# Backfill por rango (paginado día a día)
DOTENV_CONFIG_PATH=.env.development node --env-file=.env.development \
  scripts/sync-tank-monitoring.mjs --from 2026-02-27 --to 2026-04-27
```

**Duración típica.** 2-5 segundos por día.

**Idempotente.** `INSERT ... ON CONFLICT (date, hour, tank_number) DO NOTHING`.

**Notas.**
- Detalle completo en `docs/TANK-MONITORING.md`.
- En PROD corre automático todos los días a las 5:00 AM México.

---

### 5. `backup-prod-to-dev.sh`

**Qué hace.** `pg_dump` de PROD y `pg_restore` en DEV. Excluye datos históricos de `income_transactions` (se filtran por `transaction_date >= $INCOME_TRANSACTIONS_MIN_DATE`, por defecto `2026-01-01`).

**Comando.**
```bash
./scripts/backup-prod-to-dev.sh                  # backup + restore (pide confirmación)
./scripts/backup-prod-to-dev.sh --only-backup    # solo generar dump, no restaurar

INCOME_TRANSACTIONS_MIN_DATE=2025-06-01 ./scripts/backup-prod-to-dev.sh
```

**Requisitos locales.**
- `pg_dump` y `pg_restore` instalados. En macOS:
  ```bash
  brew install libpq && brew link --force libpq
  ```

**Duración típica.** 5-15 minutos (depende del tamaño de la DB).

---

## Workflows en GitHub Actions

### Ejecutar manualmente

```bash
gh workflow run backup-prod-to-dev.yml --repo vargased94/peribusmetro-scripts
gh workflow run comercial-sync-daily-dev.yml --repo vargased94/peribusmetro-scripts
gh workflow run comercial-sync-daily-prod.yml --repo vargased94/peribusmetro-scripts
gh workflow run sync-tank-monitoring-dev.yml --repo vargased94/peribusmetro-scripts
gh workflow run sync-tank-monitoring-prod.yml --repo vargased94/peribusmetro-scripts

# Con inputs de backfill:
gh workflow run sync-tank-monitoring-prod.yml \
  --repo vargased94/peribusmetro-scripts \
  -f from=2026-02-27 -f to=2026-04-27
```

### Ver logs

```bash
gh run list --workflow=comercial-sync-daily-prod.yml --repo vargased94/peribusmetro-scripts --limit 5
gh run view <RUN_ID> --log --repo vargased94/peribusmetro-scripts
gh run view <RUN_ID> --log-failed --repo vargased94/peribusmetro-scripts  # solo los steps que fallaron
```

---

## Troubleshooting por síntoma

| Síntoma | Diagnóstico |
|---|---|
| `ECONNREFUSED ::1:5432` | Secret de Postgres vacío o mal nombrado. Ver `docs/SECRETS.md`. |
| Workflow corre pero no llega email | Secret `RESEND_API_KEY` o `BACKUP_NOTIFY_EMAILS` mal configurado. |
| `Connection timed out` en SQL Server | El runner no alcanza el host. SQL Server debe ser accesible públicamente o vía tunel/VPN. |
| `relation "comercial_adm_movements" does not exist` | La base apuntada en `DATABASE_POOLER_URL` no tiene las tablas. Verificas estás apuntando a la DB correcta. |
| `duplicate key value violates unique constraint` en auto-link | No debería pasar (usa `ON CONFLICT DO NOTHING`). Si pasa, el schema de `comercial_*_links` cambió. |
| Sync muy lento | Lotes de 500 es el default. Si tarda >5min, revisar red con SQL Server. |
| `Login Tothem fallo (401)` | `TOTHEM_API_USUARIO` / `TOTHEM_API_KEY` mal configurados en secrets. |
| Gráfica "Nivel del Tanque" sigue vacía después del sync | Validar con `SELECT MAX(date) FROM diesel_tank_monitoring` que el job esté llenando filas. Ver `docs/TANK-MONITORING.md`. |
