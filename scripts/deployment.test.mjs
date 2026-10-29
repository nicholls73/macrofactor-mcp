import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startLocal } from "./dev.mjs";
import { checkDeployment } from "./preflight.mjs";

const env = {
  CF_ACCOUNT_ID: "a".repeat(32),
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
    () => null,
    () => undefined,
    () => Response.json(null),
    () => Response.json(null, { status: 404 }),
    () => new Response("secret-token", { status: 403 }),
    () => Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 401 }),
    () => Response.json({ success: false, errors: [{ code: 99999 }] }, { status: 404 }),
    () => Response.json({ success: false, errors: null }, { status: 404 }),
    () => Response.json({ success: false, errors: [null] }, { status: 404 }),
    () => Response.json({ success: true, result: null }),
    () => { throw new Error("secret-token"); },
  ]) {
    for (const BOOTSTRAP of ["true", "false"]) {
      await assert.rejects(checkDeployment({ ...settings, BOOTSTRAP }, response), error =>
        error.name === "Error" && /Cannot verify Worker status/.test(error.message) &&
        !error.message.includes("secret-token"));
    }
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

test("MCP bearer authentication permits data checks and rejects missing or invalid credentials", { timeout: 60_000 }, async t => {
  const mf = await startLocal();
  t.after(() => mf.dispose());
  for (const authorization of [undefined, "Bearer wrong-token", "Basic local-mcp-only", "local-mcp-only", "Bearer"]) {
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await mf.dispatchFetch("http://localhost/mcp", {
        method, headers: authorization ? { Authorization: authorization } : {},
      });
      assert.equal(response.status, 401);
    }
  }
  const wrongPath = await mf.dispatchFetch("http://localhost/mcp/wrong-token", {
    headers: { Authorization: "Bearer local-mcp-only" },
  });
  assert.equal(wrongPath.status, 401);

  for (const authorization of ["Bearer local-mcp-only", "bearer local-mcp-only"]) {
    const client = new Client({ name: "plugin-auth-test", version: "1" });
    try {
      await assert.doesNotReject(client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        requestInit: { headers: { Authorization: authorization } },
        fetch: (url, init) => mf.dispatchFetch(url.toString(), init),
      })));
      const { tools } = await client.listTools();
      assert.equal(tools.find(tool => tool.name === "data_status")?.annotations?.readOnlyHint, true);
      const result = await client.callTool({ name: "data_status", arguments: {} });
      assert.ok(!result.isError, JSON.stringify(result));
      const status = JSON.parse(result.content[0].text);
      assert.equal(status.days.n, 0);
      assert.equal(status.food_log.n, 0);
    } finally {
      await client.close();
    }
  }
});
