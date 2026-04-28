// =============================================================================
// sync-tank-monitoring.mjs
//
// Sincroniza lecturas del API Tothem (sitio 130 - monitoreo) hacia la tabla
// `diesel_tank_monitoring` en Supabase.
//
// Uso:
//   # Día anterior (default), zona horaria America/Mexico_City
//   node --env-file=.env.production scripts/sync-tank-monitoring.mjs
//
//   # Backfill por rango (paginado día a día)
//   node --env-file=.env.production scripts/sync-tank-monitoring.mjs \
//        --from 2026-02-27 --to 2026-04-27
//
// Idempotente:
//   INSERT ... ON CONFLICT (date, hour, tank_number) DO NOTHING
// =============================================================================

import postgres from "postgres";
import { config } from "dotenv";

config({ path: process.env.DOTENV_CONFIG_PATH || ".env.development" });

// ----------------------------------------------------------------------------
// CONFIGURACIÓN
// ----------------------------------------------------------------------------

const TOTHEM_HOST_RAW = process.env.TOTHEM_HOST || "";
const TOTHEM_HOST = TOTHEM_HOST_RAW.replace(/\/$/, "");
const TOTHEM_USER = process.env.TOTHEM_API_USUARIO || process.env.TOTHEM_USER || "";
const TOTHEM_KEY = process.env.TOTHEM_API_KEY || process.env.TOTHEM_KEY || "";
const SITIO = process.env.TOTHEM_SITIO || "130";

if (!TOTHEM_HOST || !TOTHEM_USER || !TOTHEM_KEY) {
  console.error(
    "[sync-tank-monitoring] Faltan TOTHEM_HOST / TOTHEM_API_USUARIO / TOTHEM_API_KEY"
  );
  process.exit(1);
}

if (!process.env.DATABASE_POOLER_URL) {
  console.error("[sync-tank-monitoring] Falta DATABASE_POOLER_URL");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_POOLER_URL, {
  ssl: "require",
  prepare: false,
  max: 1,
});

// ----------------------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------------------

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

/** YYYY-MM-DD del día actual en zona horaria America/Mexico_City. */
function todayInMx() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // en-CA → "YYYY-MM-DD"
}

/** Suma `n` días a un YYYY-MM-DD (string in/out). */
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function logInfo(msg) {
  console.log(`[sync-tank-monitoring] ${msg}`);
}

function logError(msg) {
  console.error(`[sync-tank-monitoring] ${msg}`);
}

// ----------------------------------------------------------------------------
// CLIENTE TOTHEM
// ----------------------------------------------------------------------------

let _accessToken = null;

async function loginTothem() {
  const url = `${TOTHEM_HOST}/login`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario: TOTHEM_USER, api_key: TOTHEM_KEY }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Login Tothem fallo (${res.status}): ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data?.access_token) throw new Error("Login Tothem no devolvió access_token");
  _accessToken = data.access_token;
  return _accessToken;
}

async function fetchMonitoring(fechaInicial, fechaFinal) {
  if (!_accessToken) await loginTothem();

  const url = new URL(`${TOTHEM_HOST}/sitio/${SITIO}/monitoreo`);
  url.searchParams.append("fecha_inicial", fechaInicial);
  url.searchParams.append("fecha_final", fechaFinal);
  url.searchParams.append("orden", "1");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${_accessToken}` },
  });

  // Si el token expiró, reintentar una vez con login fresco
  if (res.status === 401) {
    await loginTothem();
    const retry = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${_accessToken}` },
    });
    if (!retry.ok) {
      const txt = await retry.text().catch(() => "");
      throw new Error(`Monitoreo fallo (${retry.status}): ${txt.slice(0, 200)}`);
    }
    const json = await retry.json();
    return Array.isArray(json?.data) ? json.data : [];
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Monitoreo fallo (${res.status}): ${txt.slice(0, 200)}`);
  }

  const json = await res.json();
  return Array.isArray(json?.data) ? json.data : [];
}

// ----------------------------------------------------------------------------
// MAPEO API → DB
// ----------------------------------------------------------------------------

/**
 * El API devuelve `fecha` como YYYY-MM-DD y `hora` como HHmmss (string).
 * En BD el unique index es (date, hour, tank_number) y `hour` es VARCHAR(5).
 * Convertimos hora a HH:MM (truncando segundos) para coincidir con la convención
 * de la tabla (la tabla tiene `length: 5`).
 */
function mapReading(row) {
  const horaRaw = String(row?.hora ?? "").padStart(6, "0");
  const hh = horaRaw.slice(0, 2);
  const mm = horaRaw.slice(2, 4);
  const hour = `${hh}:${mm}`;

  return {
    date: row?.fecha ?? null,
    hour,
    tank_number: Number(row?.numero_tanque),
    actual_status:
      row?.status_actual === undefined || row?.status_actual === null
        ? null
        : Number(row.status_actual),
    volume: row?.volumen != null ? Number(row.volumen) : null,
    compensated_volume:
      row?.volumen_compensado != null ? Number(row.volumen_compensado) : null,
    height: row?.altura != null ? Number(row.altura) : null,
    temperature: row?.temperatura != null ? Number(row.temperatura) : null,
    water_volume:
      row?.volument_agua != null ? Number(row.volument_agua) : null,
  };
}

function isValidReading(r) {
  return (
    r.date &&
    r.hour &&
    Number.isFinite(r.tank_number) &&
    r.tank_number > 0
  );
}

// ----------------------------------------------------------------------------
// PROCESO POR DÍA
// ----------------------------------------------------------------------------

async function processDay(dateStr) {
  const fechaInicial = `${dateStr} 00:00:00`;
  const fechaFinal = `${dateStr} 23:59:59`;

  const apiRows = await fetchMonitoring(fechaInicial, fechaFinal);
  const mapped = apiRows.map(mapReading).filter(isValidReading);

  if (mapped.length === 0) {
    return { date: dateStr, fetched: apiRows.length, inserted: 0, skipped: 0 };
  }

  // Filtrar solo lecturas que caigan EXACTAMENTE en el día solicitado
  // (el API a veces trae lecturas adyacentes por la forma en que filtra).
  const onlyForDay = mapped.filter((r) => r.date === dateStr);

  // Antes/después: calcular cuántas filas existen para ese día
  const before = await sql`
    SELECT COUNT(*)::int AS c
    FROM diesel_tank_monitoring
    WHERE date = ${dateStr}
  `;

  // Insertar en chunks para no exceder límites del pooler
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < onlyForDay.length; i += CHUNK) {
    const chunk = onlyForDay.slice(i, i + CHUNK);
    const result = await sql`
      INSERT INTO diesel_tank_monitoring ${sql(
        chunk,
        "date",
        "hour",
        "tank_number",
        "actual_status",
        "volume",
        "compensated_volume",
        "height",
        "temperature",
        "water_volume"
      )}
      ON CONFLICT (date, hour, tank_number) DO NOTHING
    `;
    inserted += result.count ?? 0;
  }

  const skipped = onlyForDay.length - inserted;

  return {
    date: dateStr,
    fetched: apiRows.length,
    valid: onlyForDay.length,
    inserted,
    skipped,
    rows_before: before[0]?.c ?? 0,
  };
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();

  // Determinar rango
  const cliFrom = getArg("from");
  const cliTo = getArg("to");

  let fromDate;
  let toDate;

  if (cliFrom && cliTo) {
    fromDate = cliFrom;
    toDate = cliTo;
  } else if (cliFrom && !cliTo) {
    fromDate = cliFrom;
    toDate = cliFrom;
  } else {
    // Default: día anterior en zona MX
    const yesterday = addDays(todayInMx(), -1);
    fromDate = yesterday;
    toDate = yesterday;
  }

  if (fromDate > toDate) {
    logError(`Rango invalido: from=${fromDate} > to=${toDate}`);
    await sql.end();
    process.exit(1);
  }

  logInfo(`Iniciando sync — rango ${fromDate} → ${toDate} (zona MX)`);
  logInfo(`Tothem: ${TOTHEM_HOST}  sitio=${SITIO}`);

  const results = [];
  let totalFetched = 0;
  let totalValid = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  let firstError = null;

  let cursor = fromDate;
  while (cursor <= toDate) {
    try {
      const r = await processDay(cursor);
      results.push(r);
      totalFetched += r.fetched ?? 0;
      totalValid += r.valid ?? 0;
      totalInserted += r.inserted ?? 0;
      totalSkipped += r.skipped ?? 0;
      logInfo(
        `  ${r.date}  fetched=${r.fetched}  valid=${r.valid ?? 0}  inserted=${r.inserted}  skipped=${r.skipped}`
      );
    } catch (err) {
      const msg = err?.message || String(err);
      logError(`  ${cursor}  ERROR: ${msg}`);
      results.push({ date: cursor, error: msg });
      if (!firstError) firstError = msg;
    }
    cursor = addDays(cursor, 1);
  }

  const elapsedSeconds = Math.round((Date.now() - t0) / 1000);

  // Resumen JSON para consumo del workflow
  const summary = {
    script: "sync-tank-monitoring",
    from: fromDate,
    to: toDate,
    days: results.length,
    fetched: totalFetched,
    valid: totalValid,
    inserted: totalInserted,
    skipped: totalSkipped,
    errors: results.filter((r) => r.error).length,
    elapsed_seconds: elapsedSeconds,
  };

  console.log(`::SUMMARY_JSON::${JSON.stringify(summary)}`);
  logInfo(
    `Tiempo total: ${elapsedSeconds}s — días=${summary.days} fetched=${totalFetched} inserted=${totalInserted} skipped=${totalSkipped} errors=${summary.errors}`
  );

  await sql.end();

  if (firstError) process.exit(2);
}

main().catch(async (err) => {
  logError(`Fatal: ${err?.message || err}`);
  try {
    await sql.end();
  } catch {}
  process.exit(1);
});
