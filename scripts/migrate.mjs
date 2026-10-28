import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const legacyMigration = "0002_food_log_nutrients.sql";

export async function linkLocalPersistence(resources, persist) {
  await mkdir(resolve(persist), { recursive: true });
  await mkdir(resources, { recursive: true });
  // Preserve Miniflare v4's shared storage directory under the native runtime's resource subdirectories.
  for (const kind of ["d1", "do"]) await symlink(resolve(persist), join(resources, kind), "dir");
}

export async function migrate({ remote = false, persist, migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url)), env = process.env } = {}) {
  const { CF_ACCOUNT_ID: account, CF_DATABASE_ID: id, CF_DATABASE_NAME: name, CLOUDFLARE_API_TOKEN: token } = env;
  if (remote && (!/^[a-f0-9]{32}$/.test(account ?? "") || !/^[a-f0-9-]{36}$/.test(id ?? "") || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name ?? "") || !token)) {
    throw new Error("CF_ACCOUNT_ID, CF_DATABASE_ID, CF_DATABASE_NAME and CLOUDFLARE_API_TOKEN are required.");
  }
  if (!remote && (typeof persist !== "string" || !persist)) throw new Error("A local persistence directory is required.");
  if (remote && persist) throw new Error("Choose either remote migrations or local persistence.");
  const temporary = await mkdtemp(join(tmpdir(), "macrofactor-wrangler-"));
  try {
    const database = remote ? name : "local-macrofactor";
    const config = join(temporary, "wrangler.json");
    await writeFile(config, JSON.stringify({
      ...(remote ? { account_id: account } : {}),
      d1_databases: [{ binding: "DB", database_name: database,
        database_id: remote ? id : "local-macrofactor", migrations_dir: resolve(migrationsDir) }],
    }));
    const target = remote ? ["--remote"] : ["--local", "--persist-to", temporary];
    if (!remote) await linkLocalPersistence(join(temporary, "v3"), persist);
    const run = async (operation, args) => {
      try {
        return (await execute(process.execPath, [wrangler, "d1", ...args, ...target, "--config", config], {
          cwd: temporary, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
          env: { ...env, ...(remote ? { CLOUDFLARE_ACCOUNT_ID: account } : {}),
            CI: "true", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(temporary, "wrangler.log") },
        })).stdout;
      } catch {
        // CLI output can contain SQL/provider details; report the failed operation without exposing it.
        throw new Error(`D1 migration ${operation} failed; deployment stopped.`);
      }
    };

    // Native list creates Wrangler's ledger; the bridge below only adopts the former runner's 0002.
    await run("history setup", ["migrations", "list", database]);
    const output = await run("schema inspection", ["execute", database, "--json", "--command",
      "PRAGMA table_info(food_log); SELECT name FROM d1_migrations;"]);
    let results;
    try { results = JSON.parse(output); } catch { throw new Error("D1 returned invalid migration metadata."); }
    if (!Array.isArray(results) || results.length !== 2 || results.some(result => result?.success !== true || !Array.isArray(result.results))) {
      throw new Error("D1 returned invalid migration metadata.");
    }
    const columns = results[0].results;
    const applied = results[1].results;
    if (columns.some(column => typeof column?.name !== "string") || applied.some(row => typeof row?.name !== "string")) {
      throw new Error("D1 returned invalid migration metadata.");
    }
    const nutrients = columns.find(column => column.name === "nutrients");
    const recorded = applied.some(row => row.name === legacyMigration);
    if (nutrients && !recorded) {
      if (typeof nutrients.type !== "string" || nutrients.type.toUpperCase() !== "TEXT" || nutrients.notnull !== 0 || nutrients.dflt_value !== null || nutrients.pk !== 0) {
        throw new Error("food_log.nutrients does not match migration 0002; migration history was not changed.");
      }
      await run("legacy adoption", ["execute", database, "--command",
        `INSERT OR IGNORE INTO d1_migrations (name) VALUES ('${legacyMigration}');`]);
    }
    await run("apply", ["migrations", "apply", database]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--remote") throw new Error("Usage: node scripts/migrate.mjs --remote");
    await migrate({ remote: true });
    console.log("D1 migrations applied with Wrangler.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
