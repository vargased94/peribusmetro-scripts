// =============================================================================
// sync-adblue.mjs
//
// Sincroniza las cargas de AdBlue/Urea desde la API de Piusi B.Smart
// (https://apibsmartexport.piusi.com) hacia la tabla `supramax_diesel_charges`
// en Supabase, marcadas con provider = 'BSMART'.
//
// El AdBlue en B.Smart se despacha desde la bomba "Urea Norte 1" (serial
// 24040081). Se asigna a una bomba exclusiva en `diesel_pumps`
// (totem_id = 'BSMART-24040081', type = 'ADBLUE'), que el script crea si no
// existe (insert idempotente).
//
// Modo automático (default):
//   Lee MAX(date) de las cargas BSMART y procesa desde ultima_fecha hasta AYER
//   (zona America/Mexico_City). Si no hay cargas previas, procesa solo "ayer".
//
// Modo manual:
//   --from YYYY-MM-DD --to YYYY-MM-DD para cubrir un rango específico (backfill).
//
// Día operativo:
//   Igual que el flujo de diesel: de 03:00 a 03:00 hora Guadalajara (UTC-6).
//   El filtro a B.Smart se hace en UTC.
//
// Idempotencia:
//   No hay constraint único en supramax_diesel_charges, así que se filtran en
//   código los transaction_id ya guardados con provider='BSMART'. Re-correr el
//   mismo rango NO duplica. El (sale_id, provider) nunca colisiona con Tothem.
//
// Rate limit B.Smart: 10 req/min, 50 req/día. Cada día procesado = 1 request
// (el token se reusa). Mantener los rangos chicos en corridas diarias.
// =============================================================================

import postgres from "postgres";
import { config } from "dotenv";

config({ path: process.env.DOTENV_CONFIG_PATH || ".env.development" });

// ----------------------------------------------------------------------------
// CONFIGURACIÓN
// ----------------------------------------------------------------------------

const BSMART_HOST = (process.env.BSMART_HOST || "https://apibsmartexport.piusi.com").replace(/\/$/, "");
const BSMART_CLIENT_ID = process.env.BSMART_CLIENT_ID || "";
const BSMART_CLIENT_SECRET = process.env.BSMART_CLIENT_SECRET || "";

// Bomba exclusiva para las cargas de B.Smart.
const ADBLUE_PUMP_TOTEM_ID = process.env.ADBLUE_PUMP_TOTEM_ID || "BSMART-24040081";
const ADBLUE_PUMP_FIELD = process.env.ADBLUE_PUMP_FIELD || "NORTE";

// Guadalajara es UTC-6 todo el año (sin horario de verano).
const GUADALAJARA_UTC_OFFSET_HOURS = -6;

// Máximo de items que devuelve este endpoint de B.Smart por llamada.
const PAGE_SIZE = 1000;

// Reintentos para errores transitorios del API.
const MAX_RETRIES = Number(process.env.SYNC_ADBLUE_MAX_RETRIES || 3);
const RETRY_BASE_MS = Number(process.env.SYNC_ADBLUE_RETRY_BASE_MS || 1000);

// Pausa entre días (respetar el rate limit de 10 req/min de B.Smart).
const PER_DAY_DELAY_MS = Number(process.env.SYNC_ADBLUE_PER_DAY_DELAY_MS || 1500);

if (!BSMART_CLIENT_ID || !BSMART_CLIENT_SECRET) {
  console.error("[sync-adblue] Faltan BSMART_CLIENT_ID / BSMART_CLIENT_SECRET");
  process.exit(1);
}

if (!process.env.DATABASE_POOLER_URL) {
  console.error("[sync-adblue] Falta DATABASE_POOLER_URL");
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

/** YYYY-MM-DD del día actual en zona America/Mexico_City. */
function todayInMx() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

/** Suma `n` días a un YYYY-MM-DD. */
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Array de YYYY-MM-DD entre from y to inclusive. */
function dateRange(from, to) {
  const out = [];
  let cursor = from;
  while (cursor <= to) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/**
 * Rango UTC del día operativo (03:00 -> 03:00 Guadalajara) para un YYYY-MM-DD.
 * Ese día a las 03:00 GDL hasta el día siguiente 02:59:59 GDL, en UTC.
 */
function operationalRangeUTC(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const startUTCms = Date.UTC(y, m - 1, d, 3 - GUADALAJARA_UTC_OFFSET_HOURS, 0, 0);
  const endUTCms = Date.UTC(y, m - 1, d + 1, 2 - GUADALAJARA_UTC_OFFSET_HOURS, 59, 59);
  return {
    startISO: new Date(startUTCms).toISOString(),
    endISO: new Date(endUTCms).toISOString(),
  };
}

function logInfo(msg) {
  console.log(`[sync-adblue] ${msg}`);
}
function logWarn(msg) {
  console.log(`[sync-adblue] ⚠️  ${msg}`);
}
function logError(msg) {
  console.error(`[sync-adblue] ❌ ${msg}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ----------------------------------------------------------------------------
// CLIENTE B.SMART (login compartido + reintento en 401)
// ----------------------------------------------------------------------------

let _accessToken = null;
let _loginPromise = null;

async function loginBsmart() {
  if (_loginPromise) return _loginPromise;

  _loginPromise = (async () => {
    const res = await fetch(`${BSMART_HOST}/api/Auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: BSMART_CLIENT_ID,
        client_secret: BSMART_CLIENT_SECRET,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Login B.Smart fallo (${res.status}): ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    if (!data?.access_token) throw new Error("Login B.Smart no devolvió access_token");
    _accessToken = data.access_token;
    return _accessToken;
  })();

  try {
    return await _loginPromise;
  } finally {
    _loginPromise = null;
  }
}

async function fetchTransactions(startISO, endISO) {
  if (!_accessToken) await loginBsmart();

  const url = `${BSMART_HOST}/api/v1/Transactions/0/${PAGE_SIZE}`;
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${_accessToken}`,
        },
        body: JSON.stringify({ start_date: startISO, end_date: endISO }),
      });

      // Token expirado: refrescar y reintentar sin contar el intento.
      if (res.status === 401) {
        _accessToken = null;
        await loginBsmart();
        continue;
      }

      // 429/5xx: transitorio → backoff.
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const txt = await res.text().catch(() => "");
        lastError = new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Transactions fallo (${res.status}): ${txt.slice(0, 200)}`);
      }

      const json = await res.json();
      return Array.isArray(json) ? json : [];
    } catch (err) {
      lastError = err;
      const isNetworkError =
        err?.cause?.code === "ECONNRESET" ||
        err?.cause?.code === "ETIMEDOUT" ||
        err?.cause?.code === "UND_ERR_SOCKET" ||
        /fetch failed/i.test(err?.message || "");
      if (isNetworkError && attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("fetchTransactions agotó reintentos");
}

// ----------------------------------------------------------------------------
// SETUP DB: bomba exclusiva + mapa de unidades
// ----------------------------------------------------------------------------

/** Crea (si no existe) la bomba de B.Smart y devuelve su id. */
async function ensureAdbluePump() {
  await sql`
    INSERT INTO diesel_pumps (totem_id, field, pump_number, type, active, created_at)
    SELECT ${ADBLUE_PUMP_TOTEM_ID}, ${ADBLUE_PUMP_FIELD}, 1, 'ADBLUE', 1, now()
    WHERE NOT EXISTS (
      SELECT 1 FROM diesel_pumps WHERE totem_id = ${ADBLUE_PUMP_TOTEM_ID}
    )
  `;
  const rows = await sql`
    SELECT id FROM diesel_pumps WHERE totem_id = ${ADBLUE_PUMP_TOTEM_ID} LIMIT 1
  `;
  if (!rows[0]?.id) throw new Error("No se pudo resolver la bomba de B.Smart");
  return rows[0].id;
}

/** Mapa eco_number -> unit_id (match 1:1 con registration_number de B.Smart). */
async function loadUnitsByEco() {
  const rows = await sql`SELECT id, eco_number FROM units WHERE eco_number IS NOT NULL`;
  const map = new Map();
  for (const r of rows) map.set(r.eco_number.trim(), r.id);
  return map;
}

// ----------------------------------------------------------------------------
// MAPEO API → DB
// ----------------------------------------------------------------------------

function isRealCharge(tx) {
  const reg = (tx.registration_number || "").trim();
  return (
    tx.type === "STANDARD" &&
    tx.status !== "O_DELETED" &&
    reg.length > 0 &&
    reg.toUpperCase() !== "PRUEBA"
  );
}

function mapCharge(tx, unitsByEco, pumpId) {
  const eco = (tx.registration_number || "").trim();
  // transaction_date viene como "2026-06-08T05:23:00" (UTC, sin Z).
  const txDate = new Date(`${tx.transaction_date}Z`);
  const operationalDate = new Date(txDate.getTime() - 3 * 3600 * 1000);

  return {
    sale_id: tx.transaction_id,
    unit_id: unitsByEco.get(eco) ?? null,
    diesel_pump_id: pumpId,
    odometer: 0,
    liters: tx.quantity ?? 0,
    amount: 0,
    date: tx.transaction_date ? tx.transaction_date.slice(0, 10) : null,
    start_hour: tx.transaction_date ? tx.transaction_date.slice(11, 19) : null,
    end_hour: tx.transaction_date ? tx.transaction_date.slice(11, 19) : null,
    start_operational_date: operationalDate.toISOString(),
    end_operational_date: operationalDate.toISOString(),
    start_date: txDate.toISOString(),
    end_date: txDate.toISOString(),
    provider: "BSMART",
  };
}

// ----------------------------------------------------------------------------
// PROCESO POR DÍA OPERATIVO
// ----------------------------------------------------------------------------

async function processDay(dateStr, unitsByEco, pumpId) {
  const { startISO, endISO } = operationalRangeUTC(dateStr);
  const txs = await fetchTransactions(startISO, endISO);

  const real = txs.filter(isRealCharge);
  if (real.length === 0) {
    return { date: dateStr, fetched: txs.length, valid: 0, inserted: 0, skipped: 0, unmatched: [] };
  }

  // Idempotencia: descartar transaction_id ya guardados (provider='BSMART').
  const incomingIds = real.map((tx) => tx.transaction_id);
  const existing = await sql`
    SELECT sale_id FROM supramax_diesel_charges
    WHERE provider = 'BSMART' AND sale_id = ANY(${incomingIds})
  `;
  const existingSet = new Set(existing.map((r) => r.sale_id));

  const toInsert = real
    .filter((tx) => !existingSet.has(tx.transaction_id))
    .map((tx) => mapCharge(tx, unitsByEco, pumpId));

  const unmatched = [
    ...new Set(
      toInsert.filter((c) => c.unit_id === null).map((c) => {
        const tx = real.find((t) => t.transaction_id === c.sale_id);
        return tx?.registration_number;
      })
    ),
  ];

  let inserted = 0;
  if (toInsert.length > 0) {
    const result = await sql`
      INSERT INTO supramax_diesel_charges ${sql(
        toInsert,
        "sale_id",
        "unit_id",
        "diesel_pump_id",
        "odometer",
        "liters",
        "amount",
        "date",
        "start_hour",
        "end_hour",
        "start_operational_date",
        "end_operational_date",
        "start_date",
        "end_date",
        "provider"
      )}
    `;
    inserted = result.count ?? 0;
  }

  return {
    date: dateStr,
    fetched: txs.length,
    valid: real.length,
    inserted,
    skipped: real.length - toInsert.length,
    unmatched,
  };
}

// ----------------------------------------------------------------------------
// CÁLCULO DE RANGO AUTOMÁTICO
// ----------------------------------------------------------------------------

async function computeAutoRange() {
  const rows = await sql`
    SELECT MAX(date)::text AS last_date
    FROM supramax_diesel_charges
    WHERE provider = 'BSMART'
  `;
  const lastDate = rows[0]?.last_date ?? null;
  const yesterday = addDays(todayInMx(), -1);

  if (!lastDate) {
    return { from: yesterday, to: yesterday, lastDate: null, empty: true };
  }

  // Reprocesar desde el último día guardado (idempotente) por si quedó parcial.
  const from = lastDate > yesterday ? yesterday : lastDate;
  return { from, to: yesterday, lastDate, empty: false, upToDate: from > yesterday };
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();

  const cliFrom = getArg("from");
  const cliTo = getArg("to");

  let fromDate;
  let toDate;
  let mode;
  const warnings = [];

  if (cliFrom || cliTo) {
    fromDate = cliFrom || cliTo;
    toDate = cliTo || cliFrom;
    mode = "manual";
    if (fromDate > toDate) {
      logError(`Rango invalido: from=${fromDate} > to=${toDate}`);
      await sql.end();
      process.exit(1);
    }
    logInfo(`Modo manual — rango ${fromDate} → ${toDate}`);
  } else {
    mode = "auto";
    const auto = await computeAutoRange();
    if (auto.empty) {
      const yesterday = addDays(todayInMx(), -1);
      fromDate = yesterday;
      toDate = yesterday;
      const warn = `No hay cargas BSMART previas. Procesando solo ${yesterday}. Para backfill corre manual con --from/--to.`;
      logWarn(warn);
      warnings.push(warn);
    } else if (auto.upToDate) {
      logInfo(`Última carga BSMART: ${auto.lastDate}. Sin días pendientes (hasta ayer ${auto.to}).`);
      const summary = {
        script: "sync-adblue",
        mode,
        last_synced_date: auto.lastDate,
        from: null,
        to: null,
        days: 0,
        fetched: 0,
        valid: 0,
        inserted: 0,
        skipped: 0,
        errors: 0,
        unmatched: [],
        warnings,
        elapsed_seconds: Math.round((Date.now() - t0) / 1000),
      };
      console.log(`::SUMMARY_JSON::${JSON.stringify(summary)}`);
      logInfo("Nada que sincronizar.");
      await sql.end();
      return;
    } else {
      fromDate = auto.from;
      toDate = auto.to;
      logInfo(`Modo auto — última carga: ${auto.lastDate}. Procesando ${fromDate} → ${toDate}`);
    }
  }

  const days = dateRange(fromDate, toDate);
  logInfo(`B.Smart: ${BSMART_HOST}  días=${days.length}`);

  if (days.length > 30) {
    const warn = `Procesando ${days.length} días (>30). Ojo con el límite de 50 req/día de B.Smart.`;
    logWarn(warn);
    warnings.push(warn);
  }

  // Setup DB + login antes de procesar.
  await loginBsmart();
  const pumpId = await ensureAdbluePump();
  const unitsByEco = await loadUnitsByEco();
  logInfo(`Bomba B.Smart id=${pumpId}  unidades cargadas=${unitsByEco.size}`);

  // Procesar días en serie (respeta el rate limit de B.Smart).
  const results = [];
  let firstError = null;
  for (const day of days) {
    try {
      const r = await processDay(day, unitsByEco, pumpId);
      logInfo(`  ${r.date}  fetched=${r.fetched}  valid=${r.valid}  inserted=${r.inserted}  skipped=${r.skipped}`);
      results.push(r);
    } catch (err) {
      const msg = err?.message || String(err);
      logError(`  ${day}  ERROR: ${msg}`);
      if (!firstError) firstError = msg;
      results.push({ date: day, error: msg });
    }
    if (PER_DAY_DELAY_MS > 0) await sleep(PER_DAY_DELAY_MS);
  }

  let totalFetched = 0;
  let totalValid = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  let errorCount = 0;
  const allUnmatched = new Set();

  for (const r of results) {
    if (r.error) {
      errorCount++;
      continue;
    }
    totalFetched += r.fetched ?? 0;
    totalValid += r.valid ?? 0;
    totalInserted += r.inserted ?? 0;
    totalSkipped += r.skipped ?? 0;
    (r.unmatched ?? []).forEach((u) => u && allUnmatched.add(u));
  }

  const elapsedSeconds = Math.round((Date.now() - t0) / 1000);

  const summary = {
    script: "sync-adblue",
    mode,
    from: fromDate,
    to: toDate,
    days: days.length,
    fetched: totalFetched,
    valid: totalValid,
    inserted: totalInserted,
    skipped: totalSkipped,
    errors: errorCount,
    unmatched: [...allUnmatched],
    warnings,
    elapsed_seconds: elapsedSeconds,
  };

  console.log(`::SUMMARY_JSON::${JSON.stringify(summary)}`);
  logInfo(
    `Tiempo total: ${elapsedSeconds}s — días=${summary.days} fetched=${totalFetched} inserted=${totalInserted} skipped=${totalSkipped} errors=${errorCount} unmatched=${allUnmatched.size}`
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
