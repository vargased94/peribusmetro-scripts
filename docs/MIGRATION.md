# Checklist de migración

## Estado actual

- [x] **Fase 0** — Setup local: estructura, scripts, workflows, docs
- [ ] **Fase 1** — Crear repo remoto + configurar secrets
- [ ] **Fase 2** — Validar en DEV
- [ ] **Fase 3** — Validar en PROD (manual)
- [ ] **Fase 4** — Activar crons (doble ejecución temporal)
- [ ] **Fase 5** — Apagar workflows viejos en `peribus-incidents-admin`
- [ ] **Fase 6** — Migrar los workflows restantes (odómetros, etc.)

---

## Fase 1 — Crear repo remoto

```bash
cd /Users/programacion/Documents/Github/peribus-scripts
git init
git add .
git commit -m "chore: initial setup — scripts, workflows, docs"

# Crear repo en GitHub bajo la cuenta de pago
gh repo create vargased94/peribusmetro-scripts --private --source=. --remote=origin --push
```

Reemplazar `OWNER` con el owner correcto (tu cuenta personal o la org de pago).

**Configurar secrets:** ver [`docs/SECRETS.md`](SECRETS.md). Son 10 en total.

---

## Fase 2 — Validación en DEV

### 2.1. `comercial-sync-daily-dev`

```bash
gh workflow run comercial-sync-daily-dev.yml --repo vargased94/peribusmetro-scripts
gh run list --workflow=comercial-sync-daily-dev.yml --repo vargased94/peribusmetro-scripts --limit 1
gh run view <RUN_ID> --log --repo vargased94/peribusmetro-scripts
```

**Criterios de éxito:**
- [ ] Los 3 pasos (`sync-incremental`, `sync-update-extra-fields`, `comercial-auto-link`) terminan sin error.
- [ ] El `::SUMMARY_JSON::` de cada uno se extrae correctamente (visible en el `$GITHUB_STEP_SUMMARY`).
- [ ] Llega email de éxito a `BACKUP_NOTIFY_EMAILS` con el resumen correcto.
- [ ] El conteo de registros en Supabase DEV es consistente con una corrida reciente del workflow actual.

### 2.2. `backup-prod-to-dev` — modo solo-backup

```bash
gh workflow run backup-prod-to-dev.yml --repo vargased94/peribusmetro-scripts -f skip_restore=true
```

**Criterios de éxito:**
- [ ] Se sube artefacto `prod-backup-*` con 2 archivos (`.dump` + `.csv.gz`).
- [ ] Tamaños razonables (comparar con un backup reciente).

### 2.3. `backup-prod-to-dev` — completo

```bash
gh workflow run backup-prod-to-dev.yml --repo vargased94/peribusmetro-scripts
```

**Criterios de éxito:**
- [ ] Todas las fases (pre-data, data, income_transactions, post-data) terminan sin error crítico.
- [ ] Verificación final: `users`, `units`, `income_transactions` tienen conteos > 0.
- [ ] Email de éxito con resumen.

---

## Fase 3 — Validación en PROD (manual)

```bash
gh workflow run comercial-sync-daily-prod.yml --repo vargased94/peribusmetro-scripts
```

Repetir 3-5 días consecutivos antes de pasar a Fase 4. Monitorear email de éxito.

**Si en algún día falla:**
1. Revisar `gh run view <RUN_ID> --log-failed`.
2. No pasar a Fase 4 hasta que 3 ejecuciones seguidas salgan OK.

---

## Fase 4 — Activar crons

### 4.1. Agregar `schedule:` a los workflows

Editar los 2 workflows y agregar al bloque `on:`:

```yaml
on:
  schedule:
    - cron: "0 8 * * *"    # para backup-prod-to-dev (02:00 AM CST)
    # - cron: "0 11 * * *"   # para comercial-sync-daily-prod (05:00 AM CST)
  workflow_dispatch:
    # ...inputs existentes
```

Commit + push:
```bash
git add .github/workflows/
git commit -m "chore: enable scheduled runs for backup and comercial-sync"
git push
```

### 4.2. Convivencia

**Importante:** los workflows viejos en `peribus-incidents-admin` siguen activos. Durante 2-3 días habrá **doble ejecución** (una en cada repo).

Esto es seguro porque:
- `sync-incremental.mjs` compara IDs antes de insertar — no duplica.
- `sync-update-extra-fields.mjs` solo actualiza si hay diff — idempotente.
- `comercial-auto-link.mjs` usa `ON CONFLICT DO NOTHING` + `NOT EXISTS` — idempotente.
- `backup-prod-to-dev.sh` limpia DEV antes de restaurar — el último que corre gana, pero ambos traen el mismo estado de PROD.

**Revisar durante estos días:**
- [ ] No aparecen registros duplicados en `comercial_document_links` ni `comercial_movement_unit_links`.
- [ ] Ambos workflows siguen enviando email de éxito.

---

## Fase 5 — Apagar workflows viejos

En `peribus-incidents-admin`:

```bash
cd /Users/programacion/Documents/Github/peribus-incidents-admin
git checkout -b chore/remove-migrated-workflows
git rm .github/workflows/backup-prod-to-dev.yml
git rm .github/workflows/comercial-sync-daily-prod.yml
git commit -m "chore: remove workflows migrated to peribus-scripts"
git push -u origin chore/remove-migrated-workflows
# crear PR + merge a dev → master
```

Después de una semana sin incidencias, borrar también el secret `DATABASE_POOLER_URL_DEV` del repo nuevo si ya no se va a usar (solo sirvió en Fase 2).

---

## Fase 6 — Migrar workflows restantes

Repetir el ciclo (Fase 2 → 5) con cada uno:

- [ ] `odometers-daily-prod.yml`
- [ ] `odometers-daily-dev.yml`
- [ ] `odometers-monthly-prod.yml`
- [ ] `odometers-monthly-dev.yml`
- [ ] `preventive-maintenance-daily-dev.yml`

Son workflows con solo SQL directo (`psql`), así que la migración es literal: copiar el `.yml` y ajustar el nombre del repo en las URLs de artifacts (si aplica).
