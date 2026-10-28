import { readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { applyMigrations } from "./schema.mjs";

export async function startLocal({ persist = false, port = 0 } = {}) {
  const { locals: { runtime } } = JSON.parse(await readFile(new URL("../infra/runtime.tf.json", import.meta.url), "utf8"));
  const mf = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
    compatibilityDate: runtime.compatibility_date,
    compatibilityFlags: runtime.compatibility_flags,
    host: "127.0.0.1",
    port,
    d1Databases: { DB: "local-macrofactor" },
    d1Persist: persist,
    durableObjects: Object.fromEntries(Object.entries(runtime.durable_objects)
      .map(([name, className]) => [name, { className, useSQLite: true }])),
    durableObjectsPersist: persist,
    bindings: { INGEST_SECRET: "local-ingest-only", MCP_TOKEN: "local-mcp-only" },
  });
  try {
    const db = await mf.getD1Database("DB");
    await applyMigrations(async sql => {
      // shortcut: these migrations have no trigger bodies or semicolons in strings; use a SQL parser if either is added.
      const statements = sql.replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean);
      return db.batch(statements.map(s => db.prepare(s)));
    });
    return mf;
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mf = await startLocal({ persist: ".local", port: 8787 });
  console.log(`Local MCP: ${await mf.ready}mcp/local-mcp-only`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
    await mf.dispose();
    process.exit(0);
  });
}
