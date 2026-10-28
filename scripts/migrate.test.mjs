import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { linkLocalPersistence, migrate } from "./migrate.mjs";
import { startLocal } from "./dev.mjs";

async function database(persist, use) {
  const resources = await mkdtemp(join(tmpdir(), "macrofactor-db-view-"));
  await linkLocalPersistence(resources, persist);
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: "export default { fetch() { return new Response(); } }",
    d1Databases: { DB: "local-macrofactor" }, resourcePersistencePath: resources,
  }));
  try { return await use(await mf.getD1Database("DB")); }
  finally { await mf.dispose(); await rm(resources, { recursive: true, force: true }); }
}

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "macrofactor-migrations-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const history = db => db.prepare("SELECT name FROM d1_migrations ORDER BY name").all()
  .then(result => result.results.map(row => row.name));
const expectedHistory = ["0001_initial_schema.sql", "0002_food_log_nutrients.sql"];

test("Wrangler applies schema-only migrations to an empty database and skips completed files", { timeout: 120_000 }, async t => {
  const persist = await temporary(t);
  await migrate({ persist });
  await migrate({ persist });
  await database(persist, async db => {
    assert.deepEqual(await history(db), expectedHistory);
    const tables = (await db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name != 'd1_migrations'").all()).results;
    assert.equal(tables.length, 22);
    for (const { name } of tables) assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).first()).n, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'index' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'").first()).n, 10);
    assert.equal((await db.prepare("PRAGMA table_info(food_log)").all()).results.filter(column => column.name === "nutrients").length, 1);
  });
});

for (const upgraded of [false, true]) {
  test(`Wrangler adopts an existing ${upgraded ? "upgraded" : "original"} database without changing rows`, { timeout: 120_000 }, async t => {
    const persist = await temporary(t);
    await database(persist, async db => {
      await db.prepare(`CREATE TABLE food_log (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, name TEXT${upgraded ? ", nutrients TEXT" : ""})`).run();
      await db.prepare("INSERT INTO food_log (id, date, name) VALUES (12, '2020-01-02', 'Synthetic legacy food')").run();
      if (upgraded) await db.prepare("UPDATE food_log SET nutrients = ? WHERE id = 12").bind('{"Water (g)":null,"Sodium (mg)":0}').run();
    });
    await migrate({ persist });
    await migrate({ persist });
    await database(persist, async db => {
      assert.deepEqual(await history(db), expectedHistory);
      assert.deepEqual(await db.prepare("SELECT * FROM food_log").first(), {
        id: 12, date: "2020-01-02", name: "Synthetic legacy food",
        nutrients: upgraded ? '{"Water (g)":null,"Sodium (mg)":0}' : null,
      });
      assert.ok((await db.prepare("PRAGMA index_list(food_log)").all()).results.some(index => index.name === "idx_food_log_date"));
    });
  });
}

test("Wrangler discovers new SQL files and rolls back a failed migration without recording it", { timeout: 120_000 }, async t => {
  const dir = await temporary(t);
  const persist = join(dir, "db");
  const migrationsDir = join(dir, "migrations");
  await cp(new URL("../migrations", import.meta.url), migrationsDir, { recursive: true });
  await migrate({ persist, migrationsDir });
  await writeFile(join(migrationsDir, "0003_test.sql"), "CREATE TABLE migration_probe (id INTEGER PRIMARY KEY);\nALTER TABLE food_log RENAME COLUMN nutrients TO nutrient_payload;\n");
  await migrate({ persist, migrationsDir });
  await migrate({ persist, migrationsDir });
  await writeFile(join(migrationsDir, "0004_test_failure.sql"), "CREATE TABLE rolled_back_probe (id INTEGER);\nSELECT * FROM private_provider_detail;\n");
  await assert.rejects(migrate({ persist, migrationsDir }), error => /migration/i.test(error.message) && !error.message.includes("private_provider_detail"));
  await database(persist, async db => {
    assert.deepEqual(await history(db), [...expectedHistory, "0003_test.sql"]);
    assert.equal(await db.prepare("SELECT name FROM sqlite_schema WHERE name = 'rolled_back_probe'").first(), null);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM migration_probe").first()).n, 0);
  });
});

test("remote migrations require explicit credentials and local migrations require a persistence directory", async () => {
  await assert.rejects(migrate({ remote: true, env: {} }), /required/);
  await assert.rejects(migrate(), /persist/);
});

test("unexpected nutrient definitions stop legacy adoption without recording the migration", { timeout: 120_000 }, async t => {
  const persist = await temporary(t);
  await database(persist, db => db.prepare("CREATE TABLE food_log (id INTEGER, date TEXT, nutrients REAL)").run());
  await assert.rejects(migrate({ persist }), /does not match migration 0002/);
  await database(persist, async db => {
    assert.deepEqual(await history(db), []);
    assert.equal((await db.prepare("PRAGMA table_info(food_log)").all()).results.find(column => column.name === "nutrients").type, "REAL");
  });
});

test("local startup preserves an existing database and its rows across restarts", { timeout: 120_000 }, async t => {
  const persist = await temporary(t);
  await database(persist, async db => {
    await db.prepare("CREATE TABLE food_log (id INTEGER PRIMARY KEY, date TEXT, name TEXT, nutrients TEXT)").run();
    await db.prepare("INSERT INTO food_log VALUES (3, '2020-01-02', 'Synthetic saved food', NULL)").run();
  });
  for (let pass = 0; pass < 2; pass++) {
    const mf = await startLocal({ persist });
    try {
      const db = await mf.getD1Database("DB");
      assert.deepEqual(await history(db), expectedHistory);
      assert.equal((await db.prepare("SELECT name FROM food_log WHERE id = 3").first()).name, "Synthetic saved food");
    } finally { await mf.dispose(); }
  }
});
