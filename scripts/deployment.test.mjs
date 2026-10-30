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

test("Access owner can read MCP data through the OAuth endpoint", { timeout: 60_000 }, async t => {
  const mf = await startLocal({
    bindings: { ACCESS_AUD: "macrofactor-audience", ACCESS_OWNER_EMAIL: "owner@example.com" },
    access: { aud: "macrofactor-audience", identity: { email: "OWNER@example.com" } },
  });
  t.after(() => mf.dispose());
  const client = new Client({ name: "oauth-test", version: "1" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/mcp/oauth"), {
    fetch: (url, init) => mf.dispatchFetch(url.toString(), init),
  }));
  const result = await client.callTool({ name: "data_status", arguments: {} });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(JSON.parse(result.content[0].text).food_log.n, 0);

  // Access identity cannot replace the phone's independently checked credential.
  const denied = await mf.dispatchFetch("http://localhost/upload-export", { method: "POST", body: "bad csv" });
  assert.equal(denied.status, 401);
  const uploaded = await mf.dispatchFetch("http://localhost/upload-export", {
    method: "POST", headers: { "x-ingest-secret": "local-ingest-only" },
    body: "Date,Workout,Exercise,Set Type,Reps,Weight\n2026-01-01,Test,Leg Press,Standard Set,10,100\n",
  });
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  assert.equal((await uploaded.json()).ok, true);
});

test("OAuth requires the configured Access application and owner, never caller-supplied headers", { timeout: 120_000 }, async t => {
  const bindings = { ACCESS_AUD: "macrofactor-audience", ACCESS_OWNER_EMAIL: "owner@example.com" };
  for (const [name, options] of [
    ["no Access context", { bindings }],
    ["different application", { bindings, access: { aud: "other-app", identity: { email: "owner@example.com" } } }],
    ["different user", { bindings, access: { aud: "macrofactor-audience", identity: { email: "other@example.com" } } }],
    ["missing identity", { bindings, access: { aud: "macrofactor-audience" } }],
    ["missing audience config", { bindings: { ACCESS_OWNER_EMAIL: "owner@example.com" }, access: { aud: "macrofactor-audience", identity: { email: "owner@example.com" } } }],
    ["missing owner config", { bindings: { ACCESS_AUD: "macrofactor-audience" }, access: { aud: "macrofactor-audience", identity: { email: "owner@example.com" } } }],
  ]) {
    await t.test(name, async () => {
      const mf = await startLocal(options);
      try {
        for (const method of ["GET", "POST", "DELETE"]) {
          const response = await mf.dispatchFetch("http://localhost/mcp/oauth", {
            method,
            headers: {
              Authorization: "Bearer local-mcp-only",
              "Cf-Access-Jwt-Assertion": "forged-jwt",
              "Cf-Access-Authenticated-User-Email": "owner@example.com",
            },
          });
          assert.equal(response.status, 401);
        }
      } finally {
        await mf.dispose();
      }
    });
  }
});

test("removing MCP_TOKEN never makes the legacy endpoint public", { timeout: 60_000 }, async t => {
  const mf = await startLocal({ bindings: { MCP_TOKEN: "" } });
  t.after(() => mf.dispose());
  for (const path of ["/mcp", "/mcp/", "/mcp/local-mcp-only", "/mcp/oauth"]) {
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await mf.dispatchFetch(`http://localhost${path}`, { method });
      assert.equal(response.status, 401);
    }
  }
});
