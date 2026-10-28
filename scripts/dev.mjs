import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { linkLocalPersistence, migrate } from "./migrate.mjs";

export async function startLocal({ persist = false, port = 0 } = {}) {
  const { locals: { runtime } } = JSON.parse(await readFile(new URL("../infra/runtime.tf.json", import.meta.url), "utf8"));
  const temporary = await mkdtemp(join(tmpdir(), "macrofactor-local-"));
  const directory = persist || join(temporary, "data");
  let mf;
  try {
    await migrate({ persist: directory });
    await linkLocalPersistence(join(temporary, "resources"), directory);
    mf = new Miniflare(convertV4MiniflareOptions({
      modules: true,
      scriptPath: fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
      compatibilityDate: runtime.compatibility_date,
      compatibilityFlags: runtime.compatibility_flags,
      host: "127.0.0.1",
      port,
      d1Databases: { DB: "local-macrofactor" },
      resourcePersistencePath: join(temporary, "resources"),
      durableObjects: Object.fromEntries(Object.entries(runtime.durable_objects)
        .map(([name, className]) => [name, { className, useSQLite: true }])),
      bindings: { INGEST_SECRET: "local-ingest-only", MCP_TOKEN: "local-mcp-only" },
    }));
    const dispose = mf.dispose.bind(mf);
    mf.dispose = async () => {
      await dispose();
      await rm(temporary, { recursive: true, force: true });
    };
    return mf;
  } catch (error) {
    await mf?.dispose();
    await rm(temporary, { recursive: true, force: true });
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
