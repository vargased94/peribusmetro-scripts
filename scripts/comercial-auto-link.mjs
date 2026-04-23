/**
 * Auto-link comercial — Fases 2 y 3
 *
 * Vincula documentos y movimientos de AdminPAQ (comercial_adm_*) con mantenimientos,
 * accidentes y unidades de forma automática en base a patrones de texto.
 *
 * Versión portable sin Drizzle. Usa la librería `postgres` igual que el resto
 * de scripts del repo. El SQL es idéntico al original en
 * peribus-incidents-admin/features/comercial/api/actions/auto-link-{documents,movements}.ts
 *
 * Uso:
 *   DOTENV_CONFIG_PATH=.env.development node --env-file=.env.development scripts/comercial-auto-link.mjs
 *   DOTENV_CONFIG_PATH=.env.production  node --env-file=.env.production  scripts/comercial-auto-link.mjs
 */

import postgres from "postgres";
import { config } from "dotenv";

config({ path: process.env.DOTENV_CONFIG_PATH || ".env.development" });

const sql = postgres(process.env.DATABASE_POOLER_URL, {
  ssl: "require",
  prepare: false,
  max: 1,
});

// ============================================================
// AUTO-LINK DOCUMENTOS (5 pasos)
// ============================================================

async function autoLinkDocuments() {
  const result = {
    exact_m: 0,
    exact_s: 0,
    normalized_m: 0,
    normalized_s: 0,
    multiple_folios: 0,
    errors: [],
  };

  // Paso 1: Match exacto M-YYMMDD-N → maintenances
  try {
    const rows = await sql.unsafe(`
      INSERT INTO comercial_document_links (document_id, link_type, maintenance_id, linked_pid, match_method, confidence)
      SELECT DISTINCT
        d.document_id, 'maintenance', m.id, d.extra_text_three, 'auto_exact', 'high'
      FROM comercial_adm_documents d
      INNER JOIN maintenances m ON m.pid = d.extra_text_three AND m.active = 1
      WHERE d.active = 1
        AND d.extra_text_three ~ '^M-\\d{6}-\\d+$'
        AND NOT EXISTS (
          SELECT 1 FROM comercial_document_links cdl
          WHERE cdl.document_id = d.document_id AND cdl.maintenance_id = m.id AND cdl.active = 1
        )
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    result.exact_m = rows.length;
  } catch (e) {
    result.errors.push(`Paso 1 (M- exacto): ${e?.message}`);
  }

  // Paso 2: Match exacto S-YYMMDD-N → accidents
  try {
    const rows = await sql.unsafe(`
      INSERT INTO comercial_document_links (document_id, link_type, accident_id, linked_pid, match_method, confidence)
      SELECT DISTINCT
        d.document_id, 'accident', a.id, d.extra_text_three, 'auto_exact', 'high'
      FROM comercial_adm_documents d
      INNER JOIN accidents a ON a.pid = d.extra_text_three AND a.active = 1
      WHERE d.active = 1
        AND d.extra_text_three ~ '^S-\\d{6}-\\d+$'
        AND NOT EXISTS (
          SELECT 1 FROM comercial_document_links cdl
          WHERE cdl.document_id = d.document_id AND cdl.accident_id = a.id AND cdl.active = 1
        )
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    result.exact_s = rows.length;
  } catch (e) {
    result.errors.push(`Paso 2 (S- exacto): ${e?.message}`);
  }

  // Paso 3: Match normalizado YYMMDD-N → M-YYMMDD-N en maintenances
  try {
    const rows = await sql.unsafe(`
      INSERT INTO comercial_document_links (document_id, link_type, maintenance_id, linked_pid, match_method, confidence)
      SELECT DISTINCT
        d.document_id, 'maintenance', m.id, m.pid, 'auto_normalized', 'high'
      FROM comercial_adm_documents d
      INNER JOIN maintenances m ON m.pid = 'M-' || d.extra_text_three AND m.active = 1
      WHERE d.active = 1
        AND d.extra_text_three ~ '^\\d{6}-\\d+$'
        AND NOT EXISTS (
          SELECT 1 FROM comercial_document_links cdl
          WHERE cdl.document_id = d.document_id AND cdl.maintenance_id = m.id AND cdl.active = 1
        )
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    result.normalized_m = rows.length;
  } catch (e) {
    result.errors.push(`Paso 3 (normalizado M-): ${e?.message}`);
  }

  // Paso 4: Match normalizado YYMMDD-N → S-YYMMDD-N en accidents
  try {
    const rows = await sql.unsafe(`
      INSERT INTO comercial_document_links (document_id, link_type, accident_id, linked_pid, match_method, confidence)
      SELECT DISTINCT
        d.document_id, 'accident', a.id, a.pid, 'auto_normalized', 'high'
      FROM comercial_adm_documents d
      INNER JOIN accidents a ON a.pid = 'S-' || d.extra_text_three AND a.active = 1
      WHERE d.active = 1
        AND d.extra_text_three ~ '^\\d{6}-\\d+$'
        AND NOT EXISTS (
          SELECT 1 FROM comercial_document_links cdl
          WHERE cdl.document_id = d.document_id AND cdl.accident_id = a.id AND cdl.active = 1
        )
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    result.normalized_s = rows.length;
  } catch (e) {
    result.errors.push(`Paso 4 (normalizado S-): ${e?.message}`);
  }

  // Paso 5: Múltiples folios — documentos con separadores (/ , ;)
  try {
    const multiDocs = await sql.unsafe(`
      SELECT d.document_id, d.extra_text_three
      FROM comercial_adm_documents d
      WHERE d.active = 1
        AND d.extra_text_three ~ '[/,;]'
        AND d.extra_text_three ~ '\\d{6}-\\d+'
    `);

    let multiCount = 0;
    for (const doc of multiDocs) {
      const raw = String(doc.extra_text_three);
      const folioRegex = /([MS])?-?(\d{6})-(\d+)/g;
      let match;

      while ((match = folioRegex.exec(raw)) !== null) {
        const prefix = match[1]?.toUpperCase();
        const date = match[2];
        const seq = match[3];

        const candidates = [];
        if (prefix === "M") {
          candidates.push({ pid: `M-${date}-${seq}`, type: "maintenance", table: "maintenances", idField: "maintenance_id" });
        } else if (prefix === "S") {
          candidates.push({ pid: `S-${date}-${seq}`, type: "accident", table: "accidents", idField: "accident_id" });
        } else {
          candidates.push({ pid: `M-${date}-${seq}`, type: "maintenance", table: "maintenances", idField: "maintenance_id" });
          candidates.push({ pid: `S-${date}-${seq}`, type: "accident", table: "accidents", idField: "accident_id" });
        }

        for (const c of candidates) {
          try {
            const inserted = await sql.unsafe(`
              INSERT INTO comercial_document_links (document_id, link_type, ${c.idField}, linked_pid, match_method, confidence)
              SELECT
                ${doc.document_id}, '${c.type}', t.id, '${c.pid}', 'auto_normalized', 'medium'
              FROM ${c.table} t
              WHERE t.pid = '${c.pid}' AND t.active = 1
                AND NOT EXISTS (
                  SELECT 1 FROM comercial_document_links cdl
                  WHERE cdl.document_id = ${doc.document_id} AND cdl.${c.idField} = t.id AND cdl.active = 1
                )
              ON CONFLICT DO NOTHING
              RETURNING id
            `);
            multiCount += inserted.length;
          } catch {
            // Ignorar conflictos individuales
          }
        }
      }
    }
    result.multiple_folios = multiCount;
  } catch (e) {
    result.errors.push(`Paso 5 (múltiples): ${e?.message}`);
  }

  return result;
}

async function getDocumentLinkingStats() {
  const stats = await sql.unsafe(`
    SELECT
      (SELECT COUNT(*) FROM comercial_document_links WHERE active = 1) as total_links,
      (SELECT COUNT(*) FROM comercial_document_links WHERE active = 1 AND match_method = 'auto_exact') as auto_exact,
      (SELECT COUNT(*) FROM comercial_document_links WHERE active = 1 AND match_method = 'auto_normalized') as auto_normalized,
      (SELECT COUNT(*) FROM comercial_document_links WHERE active = 1 AND match_method = 'manual') as manual_links,
      (SELECT COUNT(*) FROM comercial_document_links WHERE active = 1 AND link_type = 'maintenance') as maintenance_links,
      (SELECT COUNT(*) FROM comercial_document_links WHERE active = 1 AND link_type = 'accident') as accident_links
  `);
  return stats[0];
}

// ============================================================
// AUTO-LINK MOVIMIENTOS (3 pasos)
// ============================================================

async function autoLinkMovements() {
  const result = {
    direct_matches: 0,
    normalized_matches: 0,
    text_matches: 0,
    errors: [],
  };

  // Paso 1: Match exacto — eco_number exacto con 3 dígitos
  try {
    const rows = await sql.unsafe(`
      INSERT INTO comercial_movement_unit_links (movement_id, unit_id, eco_number, match_method, confidence)
      SELECT DISTINCT
        mv.movement_id,
        u.id,
        UPPER(TRIM(mv.extra_text_one)),
        'auto_direct',
        'high'
      FROM comercial_adm_movements mv
      INNER JOIN units u ON UPPER(TRIM(mv.extra_text_one)) = UPPER(u.eco_number) AND u.active = 1
      WHERE mv.active = 1
        AND mv.extra_text_one IS NOT NULL
        AND UPPER(TRIM(mv.extra_text_one)) ~ '^(AP|TP|TR|AR|PR)-\\d{3}$'
        AND NOT EXISTS (
          SELECT 1 FROM comercial_movement_unit_links cmul
          WHERE cmul.movement_id = mv.movement_id AND cmul.unit_id = u.id AND cmul.active = 1
        )
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    result.direct_matches = rows.length;
  } catch (e) {
    result.errors.push(`Paso 1 (exacto): ${e?.message}`);
  }

  // Paso 2: Match normalizado — eco_number con 1-2 dígitos, padear a 3
  try {
    const rows = await sql.unsafe(`
      INSERT INTO comercial_movement_unit_links (movement_id, unit_id, eco_number, match_method, confidence)
      SELECT DISTINCT
        mv.movement_id,
        u.id,
        UPPER(REGEXP_REPLACE(TRIM(mv.extra_text_one), '^((?:AP|TP|TR|AR|PR)-)0*(\\d{1,3})$', '\\1', 'i'))
          || LPAD(REGEXP_REPLACE(UPPER(TRIM(mv.extra_text_one)), '^(?:AP|TP|TR|AR|PR)-0*(\\d{1,3})$', '\\1', 'i'), 3, '0'),
        'auto_direct',
        'high'
      FROM comercial_adm_movements mv
      INNER JOIN units u ON
        UPPER(SUBSTRING(TRIM(mv.extra_text_one) FROM '^((?:AP|TP|TR|AR|PR)-)'))
          || LPAD(SUBSTRING(UPPER(TRIM(mv.extra_text_one)) FROM '-(\\d{1,3})$'), 3, '0')
        = UPPER(u.eco_number)
        AND u.active = 1
      WHERE mv.active = 1
        AND mv.extra_text_one IS NOT NULL
        AND UPPER(TRIM(mv.extra_text_one)) ~ '^(AP|TP|TR|AR|PR)-\\d{1,2}$'
        AND NOT EXISTS (
          SELECT 1 FROM comercial_movement_unit_links cmul
          WHERE cmul.movement_id = mv.movement_id AND cmul.unit_id = u.id AND cmul.active = 1
        )
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    result.normalized_matches = rows.length;
  } catch (e) {
    result.errors.push(`Paso 2 (normalizado): ${e?.message}`);
  }

  // Paso 3: Match en texto libre
  try {
    const rows = await sql.unsafe(`
      INSERT INTO comercial_movement_unit_links (movement_id, unit_id, eco_number, match_method, confidence)
      SELECT DISTINCT
        mv.movement_id,
        u.id,
        UPPER(SUBSTRING(TRIM(mv.extra_text_one) FROM '((?:AP|TP|TR|AR|PR)-\\d{2,3})')),
        'auto_direct',
        'medium'
      FROM comercial_adm_movements mv
      INNER JOIN units u ON
        UPPER(
          SUBSTRING(mv.extra_text_one FROM '((AP|TP|TR|AR|PR)-)') ||
          LPAD(SUBSTRING(mv.extra_text_one FROM '(?:AP|TP|TR|AR|PR)-(\\d{1,3})'), 3, '0')
        ) = UPPER(u.eco_number)
        AND u.active = 1
      WHERE mv.active = 1
        AND mv.extra_text_one IS NOT NULL
        AND UPPER(TRIM(mv.extra_text_one)) ~ '(AP|TP|TR|AR|PR)-\\d{1,3}'
        AND UPPER(TRIM(mv.extra_text_one)) !~ '^(AP|TP|TR|AR|PR)-\\d{1,3}$'
        AND NOT EXISTS (
          SELECT 1 FROM comercial_movement_unit_links cmul
          WHERE cmul.movement_id = mv.movement_id AND cmul.unit_id = u.id AND cmul.active = 1
        )
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    result.text_matches = rows.length;
  } catch (e) {
    result.errors.push(`Paso 3 (texto): ${e?.message}`);
  }

  return result;
}

async function getMovementLinkingStats() {
  const stats = await sql.unsafe(`
    SELECT
      (SELECT COUNT(*) FROM comercial_movement_unit_links WHERE active = 1) as total_links,
      (SELECT COUNT(*) FROM comercial_movement_unit_links WHERE active = 1 AND match_method = 'auto_direct') as auto_direct,
      (SELECT COUNT(*) FROM comercial_movement_unit_links WHERE active = 1 AND match_method = 'auto_via_document') as auto_via_document,
      (SELECT COUNT(*) FROM comercial_movement_unit_links WHERE active = 1 AND match_method = 'manual') as manual_links
  `);
  return stats[0];
}

// ============================================================
// EJECUCIÓN
// ============================================================

async function run() {
  const start = Date.now();
  console.log("=".repeat(70));
  console.log("AUTO-LINK COMERCIAL - Fases 2 y 3");
  console.log("=".repeat(70));

  console.log("\n── ANTES ──");
  const beforeDocs = await getDocumentLinkingStats();
  const beforeMovs = await getMovementLinkingStats();
  console.log("  Doc links:", beforeDocs);
  console.log("  Mov links:", beforeMovs);

  console.log("\n── FASE 2: Auto-linking documentos ──");
  const docResult = await autoLinkDocuments();
  console.log("  Resultado:", JSON.stringify(docResult, null, 2));

  console.log("\n── FASE 3: Auto-linking movimientos ──");
  const movResult = await autoLinkMovements();
  console.log("  Resultado:", JSON.stringify(movResult, null, 2));

  console.log("\n── DESPUÉS ──");
  const afterDocs = await getDocumentLinkingStats();
  const afterMovs = await getMovementLinkingStats();
  console.log("  Doc links:", afterDocs);
  console.log("  Mov links:", afterMovs);

  const docsDelta = Number(afterDocs.total_links) - Number(beforeDocs.total_links);
  const movsDelta = Number(afterMovs.total_links) - Number(beforeMovs.total_links);
  console.log("\n── RESUMEN ──");
  console.log(`  Docs: ${beforeDocs.total_links} → ${afterDocs.total_links} (+${docsDelta})`);
  console.log(`  Movs: ${beforeMovs.total_links} → ${afterMovs.total_links} (+${movsDelta})`);
  console.log("=".repeat(70));

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const summary = {
    script: "comercial-auto-link",
    elapsed_seconds: Number(elapsed),
    documents: {
      before: Number(beforeDocs.total_links),
      after: Number(afterDocs.total_links),
      delta: docsDelta,
      result: docResult,
    },
    movements: {
      before: Number(beforeMovs.total_links),
      after: Number(afterMovs.total_links),
      delta: movsDelta,
      result: movResult,
    },
  };
  console.log(`::SUMMARY_JSON::${JSON.stringify(summary)}`);

  await sql.end();
  process.exit(0);
}

run().catch(async (err) => {
  console.error("Error:", err);
  try { await sql.end(); } catch {}
  process.exit(1);
});
