import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function applyMigrations(query) {
  await query(await readFile(new URL("../migrations/0001_initial_schema.sql", import.meta.url), "utf8"));
  const result = await query("PRAGMA table_info(food_log)");
  const columns = result?.[0]?.results;
  if (!Array.isArray(columns) || columns.length === 0 || columns.some(column => typeof column?.name !== "string")) {
    throw new Error("D1 returned invalid food_log schema metadata; upgrade stopped.");
  }
  if (!columns.some(column => column.name === "nutrients")) {
    await query(await readFile(new URL("../migrations/0002_food_log_nutrients.sql", import.meta.url), "utf8"));
  }
}

export async function applySchema(env = process.env, request = fetch) {
  const { CF_ACCOUNT_ID: account, CF_DATABASE_ID: database, CLOUDFLARE_API_TOKEN: token } = env;
  if (!/^[a-f0-9]{32}$/.test(account ?? "") || !/^[a-f0-9-]{36}$/.test(database ?? "") || !token) {
    throw new Error("CF_ACCOUNT_ID, CF_DATABASE_ID and CLOUDFLARE_API_TOKEN are required.");
  }
  const query = async sql => {
    // REST /query supports semicolon-separated SQL as a batch (unlike D1 prepare).
    // https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
    let response;
    try {
      response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sql }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new Error("D1 schema request failed; Terraform apply stopped.");
    }
    // Do not print response bodies: provider errors may echo SQL or credentials.
    if (!response.ok) throw new Error(`D1 schema request failed (HTTP ${response.status}).`);
    const payload = await response.json().catch(() => {
      throw new Error("D1 returned an invalid JSON response; Terraform apply stopped.");
    });
    if (payload?.success !== true || !Array.isArray(payload.result) || payload.result.length === 0 ||
        payload.result.some(result => result?.success !== true)) {
      throw new Error("D1 rejected one or more schema statements; Terraform apply stopped.");
    }
    return payload.result;
  };
  await applyMigrations(query);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await applySchema();
    console.log("D1 schema applied.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
