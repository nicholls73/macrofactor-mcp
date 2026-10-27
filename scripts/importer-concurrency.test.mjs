import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Control a D1 await directly; the local HTTP runtime may deliver requests serially.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/importer.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", platform: "browser",
  plugins: [{
    name: "durable-object-test-base",
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "base", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({
        contents: "export class DurableObject { constructor(ctx, env) { this.env = env; } }",
      }));
    },
  }],
});
const { ImportDO } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);

test("the import queue covers D1 awaits, deduplicates queued requests and survives a rejected request", async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let fingerprint = null, batches = 0, bodiesRead = 0;
  const statement = (sql, params = []) => ({
    sql, params,
    bind: (...values) => statement(sql, values),
    async first() { return fingerprint ? { fingerprint } : null; },
  });
  const importer = new ImportDO({}, { DB: {
    prepare: statement,
    async batch(statements) {
      if (++batches === 1) {
        entered.resolve();
        await release.promise;
      }
      assert.match(statements.at(-1).sql, /INSERT INTO import_log/);
      fingerprint = statements.at(-1).params[2];
      return [];
    },
  } });
  const request = (label = "Test") => ({
    async arrayBuffer() {
      bodiesRead++;
      return new TextEncoder().encode(`Date,Exercise,Reps\n2026-01-01,${label},10\n`).buffer;
    },
  });

  const first = importer.fetch(request());
  await entered.promise;
  const duplicate = importer.fetch(request());
  const different = importer.fetch(request("Next"));
  try {
    assert.equal(bodiesRead, 1, "queued imports must not start while the first import awaits D1");
  } finally {
    release.resolve();
    await Promise.allSettled([first, duplicate, different]);
  }
  assert.equal((await (await first).json()).ok, true);
  assert.equal((await (await duplicate).json()).skipped, true);
  assert.equal((await (await different).json()).workout_sets, 1);
  assert.equal(batches, 2);

  const rejected = importer.fetch({ async arrayBuffer() { throw new Error("injected body read failure"); } });
  const recovered = importer.fetch(request("Next"));
  await assert.rejects(rejected, /injected body read failure/);
  assert.equal((await (await recovered).json()).skipped, true);
  assert.equal(batches, 2);
});
