import sqlServer from "mssql";
import postgres from "postgres";
import { config } from "dotenv";

config({ path: process.env.DOTENV_CONFIG_PATH || ".env.development" });

// ============================================================
// CONFIGURACIÓN
// ============================================================

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

// ============================================================
// DEFINICIÓN DE TABLAS
// ============================================================

const TABLES = [
  {
    name: "admMovimientos",
    target: "comercial_adm_movements",
    uniqueKey: "movement_id",
    sourceKey: "CIDMOVIMIENTO",
    hasTimestamp: false,
    columns: {
      CIDMOVIMIENTO: "movement_id",
      CIDDOCUMENTO: "document_id",
      CNUMEROMOVIMIENTO: "movement_number",
      CIDPRODUCTO: "product_id",
      CIDALMACEN: "warehouse_id",
      CUNIDADES: "units",
      CUNIDADESCAPTURADAS: "captured_units",
      CIDUNIDAD: "unit_measure_id",
      CPRECIO: "price",
      CPRECIOCAPTURADO: "captured_price",
      CCOSTOCAPTURADO: "captured_cost",
      CCOSTOESPECIFICO: "specific_cost",
      CNETO: "net_amount",
      CIMPUESTO1: "tax_one",
      CIMPUESTO2: "tax_two",
      CIMPUESTO3: "tax_three",
      CRETENCION1: "retention_one",
      CRETENCION2: "retention_two",
      CDESCUENTO1: "discount_one",
      CTOTAL: "total",
      CREFERENCIA: "reference",
      COBSERVAMOV: "observations",
      CAFECTAEXISTENCIA: "affects_stock",
      CFECHA: "date",
      CIDVALORCLASIFICACION: "classification",
      CTIMESTAMP: "sql_timestamp",
    },
  },
  {
    name: "admDocumentos",
    target: "comercial_adm_documents",
    uniqueKey: "document_id",
    sourceKey: "CIDDOCUMENTO",
    hasTimestamp: true,
    columns: {
      CIDDOCUMENTO: "document_id",
      CIDCONCEPTODOCUMENTO: "document_concept_id",
      CSERIEDOCUMENTO: "document_series",
      CFOLIO: "folio",
      CFECHA: "date",
      CIDCLIENTEPROVEEDOR: "client_supplier_id",
      CRAZONSOCIAL: "business_name",
      CRFC: "rfc",
      CIDAGENTE: "agent_id",
      CFECHAVENCIMIENTO: "due_date",
      CIDMONEDA: "currency_id",
      CTIPOCAMBIO: "exchange_rate",
      CREFERENCIA: "reference",
      COBSERVACIONES: "observations",
      CNATURALEZA: "nature",
      CAFECTADO: "affected",
      CCANCELADO: "cancelled",
      CDEVUELTO: "returned",
      CNETO: "net_amount",
      CIMPUESTO1: "tax_one",
      CIMPUESTO2: "tax_two",
      CIMPUESTO3: "tax_three",
      CRETENCION1: "retention_one",
      CRETENCION2: "retention_two",
      CDESCUENTOMOV: "movement_discount",
      CDESCUENTODOC1: "document_discount_one",
      CDESCUENTODOC2: "document_discount_two",
      CTOTAL: "total",
      CPENDIENTE: "pending",
      CTOTALUNIDADES: "total_units",
      CGUIDDOCUMENTO: "document_guid",
      CUSUARIO: "username",
      CIDPROYECTO: "project_id",
      CMETODOPAG: "payment_method",
      CCONDIPAGO: "payment_conditions",
      CTIMESTAMP: "sql_timestamp",
    },
  },
  {
    name: "admExistenciaCosto",
    target: "comercial_adm_stock_costs",
    uniqueKey: "stock_id",
    sourceKey: "CIDEXISTENCIA",
    hasTimestamp: true,
    columns: {
      CIDEXISTENCIA: "stock_id",
      CIDALMACEN: "warehouse_id",
      CIDPRODUCTO: "product_id",
      CIDEJERCICIO: "fiscal_year_id",
      CTIPOEXISTENCIA: "stock_type",
      CENTRADASINICIALES: "initial_entries",
      CSALIDASINICIALES: "initial_exits",
      CCOSTOINICIALENTRADAS: "initial_entries_cost",
      CCOSTOINICIALSALIDAS: "initial_exits_cost",
      CENTRADASPERIODO1: "entries_period_1",
      CENTRADASPERIODO2: "entries_period_2",
      CENTRADASPERIODO3: "entries_period_3",
      CENTRADASPERIODO4: "entries_period_4",
      CENTRADASPERIODO5: "entries_period_5",
      CENTRADASPERIODO6: "entries_period_6",
      CENTRADASPERIODO7: "entries_period_7",
      CENTRADASPERIODO8: "entries_period_8",
      CENTRADASPERIODO9: "entries_period_9",
      CENTRADASPERIODO10: "entries_period_10",
      CENTRADASPERIODO11: "entries_period_11",
      CENTRADASPERIODO12: "entries_period_12",
      CSALIDASPERIODO1: "exits_period_1",
      CSALIDASPERIODO2: "exits_period_2",
      CSALIDASPERIODO3: "exits_period_3",
      CSALIDASPERIODO4: "exits_period_4",
      CSALIDASPERIODO5: "exits_period_5",
      CSALIDASPERIODO6: "exits_period_6",
      CSALIDASPERIODO7: "exits_period_7",
      CSALIDASPERIODO8: "exits_period_8",
      CSALIDASPERIODO9: "exits_period_9",
      CSALIDASPERIODO10: "exits_period_10",
      CSALIDASPERIODO11: "exits_period_11",
      CSALIDASPERIODO12: "exits_period_12",
      CCOSTOENTRADASPERIODO1: "entries_cost_period_1",
      CCOSTOENTRADASPERIODO2: "entries_cost_period_2",
      CCOSTOENTRADASPERIODO3: "entries_cost_period_3",
      CCOSTOENTRADASPERIODO4: "entries_cost_period_4",
      CCOSTOENTRADASPERIODO5: "entries_cost_period_5",
      CCOSTOENTRADASPERIODO6: "entries_cost_period_6",
      CCOSTOENTRADASPERIODO7: "entries_cost_period_7",
      CCOSTOENTRADASPERIODO8: "entries_cost_period_8",
      CCOSTOENTRADASPERIODO9: "entries_cost_period_9",
      CCOSTOENTRADASPERIODO10: "entries_cost_period_10",
      CCOSTOENTRADASPERIODO11: "entries_cost_period_11",
      CCOSTOENTRADASPERIODO12: "entries_cost_period_12",
      CCOSTOSALIDASPERIODO1: "exits_cost_period_1",
      CCOSTOSALIDASPERIODO2: "exits_cost_period_2",
      CCOSTOSALIDASPERIODO3: "exits_cost_period_3",
      CCOSTOSALIDASPERIODO4: "exits_cost_period_4",
      CCOSTOSALIDASPERIODO5: "exits_cost_period_5",
      CCOSTOSALIDASPERIODO6: "exits_cost_period_6",
      CCOSTOSALIDASPERIODO7: "exits_cost_period_7",
      CCOSTOSALIDASPERIODO8: "exits_cost_period_8",
      CCOSTOSALIDASPERIODO9: "exits_cost_period_9",
      CCOSTOSALIDASPERIODO10: "exits_cost_period_10",
      CCOSTOSALIDASPERIODO11: "exits_cost_period_11",
      CCOSTOSALIDASPERIODO12: "exits_cost_period_12",
      CBANCONGELADO: "frozen",
      CTIMESTAMP: "sql_timestamp",
    },
  },
  {
    name: "admFoliosDigitales",
    target: "comercial_adm_digital_stamps",
    uniqueKey: "digital_stamp_id",
    sourceKey: "CIDFOLDIG",
    hasTimestamp: false,
    columns: {
      CIDFOLDIG: "digital_stamp_id",
      CIDDOCTODE: "source_document_id",
      CIDCPTODOC: "document_concept_id",
      CIDDOCTO: "document_id",
      CSERIE: "series",
      CFOLIO: "folio",
      CNOAPROB: "approval_number",
      CFECAPROB: "approval_date",
      CESTADO: "state",
      CENTREGADO: "delivered",
      CFECHAEMI: "emission_date",
      CHORAEMI: "emission_time",
      CEMAIL: "email",
      CFECHACANC: "cancellation_date",
      CHORACANC: "cancellation_time",
      CRFC: "rfc",
      CRAZON: "business_name",
      CTOTAL: "total",
      CUUID: "uuid",
      CCADPEDI: "petition_chain",
      CTIPO: "type",
      CDESESTADO: "state_description",
      CACUSECAN: "cancellation_receipt",
    },
  },
  {
    name: "admProductos",
    target: "comercial_adm_products",
    uniqueKey: "product_id",
    sourceKey: "CIDPRODUCTO",
    hasTimestamp: false,
    columns: {
      CIDPRODUCTO: "product_id",
      CCODIGOPRODUCTO: "product_code",
      CNOMBREPRODUCTO: "product_name",
      CTIPOPRODUCTO: "product_type",
      CSTATUSPRODUCTO: "status",
      CFECHAALTAPRODUCTO: "registration_date",
      CDESCRIPCIONPRODUCTO: "description",
      CCLAVESAT: "sat_key",
      CPRECIO1: "price_one",
      CPRECIO2: "price_two",
      CPRECIO3: "price_three",
      CPRECIO4: "price_four",
      CPRECIO5: "price_five",
      CPRECIO6: "price_six",
      CPRECIO7: "price_seven",
      CPRECIO8: "price_eight",
      CPRECIO9: "price_nine",
      CPRECIO10: "price_ten",
      CIMPUESTO1: "tax_one",
      CIMPUESTO2: "tax_two",
      CIMPUESTO3: "tax_three",
      CIDVALORCLASIFICACION1: "classification_one",
      CIDVALORCLASIFICACION2: "classification_two",
      CIDVALORCLASIFICACION3: "classification_three",
      CIDVALORCLASIFICACION4: "classification_four",
      CIDVALORCLASIFICACION5: "classification_five",
      CIDVALORCLASIFICACION6: "classification_six",
      CMETODOCOSTEO: "costing_method",
      CCONTROLEXISTENCIA: "stock_control",
      CIDUNIDADBASE: "base_unit_id",
    },
  },
];

// ============================================================
// FUNCIONES
// ============================================================

function mapRow(row, columnMap) {
  const mapped = {};
  for (const [sqlCol, pgCol] of Object.entries(columnMap)) {
    mapped[pgCol] = row[sqlCol] ?? null;
  }
  return mapped;
}

function buildUpdateSet(columnMap, uniqueKey) {
  return Object.values(columnMap)
    .filter((col) => col !== uniqueKey)
    .map((col) => `${col} = EXCLUDED.${col}`)
    .concat(["synced_at = EXCLUDED.synced_at"])
    .join(",\n            ");
}

async function getExistingIds(target, uniqueKey) {
  const rows = await supabase.unsafe(
    `SELECT ${uniqueKey} FROM ${target}`
  );
  return new Set(rows.map((r) => r[uniqueKey]));
}

async function getLastTimestamp(target) {
  try {
    const result = await supabase.unsafe(
      `SELECT COALESCE(MAX(sql_timestamp), '') as last_ts FROM ${target} WHERE sql_timestamp IS NOT NULL AND sql_timestamp != '' AND sql_timestamp != '12/30/1899 00:00:00:000'`
    );
    return result[0].last_ts;
  } catch {
    return "";
  }
}

async function upsertRows(rows, tableDef) {
  const { target, uniqueKey, columns } = tableDef;
  const now = new Date().toISOString();
  const updateSet = buildUpdateSet(columns, uniqueKey);
  const pgCols = Object.values(columns);
  const allCols = [...pgCols, "synced_at"];
  let inserted = 0;
  let updated = 0;
  let errors = 0;

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const mappedRows = slice.map((row) => {
      const m = mapRow(row, columns);
      m.synced_at = now;
      return m;
    });

    const valuesSql = [];
    const params = [];
    let p = 1;
    for (const m of mappedRows) {
      const placeholders = allCols.map(() => `$${p++}`).join(", ");
      valuesSql.push(`(${placeholders})`);
      for (const c of allCols) params.push(m[c]);
    }

    const query = `
      INSERT INTO ${target} (${allCols.join(", ")})
      VALUES ${valuesSql.join(", ")}
      ON CONFLICT (${uniqueKey}) DO UPDATE SET
        ${updateSet}
      RETURNING (xmax = 0) AS is_insert`;

    try {
      const result = await supabase.unsafe(query, params);
      for (const r of result) {
        if (r.is_insert) inserted++;
        else updated++;
      }
    } catch (err) {
      // Fallback fila a fila para aislar el error y seguir con el resto del batch
      for (const m of mappedRows) {
        try {
          const single = await supabase.unsafe(
            `INSERT INTO ${target} (${allCols.join(", ")})
             VALUES (${allCols.map((_, idx) => `$${idx + 1}`).join(", ")})
             ON CONFLICT (${uniqueKey}) DO UPDATE SET
              ${updateSet}
             RETURNING (xmax = 0) AS is_insert`,
            allCols.map((c) => m[c])
          );
          if (single[0]?.is_insert) inserted++;
          else updated++;
        } catch (e2) {
          errors++;
          if (errors <= 3) {
            console.error(`  Error en ${uniqueKey}=${m[uniqueKey]}: ${e2.message}`);
          }
        }
      }
    }
  }

  return { inserted, updated, errors };
}

async function syncTable(pool, tableDef) {
  const { name, target, uniqueKey, sourceKey, hasTimestamp, columns } = tableDef;
  const sqlColumns = Object.keys(columns).join(", ");

  console.log(`\n${"─".repeat(50)}`);
  console.log(`${name} → ${target}`);
  console.log(`${"─".repeat(50)}`);

  let totalInserted = 0;
  let totalUpdated = 0;
  let totalErrors = 0;
  let totalMissing = 0;

  // 1) Obtener todos los IDs de SQL Server y Supabase para encontrar faltantes
  console.log(`  Comparando IDs entre SQL Server y Supabase...`);
  const existingIds = await getExistingIds(target, uniqueKey);
  console.log(`  IDs en Supabase: ${existingIds.size}`);

  const allSqlResult = await pool
    .request()
    .query(`SELECT ${sourceKey} FROM ${name}`);
  const allSqlIds = allSqlResult.recordset.map((r) => r[sourceKey]);
  console.log(`  IDs en SQL Server: ${allSqlIds.length}`);

  // Encontrar IDs faltantes en Supabase
  const missingIds = allSqlIds.filter((id) => !existingIds.has(id));
  totalMissing = missingIds.length;
  console.log(`  Registros faltantes: ${missingIds.length}`);

  // Sincronizar faltantes en lotes
  if (missingIds.length > 0) {
    const BATCH_SIZE = 500;
    for (let i = 0; i < missingIds.length; i += BATCH_SIZE) {
      const batch = missingIds.slice(i, i + BATCH_SIZE);
      const idList = batch.join(",");
      const batchResult = await pool
        .request()
        .query(`SELECT ${sqlColumns} FROM ${name} WHERE ${sourceKey} IN (${idList})`);

      const r = await upsertRows(batchResult.recordset, tableDef);
      totalInserted += r.inserted;
      totalUpdated += r.updated;
      totalErrors += r.errors;

      if (missingIds.length > BATCH_SIZE) {
        const progress = Math.min(i + BATCH_SIZE, missingIds.length);
        process.stdout.write(`\r  → Faltantes: ${progress}/${missingIds.length} procesados`);
      }
    }
    if (missingIds.length > 0) {
      console.log(`\n  → Insertados: ${totalInserted}, Errores: ${totalErrors}`);
    }
  }

  // 2) Registros modificados por CTIMESTAMP (solo tablas que lo soportan)
  if (hasTimestamp) {
    const lastTs = await getLastTimestamp(target);
    if (lastTs) {
      console.log(`  Último CTIMESTAMP en Supabase: ${lastTs}`);
      const updResult = await pool
        .request()
        .query(
          `SELECT ${sqlColumns} FROM ${name} WHERE CONVERT(DATETIME, CTIMESTAMP, 101) > CONVERT(DATETIME, '${lastTs}', 101) AND CTIMESTAMP != '' AND CTIMESTAMP != '12/30/1899 00:00:00:000'`
        );
      const updRows = updResult.recordset;
      console.log(`  Registros modificados (CTIMESTAMP > último): ${updRows.length}`);

      if (updRows.length > 0) {
        const r = await upsertRows(updRows, tableDef);
        totalUpdated += r.updated;
        totalInserted += r.inserted;
        totalErrors += r.errors;
        console.log(`  → Actualizados: ${r.updated}, Nuevos por timestamp: ${r.inserted}, Errores: ${r.errors}`);
      }
    } else {
      console.log(`  Sin CTIMESTAMP previo, saltando detección de updates`);
    }
  }

  const total = totalInserted + totalUpdated;
  if (total === 0 && totalErrors === 0) {
    console.log(`  ✓ Sin cambios`);
  }

  return {
    name,
    missing: totalMissing,
    inserted: totalInserted,
    updated: totalUpdated,
    errors: totalErrors,
  };
}

// ============================================================
// EJECUCIÓN PRINCIPAL
// ============================================================

async function main() {
  const start = Date.now();
  console.log("═══════════════════════════════════════════════════");
  console.log("  Sincronización incremental AdminPAQ → Supabase");
  console.log(`  ${new Date().toLocaleString("es-MX")}`);
  console.log("═══════════════════════════════════════════════════");

  // Filtrar tablas si se pasan argumentos
  const args = process.argv.slice(2);
  const tablesToSync = args.length
    ? TABLES.filter((t) => args.includes(t.name) || args.includes(t.target))
    : TABLES;

  if (tablesToSync.length === 0) {
    console.log("No se encontraron tablas.");
    console.log("Disponibles:", TABLES.map((t) => t.name).join(", "));
    process.exit(1);
  }

  // Conectar a SQL Server
  console.log(`\nConectando a SQL Server (${sqlConfig.server})...`);
  const pool = await sqlServer.connect(sqlConfig);
  console.log("Conectado.");

  // Sincronizar
  const results = [];
  for (const tableDef of tablesToSync) {
    const result = await syncTable(pool, tableDef);
    results.push(result);
  }

  // Resumen
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n${"═".repeat(50)}`);
  console.log("RESUMEN");
  console.log(`${"═".repeat(50)}`);
  console.table(
    results.map((r) => ({
      Tabla: r.name,
      Faltantes: r.missing,
      Insertados: r.inserted,
      Actualizados: r.updated,
      Errores: r.errors,
    }))
  );
  console.log(`Tiempo total: ${elapsed}s`);

  // Resultado estructurado para CI (GitHub Actions parsea esta línea)
  const totals = results.reduce(
    (acc, r) => ({
      missing: acc.missing + (r.missing ?? 0),
      inserted: acc.inserted + (r.inserted ?? 0),
      updated: acc.updated + (r.updated ?? 0),
      errors: acc.errors + (r.errors ?? 0),
    }),
    { missing: 0, inserted: 0, updated: 0, errors: 0 }
  );
  const summary = {
    script: "sync-incremental",
    elapsed_seconds: Number(elapsed),
    tables: results.map((r) => ({
      name: r.name,
      missing: r.missing ?? 0,
      inserted: r.inserted ?? 0,
      updated: r.updated ?? 0,
      errors: r.errors ?? 0,
    })),
    totals,
  };
  console.log(`::SUMMARY_JSON::${JSON.stringify(summary)}`);

  await pool.close();
  await supabase.end();
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
