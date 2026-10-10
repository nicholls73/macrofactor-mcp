import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { applySchema } from "./schema.mjs";
import { startLocal } from "./dev.mjs";
import { checkDeployment } from "./preflight.mjs";

const env = {
  CF_ACCOUNT_ID: "a".repeat(32),
  CF_DATABASE_ID: "00000000-0000-0000-0000-000000000000",
  CLOUDFLARE_API_TOKEN: "test-token",
};

test("deployment preflight refuses migration replay and requires explicit first bootstrap", async () => {
  const settings = {
    TF_VAR_account_id: env.CF_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
    TF_VAR_worker_name: "macrofactor-mcp", BOOTSTRAP: "true",
  };
  const missing = async () => Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
  const present = async (url, init) => {
    assert.match(url, /\/workers\/scripts\/macrofactor-mcp\/settings$/);
    assert.equal(init.headers.Authorization, "Bearer test-token");
    assert.equal(init.redirect, "error");
    return Response.json({ success: true, result: { bindings: [] } });
  };
  await checkDeployment(settings, missing);
  await assert.rejects(checkDeployment(settings, present), /Do not replay bootstrap/);
  await checkDeployment({ ...settings, BOOTSTRAP: "false" }, present);
  await assert.rejects(checkDeployment({ ...settings, BOOTSTRAP: "false" }, missing), /first deployment/);
  await assert.rejects(checkDeployment({}, missing), /are required/);
  for (const response of [
    () => new Response("secret-token", { status: 403 }),
    () => Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 401 }),
    () => Response.json({ success: false, errors: [{ code: 99999 }] }, { status: 404 }),
    () => Response.json({ success: true, result: null }),
    () => { throw new Error("secret-token"); },
  ]) {
    await assert.rejects(checkDeployment(settings, response), error =>
      /Cannot verify Worker status/.test(error.message) && !error.message.includes("secret-token"));
  }
});

test("schema helper sends the full SQL batch and accepts multiple successful results", async () => {
  await applySchema(env, async (url, init) => {
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.CF_DATABASE_ID}/query`);
    assert.equal(init.headers.Authorization, "Bearer test-token");
    assert.equal(init.redirect, "error");
    assert.equal(JSON.parse(init.body).sql, await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    return Response.json({ success: true, result: [{ success: true }, { success: true }] });
  });
});

test("schema failures stop deployment without leaking API bodies", async () => {
  await assert.rejects(applySchema({}, () => { throw new Error("must not call API"); }), /are required/);
  await assert.rejects(applySchema(env, async () => new Response("secret-token", { status: 403 })), /HTTP 403/);
  await assert.rejects(applySchema(env, async () => new Response("secret-token")),
    { message: "D1 returned an invalid JSON response; Terraform apply stopped." });
  for (const body of [
    { success: false, errors: [{ message: "secret-token" }] },
    { success: true, result: [] },
    { success: true, result: [{ success: true }, { success: false }] },
  ]) {
    await assert.rejects(applySchema(env, async () => Response.json(body)), /D1 rejected/);
  }
});

test("replacement bundle runs with D1 and both Durable Objects", { timeout: 60_000 }, async () => {
  const mf = await startLocal();
  try {
    const unauthenticated = await mf.dispatchFetch("http://localhost/mcp");
    assert.equal(unauthenticated.status, 401);
    const noIngestKey = await mf.dispatchFetch("http://localhost/today", { method: "POST", body: "{}" });
    assert.equal(noIngestKey.status, 401);

    const response = await mf.dispatchFetch("http://localhost/mcp/local-mcp-only", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" },
      } }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /MacroFactor/);

    const csv = "Date,Workout,Exercise,Set Type,Reps,Weight\n2026-01-01,Test,Leg Press,Standard Set,10,100\n";
    const imported = await mf.dispatchFetch("http://localhost/upload-export", {
      method: "POST", headers: { "x-ingest-secret": "local-ingest-only" }, body: csv,
    });
    assert.equal(imported.status, 200, await imported.clone().text());
    assert.equal((await imported.json()).ok, true);
    const db = await mf.getD1Database("DB");
    assert.equal((await db.prepare("SELECT count(*) AS n FROM workout_sets").first()).n, 1);
  } finally {
    await mf.dispose();
  }
});
