// =============================================================================
// cleanup-bad-tank-hours.mjs
//
// Borra filas de `diesel_tank_monitoring` con `hour` mal formateado, producto
// de un bug previo en sync-tank-monitoring.mjs que truncaba "HH:MM" → "HH:N:".
//
// Las filas válidas tienen hour exactamente con patrón "HH:MM" (5 chars,
// dos dígitos, dos puntos, dos dígitos).
// Las inválidas terminan con `:` en posición 4 → patrón regex: ^[0-9]{2}:[0-9]:$
//
// Uso:
//   # Dry-run (default) — solo cuenta filas afectadas, NO borra nada
//   node --env-file=.env.development scripts/cleanup-bad-tank-hours.mjs
//
//   # Ejecutar borrado real
//   node --env-file=.env.development scripts/cleanup-bad-tank-hours.mjs --execute
//
// Importante:
//   - Por defecto NO borra. Hay que pasar --execute explícito.
//   - Idempotente: correrlo dos veces no hace daño (la segunda no encuentra nada).
// =============================================================================

import postgres from "postgres";
import { config } from "dotenv";

config({ path: process.env.DOTENV_CONFIG_PATH || ".env.development" });

if (!process.env.DATABASE_POOLER_URL) {
  console.error("[cleanup-bad-tank-hours] Falta DATABASE_POOLER_URL");
  process.exit(1);
}

const EXECUTE = process.argv.includes("--execute");

const sql = postgres(process.env.DATABASE_POOLER_URL, {
  ssl: "require",
  prepare: false,
  max: 1,
});

// Patrón regex: hour mal formateada = exactamente "HH:N:" (5 chars con `:` final)
// Esto solo matchea filas con el bug; las correctas "HH:MM" no caen aquí.
const BAD_HOUR_REGEX = "^[0-9]{2}:[0-9]:$";

async function main() {
  console.log(`[cleanup-bad-tank-hours] DB: ${maskUrl(process.env.DATABASE_POOLER_URL)}`);
  console.log(`[cleanup-bad-tank-hours] Modo: ${EXECUTE ? "EXECUTE (borrado real)" : "DRY-RUN (sin cambios)"}`);
  console.log("");

  // Contar filas afectadas
  const countRows = await sql`
    SELECT COUNT(*)::int AS total
    FROM diesel_tank_monitoring
    WHERE hour ~ ${BAD_HOUR_REGEX}
  `;
  const total = countRows[0]?.total ?? 0;

  console.log(`[cleanup-bad-tank-hours] Filas con hour mal formateada: ${total}`);

  if (total === 0) {
    console.log("[cleanup-bad-tank-hours] Nada que limpiar. ✅");
    await sql.end();
    return;
  }

  // Mostrar muestra de filas afectadas
  const sample = await sql`
    SELECT id, date, hour, tank_number, created_at
    FROM diesel_tank_monitoring
    WHERE hour ~ ${BAD_HOUR_REGEX}
    ORDER BY id DESC
    LIMIT 5
  `;
  console.log("[cleanup-bad-tank-hours] Muestra (5 más recientes):");
  for (const r of sample) {
    console.log(`  id=${r.id}  date=${r.date}  hour="${r.hour}"  tank=${r.tank_number}  created_at=${r.created_at}`);
  }
  console.log("");

  // Distribución por fecha
  const byDate = await sql`
    SELECT date, COUNT(*)::int AS rows
    FROM diesel_tank_monitoring
    WHERE hour ~ ${BAD_HOUR_REGEX}
    GROUP BY date
    ORDER BY date
  `;
  console.log(`[cleanup-bad-tank-hours] Distribución por fecha (${byDate.length} días afectados):`);
  console.log(`  Primer día: ${byDate[0]?.date}`);
  console.log(`  Último día: ${byDate[byDate.length - 1]?.date}`);
  const minRows = Math.min(...byDate.map((r) => r.rows));
  const maxRows = Math.max(...byDate.map((r) => r.rows));
  console.log(`  Filas/día: min=${minRows}  max=${maxRows}`);
  console.log("");

  if (!EXECUTE) {
    console.log("[cleanup-bad-tank-hours] DRY-RUN: no se borró nada.");
    console.log("[cleanup-bad-tank-hours] Para ejecutar el borrado real, vuelve a correr con --execute");
    await sql.end();
    return;
  }

  // EXECUTE
  console.log("[cleanup-bad-tank-hours] Borrando...");
  const t0 = Date.now();
  const result = await sql`
    DELETE FROM diesel_tank_monitoring
    WHERE hour ~ ${BAD_HOUR_REGEX}
  `;
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`[cleanup-bad-tank-hours] ✅ Borradas ${result.count} filas en ${elapsed}s.`);
  console.log("[cleanup-bad-tank-hours] Ahora puedes volver a correr el workflow de sync para re-insertar correctamente.");

  await sql.end();
}

function maskUrl(url) {
  return url.replace(/:[^:@/]+@/, ":***@");
}

main().catch(async (err) => {
  console.error(`[cleanup-bad-tank-hours] ❌ Fatal: ${err?.message || err}`);
  try { await sql.end(); } catch {}
  process.exit(1);
});
