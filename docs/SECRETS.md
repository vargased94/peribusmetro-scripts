# Secrets requeridos

Todos los secrets se configuran en: **Settings → Secrets and variables → Actions → Repository secrets**.

## Listado completo

| Secret | Valor | Usado por |
|---|---|---|
| `RESEND_API_KEY` | API key de Resend para enviar emails | Todos los workflows |
| `BACKUP_NOTIFY_EMAILS` | Lista de emails separados por coma | Todos los workflows |
| `DATABASE_URL_PROD` | URL directa de Postgres PROD (puerto 5432) | `backup-prod-to-dev.yml` |
| `DATABASE_URL_DEV` | URL directa de Postgres DEV (puerto 5432) | `backup-prod-to-dev.yml` |
| `DATABASE_POOLER_URL` | URL del pooler PROD (puerto 6543) | `comercial-sync-daily-prod.yml` |
| `DATABASE_POOLER_URL_DEV` | URL del pooler DEV (puerto 6543) | `comercial-sync-daily-dev.yml` (solo en fase de pruebas) |
| `SQL_SERVER_HOST` | Host o IP de SQL Server | `comercial-sync-*.yml` |
| `SQL_SERVER_PORT` | Puerto de SQL Server (normalmente 1433) | `comercial-sync-*.yml` |
| `SQL_SERVER_USER` | Usuario de SQL Server | `comercial-sync-*.yml` |
| `SQL_SERVER_PASSWORD` | Password de SQL Server | `comercial-sync-*.yml` |
| `TOTHEM_HOST` | URL base del API Tothem (con `/api`) | `sync-tank-monitoring-*.yml` |
| `TOTHEM_API_USUARIO` | Usuario para login en Tothem | `sync-tank-monitoring-*.yml` |
| `TOTHEM_API_KEY` | API key de Tothem | `sync-tank-monitoring-*.yml` |

**Total: 13 secrets.**

## Cómo obtener cada valor

Todos los valores ya existen en el repo `peribus-incidents-admin` (`Settings → Secrets and variables → Actions`). Para copiarlos:

1. Abre el secret en el repo origen — **no se puede ver el valor** (GitHub no los expone después de crearlos).
2. Si no tienes el valor a mano:
   - **Postgres URLs**: Supabase → Project → Settings → Database → Connection string.
   - **SQL Server**: desde el archivo `.env.production` local del proyecto `peribus-incidents-admin`.
   - **Resend**: Resend dashboard → API Keys.
   - **Tothem**: desde el archivo `.env.production` local del proyecto `peribus-incidents-admin` (`TOTHEM_HOST`, `TOTHEM_API_USUARIO`, `TOTHEM_API_KEY`).

## Ejemplo con `gh CLI`

```bash
# Configurar desde línea de comandos (más rápido que la UI)
gh secret set RESEND_API_KEY --repo vargased94/peribusmetro-scripts
gh secret set DATABASE_URL_PROD --repo vargased94/peribusmetro-scripts
# ...etc
```

O de forma masiva desde un archivo local `.env.secrets` (NO commitear):

```bash
while IFS='=' read -r key value; do
  [ -z "$key" ] || [ "${key#\#}" != "$key" ] && continue
  gh secret set "$key" --repo vargased94/peribusmetro-scripts --body "$value"
done < .env.secrets
```

## Environments (opcional)

Si en el futuro quieres separar los secrets por ambiente (`development` / `production`) y que GitHub pida aprobación para correr en PROD, puedes configurarlos en:

**Settings → Environments → New environment**

Y referenciarlos en el workflow con `environment: production`. Por ahora se mantiene todo como Repository secrets para simplificar.
