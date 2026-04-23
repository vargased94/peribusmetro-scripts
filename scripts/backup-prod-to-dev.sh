#!/bin/bash
# =============================================================================
# Backup PROD → DEV
#
# Hace un pg_dump de producción y lo restaura en desarrollo.
# Lee las credenciales desde los archivos .env.production y .env.development
#
# Uso:
#   ./scripts/backup-prod-to-dev.sh              # Backup + restaurar en DEV
#   ./scripts/backup-prod-to-dev.sh --only-backup # Solo generar backup sin restaurar
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUPS_DIR="${PROJECT_DIR}/backups"
ENV_PROD="${PROJECT_DIR}/.env.production"
ENV_DEV="${PROJECT_DIR}/.env.development"

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ── Funciones ──────────────────────────────────────────────────────────────────

log_info()  { echo -e "${BLUE}[INFO]${NC}  $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

extract_db_url() {
  local env_file="$1"
  if [ ! -f "$env_file" ]; then
    log_error "No se encontró el archivo: $env_file"
    exit 1
  fi
  grep "^DATABASE_URL=" "$env_file" | cut -d'=' -f2-
}

# ── Verificar dependencias ────────────────────────────────────────────────────

if ! command -v pg_dump &> /dev/null; then
  log_error "pg_dump no está instalado. Instala PostgreSQL client:"
  echo "  brew install libpq && brew link --force libpq"
  exit 1
fi

if ! command -v pg_restore &> /dev/null; then
  log_error "pg_restore no está instalado. Instala PostgreSQL client:"
  echo "  brew install libpq && brew link --force libpq"
  exit 1
fi

# ── Parsear argumentos ────────────────────────────────────────────────────────

ONLY_BACKUP=false
if [ "${1:-}" = "--only-backup" ]; then
  ONLY_BACKUP=true
fi

# ── Leer URLs de los .env ─────────────────────────────────────────────────────

log_info "Leyendo credenciales de los archivos .env..."

DATABASE_URL_PROD=$(extract_db_url "$ENV_PROD")
DATABASE_URL_DEV=$(extract_db_url "$ENV_DEV")

if [ -z "$DATABASE_URL_PROD" ]; then
  log_error "DATABASE_URL no encontrada en $ENV_PROD"
  exit 1
fi

if [ -z "$DATABASE_URL_DEV" ] && [ "$ONLY_BACKUP" = false ]; then
  log_error "DATABASE_URL no encontrada en $ENV_DEV"
  exit 1
fi

log_ok "Credenciales cargadas"

# ── Crear directorio de backups ───────────────────────────────────────────────

mkdir -p "$BACKUPS_DIR"

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUPS_DIR}/main_${TIMESTAMP}.dump"
BACKUP_FILE_LARGE="${BACKUPS_DIR}/income_transactions_${TIMESTAMP}.csv.gz"

# Fecha mínima para backup filtrado de income_transactions (formato YYYY-MM-DD)
# Solo se traen a DEV registros con transaction_date >= este valor.
INCOME_TRANSACTIONS_MIN_DATE="${INCOME_TRANSACTIONS_MIN_DATE:-2026-01-01}"

# ── Paso 1: pg_dump de PROD (separado en 2 partes) ──────────────────────────

echo ""
log_info "═══════════════════════════════════════════════════"
log_info "  Paso 1: Backup de PRODUCCIÓN (solo lectura)"
log_info "═══════════════════════════════════════════════════"
echo ""

START_TIME=$(date +%s)

# Parte A: Schema completo + datos (excluyendo tablas grandes)
log_info "Parte A: Dump principal (sin datos de income_transactions)..."
pg_dump "$DATABASE_URL_PROD" \
  --schema=public \
  --format=custom \
  --compress=1 \
  --no-owner \
  --no-privileges \
  --exclude-table-data=income_transactions \
  --file="$BACKUP_FILE" 2>&1

FILE_SIZE_MAIN=$(du -h "$BACKUP_FILE" | cut -f1)
log_ok "Dump principal: $FILE_SIZE_MAIN"

# Parte B: Solo datos filtrados de income_transactions (>= $INCOME_TRANSACTIONS_MIN_DATE)
# pg_dump no soporta WHERE, así que usamos COPY TO con filtro. Exportamos en CSV
# comprimido con gzip para reducir tamaño de transferencia.
log_info "Parte B: Dump income_transactions (CSV filtrado, transaction_date >= ${INCOME_TRANSACTIONS_MIN_DATE})..."
psql "$DATABASE_URL_PROD" -v ON_ERROR_STOP=1 \
  -c "\COPY (SELECT * FROM income_transactions WHERE transaction_date >= '${INCOME_TRANSACTIONS_MIN_DATE}') TO STDOUT WITH (FORMAT csv, HEADER true)" \
  | gzip -1 > "$BACKUP_FILE_LARGE"

FILE_SIZE_LARGE=$(du -h "$BACKUP_FILE_LARGE" | cut -f1)
log_ok "Dump income_transactions: $FILE_SIZE_LARGE"

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
log_ok "Backup completado"
log_ok "  Principal:           $BACKUP_FILE ($FILE_SIZE_MAIN)"
log_ok "  income_transactions: $BACKUP_FILE_LARGE ($FILE_SIZE_LARGE)"
log_ok "  Duración: ${DURATION}s"

# ── Paso 2: Restaurar en DEV ─────────────────────────────────────────────────

if [ "$ONLY_BACKUP" = true ]; then
  echo ""
  log_warn "Modo --only-backup: se omite la restauración en DEV"
  echo ""
  log_ok "Backup principal: $BACKUP_FILE"
  log_ok "Backup income_transactions: $BACKUP_FILE_LARGE"
  exit 0
fi

echo ""
log_info "═══════════════════════════════════════════════════"
log_info "  Paso 2: Restaurar en DESARROLLO"
log_info "═══════════════════════════════════════════════════"
echo ""

log_warn "Esto va a SOBREESCRIBIR toda la base de datos de DEV"
read -p "¿Continuar? (s/N): " CONFIRM
if [ "$CONFIRM" != "s" ] && [ "$CONFIRM" != "S" ]; then
  log_warn "Restauración cancelada por el usuario"
  log_ok "El backup sigue disponible en: $BACKUP_FILE"
  exit 0
fi

echo ""
START_TIME=$(date +%s)

log_info "Limpiando schema public en DEV..."
psql "$DATABASE_URL_DEV" -c "
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
  GRANT ALL ON SCHEMA public TO postgres;
  GRANT ALL ON SCHEMA public TO public;
" 2>&1

# Fase 1: Restaurar schema (tablas, secuencias, funciones)
log_info "Fase 1: Restaurando schema (pre-data)..."
pg_restore \
  -d "$DATABASE_URL_DEV" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --section=pre-data \
  "$BACKUP_FILE" 2>&1 || {
    log_warn "pg_restore pre-data terminó con advertencias"
  }

# Fase 2: Restaurar datos (del dump principal, sin income_transactions)
log_info "Fase 2: Restaurando datos (sin income_transactions)..."
pg_restore \
  -d "$DATABASE_URL_DEV" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --section=data \
  "$BACKUP_FILE" 2>&1 || {
    log_warn "pg_restore data terminó con advertencias"
  }

# Fase 3: Restaurar income_transactions desde CSV filtrado (solo >= INCOME_TRANSACTIONS_MIN_DATE)
log_info "Fase 3: Restaurando income_transactions desde CSV filtrado..."
psql "$DATABASE_URL_DEV" -c "ALTER TABLE income_transactions DISABLE TRIGGER ALL;" 2>&1 || true
psql "$DATABASE_URL_DEV" -c "SET statement_timeout = 0;" 2>&1 || true

gunzip -c "$BACKUP_FILE_LARGE" \
  | psql "$DATABASE_URL_DEV" -v ON_ERROR_STOP=1 \
    -c "\COPY income_transactions FROM STDIN WITH (FORMAT csv, HEADER true)" 2>&1 || {
      log_warn "income_transactions restore falló. Verificar logs."
    }

psql "$DATABASE_URL_DEV" -c "ALTER TABLE income_transactions ENABLE TRIGGER ALL;" 2>&1 || true
# Resincronizar secuencia del id tras el COPY
psql "$DATABASE_URL_DEV" -c "SELECT setval(pg_get_serial_sequence('income_transactions', 'id'), COALESCE(MAX(id), 1)) FROM income_transactions;" 2>&1 || true
log_ok "income_transactions restaurada"

# Fase 4: Restaurar post-data (indexes, constraints, FKs, triggers)
log_info "Fase 4: Restaurando indexes y constraints (post-data)..."
pg_restore \
  -d "$DATABASE_URL_DEV" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --section=post-data \
  "$BACKUP_FILE" 2>&1 || {
    log_warn "pg_restore post-data terminó con advertencias"
  }

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo ""
log_ok "Restauración completada en ${DURATION}s"

# ── Paso 3: Verificación ─────────────────────────────────────────────────────

echo ""
log_info "═══════════════════════════════════════════════════"
log_info "  Paso 3: Verificación"
log_info "═══════════════════════════════════════════════════"
echo ""

psql "$DATABASE_URL_DEV" <<'SQL'
  SELECT 'Tablas en public' AS verificacion, COUNT(*)::text AS total
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  UNION ALL
  SELECT 'Total usuarios', COUNT(*)::text FROM users
  UNION ALL
  SELECT 'Total unidades', COUNT(*)::text FROM units
  UNION ALL
  SELECT 'Total income_transactions', COUNT(*)::text FROM income_transactions;
SQL

echo ""
log_ok "═══════════════════════════════════════════════════"
log_ok "  Backup PROD → DEV completado exitosamente"
log_ok "  Principal:           $BACKUP_FILE"
log_ok "  income_transactions: $BACKUP_FILE_LARGE"
log_ok "═══════════════════════════════════════════════════"
