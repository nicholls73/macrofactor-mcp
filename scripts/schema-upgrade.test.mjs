import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
