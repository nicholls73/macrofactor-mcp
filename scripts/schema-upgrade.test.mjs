import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { applySchema } from "./schema.mjs";
import { startLocal } from "./dev.mjs";

const env = {
  CF_ACCOUNT_ID: "a".repeat(32), CF_DATABASE_ID: "00000000-0000-0000-0000-000000000000",
  CLOUDFLARE_API_TOKEN: "test-token",
};
const oldFoodTable = `CREATE TABLE food_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, time TEXT, name TEXT,
  serving_size TEXT, serving_qty REAL, serving_weight_g REAL,
  calories REAL, protein REAL, carbs REAL, fat REAL
)`;

async function oldSchema(DB) {
  await DB.batch([
    DB.prepare("DROP TABLE food_log"), DB.prepare(oldFoodTable),
    DB.prepare("INSERT INTO food_log (id, date, name, calories) VALUES (12, '2020-01-02', 'Synthetic legacy food', 100)"),
  ]);
}

test("an empty database gets the original schema before nutrients, with no application data", async t => {
  const mf = new Miniflare({
    modules: true, script: "export default { fetch() { return new Response(); } }",
    d1Databases: { DB: "empty-migration-test" },
  });
  t.after(() => mf.dispose());
  const DB = await mf.getD1Database("DB");
  const snapshots = [];
  const request = async (_url, init) => {
    const sql = JSON.parse(init.body).sql;
    const parts = sql.replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean);
    const result = await DB.batch(parts.map(s => DB.prepare(s)));
    snapshots.push((await DB.prepare("PRAGMA table_info(food_log)").all()).results.map(column => column.name));
    return Response.json({ success: true, result });
  };
  await applySchema(env, request);
  assert.deepEqual(snapshots[0], [
    "id", "date", "time", "name", "serving_size", "serving_qty", "serving_weight_g",
    "calories", "protein", "carbs", "fat",
  ], "the baseline must describe the original food table, before migration 0002");
  assert.equal(snapshots.at(-1).filter(name => name === "nutrients").length, 1);
  assert.equal(snapshots.length, 3, "create the baseline, inspect it, then apply the nutrient migration");

  const tables = [
    "days", "micronutrients", "food_library", "food_log", "today_summary", "pending_food", "pending_water",
    "nutrition_targets", "weight_goals", "workout_sets", "muscle_volume", "exercise_metrics", "body_metrics",
    "training_programs", "pending_weight", "pending_batch", "import_log", "pr_baseline", "pr_alerts",
    "exercise_settings", "food_dispatch_log", "food_intent_log",
  ].sort();
  assert.deepEqual((await DB.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name").all())
    .results.map(row => row.name), tables);
  assert.deepEqual((await DB.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name").all())
    .results.map(row => row.name), [
      "idx_exercise_metrics", "idx_food_library_name", "idx_food_log_date", "idx_import_log_type",
      "idx_muscle_volume_date", "idx_nutrition_targets_date", "idx_pr_alerts_detected",
      "idx_workout_sets_date", "idx_workout_sets_ex", "idx_workout_sets_pr",
    ]);
  for (let pass = 0; pass < 2; pass++) {
    for (const table of tables) {
      assert.equal((await DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 0, `${table} must remain empty`);
    }
    if (pass === 0) await applySchema(env, request);
  }
});

test("deployment upgrades an existing food table once without losing rows or indexes", async t => {
  const mf = await startLocal();
  t.after(() => mf.dispose());
  const DB = await mf.getD1Database("DB");
  await oldSchema(DB);
  const statements = [];
  const request = async (_url, init) => {
    const sql = JSON.parse(init.body).sql;
    statements.push(sql);
    const parts = sql.replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean);
    return Response.json({ success: true, result: await DB.batch(parts.map(s => DB.prepare(s))) });
  };
  await applySchema(env, request);
  await applySchema(env, request);
  const columns = (await DB.prepare("PRAGMA table_info(food_log)").all()).results;
  assert.equal(columns.filter(column => column.name === "nutrients").length, 1);
  const legacy = await DB.prepare("SELECT * FROM food_log").first();
  assert.equal(legacy.id, 12);
  assert.equal(legacy.name, "Synthetic legacy food");
  assert.equal(legacy.calories, 100);
  assert.equal(legacy.nutrients, null);
  assert.equal(statements.filter(sql => /^ALTER TABLE/i.test(sql)).length, 1);
  assert.ok((await DB.prepare("PRAGMA index_list(food_log)").all()).results.some(index => index.name === "idx_food_log_date"));
  await DB.prepare("INSERT INTO food_log (date, nutrients) VALUES ('2020-01-03', ?)")
    .bind('{"Sodium (mg)":0,"Water (g)":null}').run();
  assert.deepEqual(JSON.parse((await DB.prepare("SELECT nutrients FROM food_log WHERE id > 12").first()).nutrients),
    { "Sodium (mg)": 0, "Water (g)": null });
});

test("the persistent local runtime also upgrades existing food tables on restart", async t => {
  const persist = await mkdtemp(join(tmpdir(), "macrofactor-schema-test-"));
  let mf;
  t.after(async () => { await mf?.dispose(); await rm(persist, { recursive: true, force: true }); });
  mf = await startLocal({ persist });
  await oldSchema(await mf.getD1Database("DB"));
  await mf.dispose();
  mf = await startLocal({ persist });
  const DB = await mf.getD1Database("DB");
  const columns = (await DB.prepare("PRAGMA table_info(food_log)").all()).results;
  assert.ok(columns.some(column => column.name === "nutrients"));
  assert.equal((await DB.prepare("SELECT nutrients FROM food_log WHERE id = 12").first()).nutrients, null);
});

test("malformed schema metadata and failed upgrades stop deployment without exposing response data", async () => {
  for (const results of [undefined, null, [], [null], [{ name: 1 }]]) {
    await assert.rejects(applySchema(env, async (_url, init) => {
      const sql = JSON.parse(init.body).sql;
      return Response.json({ success: true, result: [{ success: true, ...(sql.startsWith("PRAGMA") ? { results } : {}) }] });
    }), /schema|metadata/i);
  }
  for (const failure of [
    () => new Response("private-provider-body", { status: 403 }),
    () => Response.json({ success: false, errors: [{ message: "private-provider-body" }] }),
    () => { throw new Error("private-provider-body"); },
  ]) {
    let alterations = 0;
    await assert.rejects(applySchema(env, async (_url, init) => {
      const sql = JSON.parse(init.body).sql;
      if (sql.startsWith("ALTER")) { alterations++; return failure(); }
      return Response.json({ success: true, result: [{ success: true, results: [{ name: "date" }] }] });
    }), error => !error.message.includes("private-provider-body"));
    assert.equal(alterations, 1, "failed schema writes must not retry");
  }
});
