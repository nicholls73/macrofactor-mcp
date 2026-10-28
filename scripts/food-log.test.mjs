import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startLocal } from "./dev.mjs";
import { csv, headers, row, nutrients, legacy } from "./fixtures/food-log.mjs";

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/parse.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "browser",
});
const { parseFoodLogCsv } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text + "\n//# sourceURL=food-log-parser.js").toString("base64")}`);
const parse = text => parseFoodLogCsv(new TextEncoder().encode(text));

test("all 61 food columns retain their values and units without scaling by serving quantity", () => {
  assert.equal(headers.length, 61);
  const [parsed] = parse("\ufeff" + csv());
  assert.equal(typeof parsed.nutrients, "string");
  const { nutrients: payload, ...existing } = parsed;
  assert.deepEqual(existing, legacy);
  assert.deepEqual(JSON.parse(payload), nutrients);
  assert.equal(JSON.parse(payload)["B12, Cobalamin (mcg)"], 1.125);
  assert.equal(JSON.parse(payload)["Water (g)"], 49.125);
});

test("blank cells, absent columns and zero remain distinct, including a truncated CSV row", () => {
  const [zero, blank, short] = parse(csv([
    [...row.slice(0, 4), ...headers.slice(4).map(() => 0)],
    [...row.slice(0, 4), ...headers.slice(4).map(() => " ")],
    row.slice(0, 10),
  ]));
  for (const [item, want] of [[zero, 0], [blank, null], [short, null]]) {
    assert.equal(typeof item.nutrients, "string");
    assert.deepEqual(JSON.parse(item.nutrients), Object.fromEntries(headers.slice(10).map(key => [key, want])));
  }
  assert.equal(zero.calories, 0);
  assert.equal(blank.calories, null);
  assert.deepEqual(JSON.parse(parse(csv([row.slice(0, 10)], headers.slice(0, 10)))[0].nutrients), {});
});

test("nutrients accept finite scientific notation but reject malformed nonblank values without echoing them", () => {
  const values = [...row];
  values[10] = "1e-3";
  assert.equal(typeof parse(csv([values]))[0].nutrients, "string");
  assert.equal(JSON.parse(parse(csv([values]))[0].nutrients)["Alcohol (g)"], 0.001);
  for (const bad of ["private-invalid-value", "Infinity", "NaN", "1e999", "12mg"]) {
    values[10] = bad;
    assert.throws(() => parse(csv([values])), error => /nutrient/i.test(error.message) && !error.message.includes(bad));
  }
});

async function local(t) {
  const mf = await startLocal();
  const DB = await mf.getD1Database("DB");
  const client = new Client({ name: "food-log-test", version: "1" });
  t.after(async () => { await client.close(); await mf.dispose(); });
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp/local-mcp-only"), {
    fetch: (url, init) => mf.dispatchFetch(url.toString(), init),
  }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const upload = async (body = csv()) => {
    const response = await mf.dispatchFetch("http://localhost/upload-export", {
      method: "POST", headers: { "x-ingest-secret": "local-ingest-only" }, body,
    });
    return { status: response.status, ...await response.json() };
  };
  const ingest = async body => {
    const response = await mf.dispatchFetch("http://localhost/ingest", {
      method: "POST", body: JSON.stringify({ secret: "local-ingest-only", ...body }),
    });
    return { status: response.status, ...await response.json() };
  };
  const snapshot = async () => {
    const results = await DB.batch(["food_log", "import_log"].map(table => DB.prepare(`SELECT * FROM ${table} ORDER BY id`)));
    return results.map(result => result.results);
  };
  return { DB, call, upload, ingest, snapshot };
}

test("CSV upload stores all fields and both MCP food views expose full nutrients with explicit nulls", async t => {
  const { DB, call, upload } = await local(t);
  const values = [...row];
  values[10] = 0;
  values[11] = "";
  const expected = { ...nutrients, "Alcohol (g)": 0, "B12, Cobalamin (mcg)": null };
  assert.equal((await upload(csv([values]))).status, 200);
  const stored = await DB.prepare("SELECT * FROM food_log").first();
  assert.equal(typeof stored.nutrients, "string");
  assert.deepEqual(JSON.parse(stored.nutrients), expected);

  // A separate daily source must neither be overwritten nor substitute for food nutrients.
  await DB.prepare("INSERT INTO micronutrients (date, payload) VALUES (?, ?)")
    .bind(legacy.date, JSON.stringify({ "Sodium (mg)": 999 })).run();
  await DB.prepare(`INSERT INTO food_intent_log (queued_at_ms, date, name, intended_time, matched_exported_time, status)
    VALUES (0, ?, ?, '18:00', '19:38', 'matched')`).bind(legacy.date, legacy.name).run();
  const range = { start_date: legacy.date, end_date: legacy.date };
  const [compact] = await call("get_food_log", range);
  assert.deepEqual(compact, { ...legacy, intended_time: "18:00" });
  const [full] = await call("get_food_log", { ...range, detail: "full" });
  assert.deepEqual(full, { ...compact, nutrients: expected });
  assert.deepEqual((await call("get_day", { date: legacy.date, detail: "full" })).food_items, [full]);
  assert.deepEqual((await call("get_day", { date: legacy.date })).food_items, [compact]);
  assert.deepEqual(await call("get_micronutrients", { ...range, detail: "full" }), [{ date: legacy.date, "Sodium (mg)": 999 }]);
  assert.deepEqual(await call("get_food_log", { start_date: "2021-01-01", detail: "full" }), []);
});

test("legacy food rows stay readable with unknown nutrients and unchanged suspect flags", async t => {
  const { DB, call } = await local(t);
  await DB.prepare("INSERT INTO food_log (date, name, calories, protein) VALUES (?, 'Synthetic protein', 100, 0)")
    .bind(legacy.date).run();
  const range = { start_date: legacy.date, end_date: legacy.date };
  const [compact] = await call("get_food_log", range);
  assert.equal("nutrients" in compact, false);
  assert.deepEqual(compact.suspect, ["kcal_macro_mismatch", "zero_protein_on_protein_food"]);
  const [full] = await call("get_food_log", { ...range, detail: "full" });
  assert.equal(full.nutrients, null);
  assert.deepEqual(full.suspect, compact.suspect);
});

test("an old fingerprint permits one nutrient reimport; a failed replacement does not advance deduplication", async t => {
  const { DB, upload, snapshot } = await local(t);
  const bytes = csv();
  const hash = createHash("sha256").update(bytes).digest("hex");
  await DB.prepare("INSERT INTO food_log (date, name, calories) VALUES (?, ?, ?)")
    .bind(legacy.date, legacy.name, legacy.calories).run();
  await DB.prepare("INSERT INTO import_log (created, file_type, fingerprint, counts) VALUES (0, 'food_log', ?, '{}')").bind(hash).run();
  const before = await snapshot();
  await DB.prepare(`CREATE TRIGGER reject_food BEFORE INSERT ON food_log
    BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`).run();
  assert.equal((await upload(bytes)).status, 400);
  assert.deepEqual(await snapshot(), before);
  await DB.prepare("DROP TRIGGER reject_food").run();
  const first = await upload(bytes);
  assert.equal(first.status, 200);
  assert.equal(first.skipped, undefined);
  const after = await snapshot();
  assert.equal(after[0].length, 1);
  assert.deepEqual(JSON.parse(after[0][0].nutrients), nutrients);
  assert.equal(after[1].length, 2);
  assert.notEqual(after[1].at(-1).fingerprint, hash);
  assert.equal((await upload(bytes)).skipped, true);
  assert.deepEqual(await snapshot(), after);
});

test("manual food inserts and clears preserve nutrients and invalidate deduplication without deleting audit history", async t => {
  const { DB, call, upload, ingest, snapshot } = await local(t);
  await upload();
  const manual = { ...legacy, nutrients: JSON.stringify({ "Sodium (mg)": 0, "Water (g)": null }) };
  assert.equal((await ingest({ op: "insert", table: "food_log", rows: [manual] })).status, 200);
  const foods = await call("get_food_log", { start_date: legacy.date, detail: "full" });
  assert.deepEqual(foods.at(-1).nutrients, { "Sodium (mg)": 0, "Water (g)": null });
  assert.equal((await upload()).skipped, undefined);
  assert.equal((await snapshot())[0].length, 1);
  assert.equal((await upload()).skipped, true);
  assert.equal((await ingest({ op: "clear", tables: ["food_log"] })).status, 200);
  assert.equal((await snapshot())[0].length, 0);
  assert.equal((await upload()).skipped, undefined);
  assert.equal((await snapshot())[1].length, 5);
  const before = await snapshot();
  assert.equal((await ingest({ op: "insert", table: "food_log", rows: [] })).status, 200);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await upload()).skipped, true);
  assert.equal((await DB.prepare("SELECT COUNT(*) AS n FROM micronutrients").first()).n, 0);
});

test("invalid manual nutrients reject the whole batch before changing data or its fingerprint", async t => {
  const { ingest, upload, snapshot } = await local(t);
  await upload();
  const before = await snapshot();
  for (const invalid of ['{', 'null', '[]', '{"Sodium (mg)":"12"}', '{"Sodium (mg)":1e999}', '{} trailing', 0, {}]) {
    const result = await ingest({ op: "insert", table: "food_log", rows: [legacy, { ...legacy, nutrients: invalid }] });
    assert.equal(result.status, 400);
    assert.deepEqual(await snapshot(), before);
  }
  assert.equal((await upload()).skipped, true);
  assert.equal((await ingest({ op: "insert", table: "food_log", rows: [legacy, { ...legacy, nutrients: null }] })).status, 200);
  assert.deepEqual((await snapshot())[0].slice(-2).map(item => item.nutrients), [null, null]);
});

test("manual food changes roll back when their deduplication marker cannot commit", async t => {
  const { DB, ingest, upload, snapshot } = await local(t);
  await upload();
  const before = await snapshot();
  await DB.prepare(`CREATE TRIGGER reject_audit BEFORE INSERT ON import_log
    BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`).run();
  for (const operation of [
    { op: "insert", table: "food_log", rows: [legacy] }, { op: "clear", tables: ["food_log"] },
  ]) {
    assert.notEqual((await ingest(operation)).status, 200);
    assert.deepEqual(await snapshot(), before);
  }
});
