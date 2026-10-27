import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import * as XLSX from "xlsx";
import { startLocal } from "./dev.mjs";

const workbookTables = [
  "days", "micronutrients", "food_library", "nutrition_targets", "weight_goals",
  "muscle_volume", "exercise_metrics", "body_metrics", "training_programs", "exercise_settings",
];
const tables = [...workbookTables, "food_log", "workout_sets", "import_log"];
let mf, DB;

beforeEach(async () => {
  mf = await startLocal();
  DB = await mf.getD1Database("DB");
});
afterEach(async () => { await mf?.dispose(); });

function workbook(label, dayCount = 1) {
  const wb = XLSX.utils.book_new();
  const dates = Array.from({ length: dayCount }, (_, i) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10));
  const sheets = {
    "Calories & Macros": [["Date", "Calories (kcal)"], ...dates.map(date => [date, label === "old" ? 1800 : 2200])],
    Micronutrients: [["Date", "Fiber (g)"], ...dates.map(date => [date, 25])],
    Favorites: [["Food Name", "Serving Qty", "Calories (kcal)"], [label, 1, 100]],
    "Nutrition Program Settings": [["Program Update Date", "Program Weekday", "Calories (kcal)"], ["2026-01-01", "Monday", 2000]],
    "Weight Goals": [["Goal", "Status"], [label, "In Progress"]],
    "Muscle Groups - Sets": [["Date", "Quads"], ["2026-01-01", 3]],
    "Exercises - 1-RM": [["Date", `${label} (kg)`], ...dates.map(date => [date, 100])],
    "Body Metrics": [["Date", "Waist (cm)"], ["2026-01-01", 80]],
    "Training Programs": [[`Program: ${label}`], ["Cycle 1"], ["Rest"]],
    "Exercise Settings": [["Exercises", "Weight Unit"], [label, "Kilograms"]],
  };
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

function food(label, count = 1) {
  return "Date,Time,Food Name,Serving Qty,Calories (kcal)\n" +
    Array.from({ length: count }, (_, i) => `2026-01-01,12:00,${label}-${i},1,100`).join("\n");
}

function workout(label, count = 1) {
  return "Date,Workout,Exercise,Set Type,Reps,Weight (kg)\n" +
    Array.from({ length: count }, () => `2026-01-01,${label},Test press,Standard Set,10,100`).join("\n");
}

async function upload(body) {
  const response = await mf.dispatchFetch("http://localhost/upload-export", {
    method: "POST", headers: { "x-ingest-secret": "local-ingest-only" }, body,
  });
  return { status: response.status, body: await response.json() };
}

async function imported(bytes) {
  const result = await upload(bytes);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  return result.body;
}

async function snapshot() {
  const results = await DB.batch(tables.map(table => DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`)));
  return Object.fromEntries(tables.map((table, i) => [table, results[i].results]));
}

async function seed() {
  await imported(workbook("old"));
  await imported(food("old"));
  await imported(workout("old"));
  return snapshot();
}

test("a food failure after the first 50 rows preserves all live data and permits an identical retry", async () => {
  const before = await seed();
  const bytes = food("new", 121);
  await DB.prepare(`CREATE TRIGGER reject_import BEFORE INSERT ON food_log
    WHEN NEW.name = 'new-75' BEGIN SELECT RAISE(ABORT, 'injected late row failure'); END`).run();
  const failed = await upload(bytes);
  assert.equal(failed.status, 400);
  assert.match(failed.body.error, /injected late row failure/);
  assert.deepEqual(await snapshot(), before);

  await DB.prepare("DROP TRIGGER reject_import").run();
  const retry = await imported(bytes);
  assert.equal(retry.skipped, undefined);
  assert.equal(retry.food_log, 121);
  const after = await snapshot();
  assert.equal(after.import_log.length, before.import_log.length + 1);
  assert.equal(after.food_log.length, 121);
  assert.equal(after.food_log[120].name, "new-120");
  for (const table of [...workbookTables, "workout_sets"]) assert.deepEqual(after[table], before[table]);
  assert.equal((await imported(bytes)).skipped, true);
  assert.deepEqual(await snapshot(), after);
});

test("a failure in the final workbook table rolls back every workbook table and its fingerprint", async () => {
  const before = await seed();
  const bytes = workbook("new");
  await DB.prepare(`CREATE TRIGGER reject_import BEFORE INSERT ON exercise_settings
    WHEN NEW.exercise = 'new' BEGIN SELECT RAISE(ABORT, 'injected late table failure'); END`).run();
  assert.equal((await upload(bytes)).status, 400);
  assert.deepEqual(await snapshot(), before);

  await DB.prepare("DROP TRIGGER reject_import").run();
  const retry = await imported(bytes);
  assert.equal(retry.skipped, undefined);
  const after = await snapshot();
  assert.equal(after.days[0].calories, 2200);
  assert.equal(after.exercise_settings[0].exercise, "new");
  assert.equal(after.import_log.length, before.import_log.length + 1);
  for (const table of workbookTables) assert.equal(after[table].length, retry[table], table);
  for (const table of ["food_log", "workout_sets"]) assert.deepEqual(after[table], before[table]);
  assert.equal((await imported(bytes)).skipped, true);
  assert.deepEqual(await snapshot(), after);
});

test("failure to write import-success metadata rolls back the replacement", async () => {
  const before = await seed();
  await DB.prepare(`CREATE TRIGGER reject_import BEFORE INSERT ON import_log
    BEGIN SELECT RAISE(ABORT, 'injected metadata failure'); END`).run();
  assert.equal((await upload(workout("new", 125))).status, 400);
  assert.deepEqual(await snapshot(), before);
  await DB.prepare("DROP TRIGGER reject_import").run();
  assert.equal((await imported(workout("new", 125))).workout_sets, 125);
});

test("overlapping identical uploads commit once and skip the other requests", async () => {
  const bytes = food("concurrent", 250);
  const results = await Promise.all([imported(bytes), imported(bytes), imported(bytes)]);
  assert.equal(results.filter(result => result.skipped).length, 2);
  const after = await snapshot();
  assert.equal(after.food_log.length, 250);
  assert.equal(after.import_log.length, 1);
});

test("deduplication follows commit order even if an older upload has a later receipt time", async () => {
  await imported(food("old"));
  await DB.prepare("UPDATE import_log SET created = 4102444800000").run();
  const bytes = food("new");
  await imported(bytes);
  const before = await snapshot();
  assert.equal((await imported(bytes)).skipped, true);
  assert.deepEqual(await snapshot(), before);
});

test("postcommit food-intent failure reports a committed import without losing deduplication", async () => {
  await DB.prepare(`INSERT INTO food_intent_log (queued_at_ms, date, name, intended_time)
    VALUES (0, '2026-01-01', 'Synthetic meal', '12:00')`).run();
  await DB.prepare(`CREATE TRIGGER reject_matching BEFORE UPDATE ON food_intent_log
    BEGIN SELECT RAISE(ABORT, 'injected matching failure'); END`).run();
  const bytes = food("new");
  const result = await imported(bytes);
  assert.equal(result.food_log, 1);
  assert.equal(result.warning, "Import committed, but food-intent matching failed.");
  const before = await snapshot();
  assert.equal(before.food_log[0].name, "new-0");
  assert.equal(before.import_log.length, 1);
  assert.equal((await imported(bytes)).skipped, true);
  assert.deepEqual(await snapshot(), before);
});

test("overlapping distinct uploads and a failed upload cannot mix rows or publish the wrong fingerprint", async () => {
  await DB.prepare(`CREATE TRIGGER reject_import BEFORE INSERT ON food_log
    WHEN NEW.name = 'rejected-75' BEGIN SELECT RAISE(ABORT, 'injected overlapping failure'); END`).run();
  const exports = { first: food("first", 125), rejected: food("rejected", 200), last: food("last", 175) };
  const results = await Promise.all(Object.values(exports).map(upload));
  assert.deepEqual(results.map(result => result.status), [200, 400, 200]);
  const after = await snapshot();
  const label = after.food_log[0].name.split("-")[0];
  assert.ok(label === "first" || label === "last");
  assert.equal(after.food_log.length, label === "first" ? 125 : 175);
  assert.deepEqual(after.food_log.map(row => row.name), after.food_log.map((_, i) => `${label}-${i}`));
  assert.equal(after.import_log.length, 2);
  assert.equal(after.import_log.at(-1).fingerprint, createHash("sha256").update(exports[label]).digest("hex"));
  assert.equal((await imported(exports[label])).skipped, true);
});

test("10,000-row CSVs and a 5,000-day workbook replace independently", { timeout: 60_000 }, async () => {
  await seed();
  const foodBytes = food("large", 10_000);
  const workoutBytes = workout("large", 10_000);
  const workbookBytes = workbook("large", 5_000);
  assert.equal((await imported(foodBytes)).food_log, 10_000);
  assert.equal((await imported(workoutBytes)).workout_sets, 10_000);
  const result = await imported(workbookBytes);
  assert.equal(result.days, 5_000);
  assert.equal(result.micronutrients, 5_000);
  assert.equal(result.exercise_metrics, 5_000);
  const after = await snapshot();
  assert.equal(after.food_log.length, 10_000);
  assert.equal(after.food_log[9_999].name, "large-9999");
  assert.equal(after.workout_sets.length, 10_000);
  assert.equal(after.workout_sets[9_999].set_index, 10_000);
  assert.equal(after.workout_sets[9_999].weight_kg, 100);
  for (const table of workbookTables) assert.equal(after[table].length, result[table], table);
  for (const bytes of [foodBytes, workoutBytes, workbookBytes]) assert.equal((await imported(bytes)).skipped, true);
  assert.deepEqual(await snapshot(), after);
});

test("empty workbook tables still clear and invalid or empty exports leave existing data intact", async () => {
  const before = await seed();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Date", "Calories (kcal)"]]), "Calories & Macros");
  for (const bytes of ["", "Date,Food Name\n", "Date,Exercise,Reps\n", "Other,Columns\nx,y\n",
    XLSX.write(wb, { type: "buffer", bookType: "xlsx" })]) {
    assert.equal((await upload(bytes)).status, 400);
    assert.deepEqual(await snapshot(), before);
  }
  wb.Sheets["Calories & Macros"] = XLSX.utils.aoa_to_sheet([["Date", "Calories (kcal)"], ["2026-01-02", 2200]]);
  await imported(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  const after = await snapshot();
  assert.equal(after.days.length, 1);
  assert.equal(after.days[0].date, "2026-01-02");
  for (const table of workbookTables.slice(1)) assert.deepEqual(after[table], [], table);
  for (const table of ["food_log", "workout_sets"]) assert.deepEqual(after[table], before[table]);
});
