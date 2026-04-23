#!/bin/bash
# =============================================================================
# setup-secrets.sh
#
# Configura los 10 secrets del repo peribus-scripts leyendo valores de los
# archivos .env del proyecto peribus-incidents-admin. Usa gh CLI.
#
# Uso:
#   ./scripts/setup-secrets.sh vargased94/peribusmetro-scripts
#
# Ejemplo:
#   ./scripts/setup-secrets.sh miusuario/peribus-scripts
#
# Requisitos:
#   - gh CLI autenticado (gh auth status)
#   - El repo destino ya creado en GitHub
#   - Archivos .env.production y .env.development de peribus-incidents-admin accesibles
# =============================================================================

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

REPO="${1:-}"
if [ -z "$REPO" ]; then
  echo "Uso: $0 vargased94/peribusmetro-scripts"
  exit 1
fi

INCIDENTS_ADMIN_DIR="${INCIDENTS_ADMIN_DIR:-/Users/programacion/Documents/Github/peribus-incidents-admin}"
ENV_PROD="${INCIDENTS_ADMIN_DIR}/.env.production"
ENV_DEV="${INCIDENTS_ADMIN_DIR}/.env.development"

# Colores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# ── Helpers ──────────────────────────────────────────────────────────────────

extract_var() {
  local file="$1"
  local var="$2"
  if [ ! -f "$file" ]; then
    echo ""
    return
  fi
  grep "^${var}=" "$file" | head -1 | cut -d'=' -f2- || echo ""
}

set_secret() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ]; then
    echo -e "${YELLOW}[SKIP]${NC} $name — valor vacío"
    return
  fi
  echo "$value" | gh secret set "$name" --repo "$REPO" --body -
  echo -e "${GREEN}[OK]${NC}   $name"
}

# ── Validaciones previas ─────────────────────────────────────────────────────

if ! command -v gh &>/dev/null; then
  echo -e "${RED}Error:${NC} gh CLI no está instalado"
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo -e "${RED}Error:${NC} no autenticado con gh. Corre: gh auth login"
  exit 1
fi

if [ ! -f "$ENV_PROD" ]; then
  echo -e "${RED}Error:${NC} no se encontró $ENV_PROD"
  exit 1
fi

if [ ! -f "$ENV_DEV" ]; then
  echo -e "${RED}Error:${NC} no se encontró $ENV_DEV"
  exit 1
fi

# Verificar que el repo existe
if ! gh repo view "$REPO" &>/dev/null; then
  echo -e "${RED}Error:${NC} repo $REPO no existe o no tienes acceso"
  exit 1
fi

echo "═══════════════════════════════════════════════════════"
echo "  Configurando secrets en $REPO"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Leyendo de:"
echo "    PROD: $ENV_PROD"
echo "    DEV:  $ENV_DEV"
echo ""

# ── Leer valores ─────────────────────────────────────────────────────────────

DATABASE_URL_PROD=$(extract_var "$ENV_PROD" "DATABASE_URL")
DATABASE_URL_DEV=$(extract_var "$ENV_DEV" "DATABASE_URL")
DATABASE_POOLER_URL_PROD=$(extract_var "$ENV_PROD" "DATABASE_POOLER_URL")
DATABASE_POOLER_URL_DEV=$(extract_var "$ENV_DEV" "DATABASE_POOLER_URL")

SQL_SERVER_HOST=$(extract_var "$ENV_PROD" "SQL_SERVER_HOST")
SQL_SERVER_PORT=$(extract_var "$ENV_PROD" "SQL_SERVER_PORT")
SQL_SERVER_USER=$(extract_var "$ENV_PROD" "SQL_SERVER_USER")
SQL_SERVER_PASSWORD=$(extract_var "$ENV_PROD" "SQL_SERVER_PASSWORD")

RESEND_API_KEY=$(extract_var "$ENV_PROD" "RESEND_API_KEY")

# ── Prompt para secrets que no están en los .env ─────────────────────────────

if [ -z "$RESEND_API_KEY" ]; then
  echo -e "${YELLOW}RESEND_API_KEY no está en $ENV_PROD.${NC}"
  read -r -p "  Pégalo aquí (o Enter para saltar): " RESEND_API_KEY
fi

echo ""
read -r -p "BACKUP_NOTIFY_EMAILS (coma-separados, ej: a@b.com,c@d.com): " BACKUP_NOTIFY_EMAILS

# ── Configurar secrets ───────────────────────────────────────────────────────

echo ""
echo "─── Configurando secrets ───"
echo ""

set_secret "DATABASE_URL_PROD"         "$DATABASE_URL_PROD"
set_secret "DATABASE_URL_DEV"          "$DATABASE_URL_DEV"
set_secret "DATABASE_POOLER_URL"       "$DATABASE_POOLER_URL_PROD"
set_secret "DATABASE_POOLER_URL_DEV"   "$DATABASE_POOLER_URL_DEV"
set_secret "SQL_SERVER_HOST"           "$SQL_SERVER_HOST"
set_secret "SQL_SERVER_PORT"           "$SQL_SERVER_PORT"
set_secret "SQL_SERVER_USER"           "$SQL_SERVER_USER"
set_secret "SQL_SERVER_PASSWORD"       "$SQL_SERVER_PASSWORD"
set_secret "RESEND_API_KEY"            "$RESEND_API_KEY"
set_secret "BACKUP_NOTIFY_EMAILS"      "$BACKUP_NOTIFY_EMAILS"

echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "${GREEN}  Secrets configurados.${NC}"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "Verifica con:"
echo "  gh secret list --repo $REPO"
