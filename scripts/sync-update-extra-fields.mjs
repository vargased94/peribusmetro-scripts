/**
 * Re-sincroniza los campos extra (CTEXTOEXTRA1, CTEXTOEXTRA2, CTEXTOEXTRA3) de admDocumentos
 * desde SQL Server hacia Supabase. Solo actualiza documentos que ya existen en Supabase
 * pero tienen los campos extra vacíos mientras que en SQL Server sí tienen datos.
 *
 * DOTENV_CONFIG_PATH=.env.development node --env-file=.env.development scripts/sync-update-extra-fields.mjs
 */

import sqlServer from "mssql";
import postgres from "postgres";
import { config } from "dotenv";

config({ path: process.env.DOTENV_CONFIG_PATH || ".env.development" });

const host = process.env.SQL_SERVER_HOST;
const sqlConfig = {
  server: host.includes("\\") ? host.split("\\")[0] : host,
  ...(host.includes("\\")
    ? { options: { instanceName: host.split("\\")[1], encrypt: false, trustServerCertificate: true } }
    : { port: parseInt(process.env.SQL_SERVER_PORT), options: { encrypt: false, trustServerCertificate: true } }),
  user: process.env.SQL_SERVER_USER,
  password: process.env.SQL_SERVER_PASSWORD,
  database: "adPERIBUS_METROPOLITAN",
  connectionTimeout: 30000,
  requestTimeout: 120000,
};

const supabase = postgres(process.env.DATABASE_POOLER_URL, {
  ssl: "require",
  prepare: false,
  max: 1,
});

async function main() {
  const start = Date.now();
  console.log("═══════════════════════════════════════════════════");
  console.log("  Re-sync campos extra admDocumentos");
  console.log(`  ${new Date().toLocaleString("es-MX")}`);
  console.log("═══════════════════════════════════════════════════");

  const pool = await sqlServer.connect(sqlConfig);
  console.log("Conectado a SQL Server\n");

  // 1. Traer todos los docs de SQL Server que tienen algún campo extra
  console.log("Obteniendo docs con campos extra de SQL Server...");
  const sqlResult = await pool.request().query(`
    SELECT CIDDOCUMENTO, CTEXTOEXTRA1, CTEXTOEXTRA2, CTEXTOEXTRA3
    FROM admDocumentos
    WHERE (CTEXTOEXTRA1 IS NOT NULL AND CTEXTOEXTRA1 != '')
       OR (CTEXTOEXTRA2 IS NOT NULL AND CTEXTOEXTRA2 != '')
       OR (CTEXTOEXTRA3 IS NOT NULL AND CTEXTOEXTRA3 != '')
  `);
  const sqlDocs = sqlResult.recordset;
  console.log(`  Docs con campos extra en SQL Server: ${sqlDocs.length}`);

  // 2. Traer estado actual en Supabase con 1 sola query
  console.log("Obteniendo estado actual en Supabase...");
  const pgRows = await supabase.unsafe(
    `SELECT document_id, extra_text_one, extra_text_two, extra_text_three
     FROM comercial_adm_documents`
  );
  const pgMap = new Map();
  for (const r of pgRows) pgMap.set(r.document_id, r);
  console.log(`  Docs en Supabase: ${pgRows.length}`);

  // 3. Filtrar en memoria los que realmente difieren
  const norm = (v) => (v ?? "").trim();
  const toUpdate = [];
  for (const doc of sqlDocs) {
    const existing = pgMap.get(doc.CIDDOCUMENTO);
    if (!existing) continue; // no está en Supabase
    const nextOne = doc.CTEXTOEXTRA1 || null;
    const nextTwo = doc.CTEXTOEXTRA2 || null;
    const nextThree = doc.CTEXTOEXTRA3 || null;
    if (
      norm(existing.extra_text_one) !== norm(nextOne) ||
      norm(existing.extra_text_two) !== norm(nextTwo) ||
      norm(existing.extra_text_three) !== norm(nextThree)
    ) {
      toUpdate.push({
        document_id: doc.CIDDOCUMENTO,
        extra_text_one: nextOne,
        extra_text_two: nextTwo,
        extra_text_three: nextThree,
      });
    }
  }
  console.log(`  A actualizar: ${toUpdate.length}`);

  if (toUpdate.length === 0) {
    console.log("\nNada que actualizar.");
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const summary = {
      script: "sync-update-extra-fields",
      elapsed_seconds: Number(elapsed),
      candidates: 0,
      updated: 0,
      errors: 0,
    };
    console.log(`::SUMMARY_JSON::${JSON.stringify(summary)}`);
    await pool.close();
    await supabase.end();
    return;
  }

  // 4. Bulk UPDATE ... FROM (VALUES ...) por chunks
  let updated = 0;
  let errors = 0;
  const CHUNK = 500;
  for (let i = 0; i < toUpdate.length; i += CHUNK) {
    const slice = toUpdate.slice(i, i + CHUNK);
    const params = [];
    const tuples = [];
    let p = 1;
    for (const row of slice) {
      tuples.push(`($${p++}::int, $${p++}::text, $${p++}::text, $${p++}::text)`);
      params.push(row.document_id, row.extra_text_one, row.extra_text_two, row.extra_text_three);
    }
    const query = `
      UPDATE comercial_adm_documents AS t
      SET extra_text_one = v.extra_text_one,
          extra_text_two = v.extra_text_two,
          extra_text_three = v.extra_text_three
      FROM (VALUES ${tuples.join(", ")}) AS v(document_id, extra_text_one, extra_text_two, extra_text_three)
      WHERE t.document_id = v.document_id`;
    try {
      const res = await supabase.unsafe(query, params);
      updated += res.count ?? slice.length;
    } catch (err) {
      errors += slice.length;
      if (errors <= CHUNK * 3) console.error(`  Error chunk ${i}-${i + slice.length}: ${err.message}`);
    }
    const progress = Math.min(i + CHUNK, toUpdate.length);
    process.stdout.write(`\r  Procesados: ${progress}/${toUpdate.length} | Actualizados: ${updated} | Errores: ${errors}`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log("\n");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Actualizados: ${updated}`);
  console.log(`  Errores: ${errors}`);
  console.log(`  Tiempo total: ${elapsed}s`);
  console.log("═══════════════════════════════════════════════════");

  const summary = {
    script: "sync-update-extra-fields",
    elapsed_seconds: Number(elapsed),
    candidates: toUpdate.length,
    updated,
    errors,
  };
  console.log(`::SUMMARY_JSON::${JSON.stringify(summary)}`);

  await pool.close();
  await supabase.end();
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
