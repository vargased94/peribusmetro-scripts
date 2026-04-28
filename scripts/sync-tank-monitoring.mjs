// =============================================================================
// sync-tank-monitoring.mjs
//
// Sincroniza lecturas del API Tothem (sitio 130 - monitoreo) hacia la tabla
// `diesel_tank_monitoring` en Supabase.
//
// Modo automático (default):
//   Lee MAX(date) en diesel_tank_monitoring y procesa desde
//   ultima_fecha + 1 hasta AYER (zona America/Mexico_City).
//   Si la tabla está vacía, hace fallback a "ayer" y deja warning para que
//   el operador dispare el backfill grande manualmente.
//
// Modo manual:
//   --from YYYY-MM-DD --to YYYY-MM-DD para cubrir un rango específico.
//
// Eficiencia:
//   - Concurrencia limitada (CONCURRENCY = 3 fetches simultáneos al API).
//   - Reintentos con backoff exponencial en errores 5xx / red.
//   - Un solo INSERT por día (chunks de 500 filas máximo).
//   - Idempotente: ON CONFLICT (date, hour, tank_number) DO NOTHING.
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

// Concurrencia: máximo de fetches al API en paralelo. 3 es conservador y
// evita saturar Tothem cuando hay backfills grandes.
const CONCURRENCY = Number(process.env.SYNC_TANKS_CONCURRENCY || 3);

// Reintentos para errores transitorios del API
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000; // 1s, 2s, 4s

// Tamaño máximo de filas por INSERT (chunk del pooler)
const INSERT_CHUNK = 500;

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

/** Genera array de YYYY-MM-DD entre from y to inclusive. */
function dateRange(from, to) {
  const out = [];
  let cursor = from;
  while (cursor <= to) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

function logInfo(msg) {
  console.log(`[sync-tank-monitoring] ${msg}`);
}

function logWarn(msg) {
  console.log(`[sync-tank-monitoring] ⚠️  ${msg}`);
}

function logError(msg) {
  console.error(`[sync-tank-monitoring] ❌ ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ----------------------------------------------------------------------------
// CLIENTE TOTHEM (con login compartido y reintento en 401)
// ----------------------------------------------------------------------------

let _accessToken = null;
let _loginPromise = null;

async function loginTothem() {
  // Si ya hay un login en curso, esperarlo en vez de duplicar la petición.
  if (_loginPromise) return _loginPromise;

  _loginPromise = (async () => {
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
  })();

  try {
    return await _loginPromise;
  } finally {
    _loginPromise = null;
  }
}

async function fetchMonitoring(fechaInicial, fechaFinal) {
  if (!_accessToken) await loginTothem();

  const url = new URL(`${TOTHEM_HOST}/sitio/${SITIO}/monitoreo`);
  url.searchParams.append("fecha_inicial", fechaInicial);
  url.searchParams.append("fecha_final", fechaFinal);
  url.searchParams.append("orden", "1");

  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${_accessToken}` },
      });

      // Token expirado: refrescar y reintentar este mismo intento sin contar
      if (res.status === 401) {
        _accessToken = null;
        await loginTothem();
        continue;
      }

      // 429/5xx: error transitorio → backoff
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const txt = await res.text().catch(() => "");
        lastError = new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * Math.pow(2, attempt);
          await sleep(delay);
          continue;
        }
        throw lastError;
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Monitoreo fallo (${res.status}): ${txt.slice(0, 200)}`);
      }

      const json = await res.json();
      return Array.isArray(json?.data) ? json.data : [];
    } catch (err) {
      // Error de red: reintentar con backoff
      lastError = err;
      const isNetworkError =
        err?.cause?.code === "ECONNRESET" ||
        err?.cause?.code === "ETIMEDOUT" ||
        err?.cause?.code === "UND_ERR_SOCKET" ||
        /fetch failed/i.test(err?.message || "");
      if (isNetworkError && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("fetchMonitoring agotó reintentos");
}

// ----------------------------------------------------------------------------
// MAPEO API → DB
// ----------------------------------------------------------------------------

/**
 * Normaliza la hora del API Tothem a formato HH:MM (5 chars).
 * El API devuelve "HH:MM" directamente, pero por robustez aceptamos también
 * formato compacto "HHmmss" / "HHmm" / "Hmmss" por si cambia.
 */
function normalizeHour(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();

  // Caso normal: ya viene "HH:MM" o "HH:MM:SS"
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    return s.slice(0, 5);
  }

  // Caso legacy: solo dígitos (HHmmss / HHmm / Hmmss)
  if (/^\d+$/.test(s)) {
    const padded = s.padStart(6, "0");
    return `${padded.slice(0, 2)}:${padded.slice(2, 4)}`;
  }

  return null;
}

function mapReading(row) {
  const hour = normalizeHour(row?.hora);

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
    /^\d{2}:\d{2}$/.test(r.hour) && // formato estricto HH:MM
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
  const onlyForDay = mapped.filter((r) => r.date === dateStr);

  if (onlyForDay.length === 0) {
    return { date: dateStr, fetched: apiRows.length, valid: 0, inserted: 0, skipped: 0 };
  }

  let inserted = 0;
  for (let i = 0; i < onlyForDay.length; i += INSERT_CHUNK) {
    const chunk = onlyForDay.slice(i, i + INSERT_CHUNK);
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

  return {
    date: dateStr,
    fetched: apiRows.length,
    valid: onlyForDay.length,
    inserted,
    skipped: onlyForDay.length - inserted,
  };
}

// ----------------------------------------------------------------------------
// EJECUTOR CON CONCURRENCIA LIMITADA
// ----------------------------------------------------------------------------

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const inFlight = [];

  async function next() {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        results[idx] = { error: err?.message || String(err), item: items[idx] };
      }
    }
  }

  for (let i = 0; i < Math.min(limit, items.length); i++) {
    inFlight.push(next());
  }
  await Promise.all(inFlight);
  return results;
}

// ----------------------------------------------------------------------------
// CÁLCULO DE RANGO AUTOMÁTICO
// ----------------------------------------------------------------------------

async function computeAutoRange() {
  const rows = await sql`
    SELECT MAX(date)::text AS last_date
    FROM diesel_tank_monitoring
    WHERE active = 1
  `;
  const lastDate = rows[0]?.last_date ?? null;
  const yesterday = addDays(todayInMx(), -1);

  if (!lastDate) {
    return {
      from: yesterday,
      to: yesterday,
      lastDate: null,
      empty: true,
    };
  }

  const from = addDays(lastDate, 1);
  return {
    from,
    to: yesterday,
    lastDate,
    empty: false,
    upToDate: from > yesterday,
  };
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
  let warnings = [];

  if (cliFrom || cliTo) {
    // Modo manual
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
    // Modo auto
    mode = "auto";
    const auto = await computeAutoRange();
    if (auto.empty) {
      const yesterday = addDays(todayInMx(), -1);
      fromDate = yesterday;
      toDate = yesterday;
      const warn =
        `La tabla diesel_tank_monitoring está vacía. ` +
        `Procesando solo ${yesterday}. Para backfill histórico corre manual con --from/--to.`;
      logWarn(warn);
      warnings.push(warn);
    } else if (auto.upToDate) {
      logInfo(
        `Última sincronización: ${auto.lastDate}. Sin días pendientes (hasta ayer ${auto.to}).`
      );
      const summary = {
        script: "sync-tank-monitoring",
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
      logInfo(
        `Modo auto — última sincronización: ${auto.lastDate}. Procesando ${fromDate} → ${toDate}`
      );
    }
  }

  const days = dateRange(fromDate, toDate);
  logInfo(
    `Tothem: ${TOTHEM_HOST}  sitio=${SITIO}  días=${days.length}  concurrencia=${CONCURRENCY}`
  );

  if (days.length > 7) {
    const warn = `Procesando ${days.length} días en una sola corrida (>7). Si el API rate-limita, partir en bloques manuales.`;
    logWarn(warn);
    warnings.push(warn);
  }

  // Asegurar login antes del fan-out (evita N logins simultáneos)
  await loginTothem();

  const results = await runWithConcurrency(days, CONCURRENCY, async (day) => {
    try {
      const r = await processDay(day);
      logInfo(
        `  ${r.date}  fetched=${r.fetched}  valid=${r.valid}  inserted=${r.inserted}  skipped=${r.skipped}`
      );
      return r;
    } catch (err) {
      const msg = err?.message || String(err);
      logError(`  ${day}  ERROR: ${msg}`);
      return { date: day, error: msg };
    }
  });

  // Ordenar por fecha (la concurrencia los puede regresar fuera de orden)
  results.sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  let totalFetched = 0;
  let totalValid = 0;
  let totalInserted = 0;
  let totalSkipped = 0;
  let errorCount = 0;
  let firstError = null;

  for (const r of results) {
    if (r.error) {
      errorCount++;
      if (!firstError) firstError = r.error;
      continue;
    }
    totalFetched += r.fetched ?? 0;
    totalValid += r.valid ?? 0;
    totalInserted += r.inserted ?? 0;
    totalSkipped += r.skipped ?? 0;
  }

  const elapsedSeconds = Math.round((Date.now() - t0) / 1000);

  const summary = {
    script: "sync-tank-monitoring",
    mode,
    last_synced_date: mode === "auto" ? (await sql`
      SELECT MAX(date)::text AS d FROM diesel_tank_monitoring WHERE active = 1
    `)[0]?.d ?? null : null,
    from: fromDate,
    to: toDate,
    days: days.length,
    fetched: totalFetched,
    valid: totalValid,
    inserted: totalInserted,
    skipped: totalSkipped,
    errors: errorCount,
    warnings,
    elapsed_seconds: elapsedSeconds,
  };

  console.log(`::SUMMARY_JSON::${JSON.stringify(summary)}`);
  logInfo(
    `Tiempo total: ${elapsedSeconds}s — días=${summary.days} fetched=${totalFetched} inserted=${totalInserted} skipped=${totalSkipped} errors=${errorCount}`
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
