# peribus-scripts

Repositorio centralizado para scripts de automatización, ETL y backups del ecosistema Peribus.

## Qué contiene

- **Backups**: dump diario de Supabase PROD y restauración automática en DEV.
- **Sync comercial**: importación incremental de AdminPAQ (SQL Server) hacia Supabase, actualización de campos extra y auto-link de documentos/movimientos contra mantenimientos, accidentes y unidades.

## Cómo usarlo

### Instalar dependencias

```bash
npm install
```

### Configurar entorno local

```bash
cp .env.example .env.development
# editar .env.development con credenciales de DEV

cp .env.example .env.production
# editar .env.production con credenciales de PROD
```

### Ejecutar scripts manualmente

Ver [`docs/RUNBOOK.md`](docs/RUNBOOK.md) para cada script.

Atajos vía `npm`:

```bash
npm run sync:incremental:dev
npm run sync:extra:dev
npm run autolink:dev

npm run sync:incremental:prod   # ojo: tocar PROD
npm run backup:prod-to-dev
```

### Ejecutar en GitHub Actions

Todos los workflows se disparan **manualmente** (`workflow_dispatch`) durante la fase de validación. Una vez aprobados, se agrega `schedule:` para que corran automáticos.

Ver [`docs/MIGRATION.md`](docs/MIGRATION.md) para la fase actual.

## Documentación

- [`PLAN.md`](PLAN.md) — plan completo de migración desde `peribus-incidents-admin`.
- [`docs/SECRETS.md`](docs/SECRETS.md) — secrets necesarios y cómo configurarlos.
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — cómo correr cada script y troubleshooting.
- [`docs/MIGRATION.md`](docs/MIGRATION.md) — checklist paso a paso.

## Convenciones

- Scripts en `scripts/` son ejecutables directo con `node` o `bash`.
- Ningún script debe depender del proyecto `peribus-incidents-admin` (ni Drizzle, ni Next.js, ni imports `@/`).
- Los scripts son **idempotentes**: pueden correrse varias veces el mismo día sin duplicar datos ni romper estado.
- Toda modificación a PROD debe validarse primero en DEV.
