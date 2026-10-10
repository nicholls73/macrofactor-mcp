import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function applySchema(env = process.env, request = fetch) {
  const { CF_ACCOUNT_ID: account, CF_DATABASE_ID: database, CLOUDFLARE_API_TOKEN: token } = env;
  if (!/^[a-f0-9]{32}$/.test(account ?? "") || !/^[a-f0-9-]{36}$/.test(database ?? "") || !token) {
    throw new Error("CF_ACCOUNT_ID, CF_DATABASE_ID and CLOUDFLARE_API_TOKEN are required.");
  }
  const sql = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
  const response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql }),
    signal: AbortSignal.timeout(60_000),
  });
  // Do not print response bodies: provider errors may echo SQL or credentials.
  if (!response.ok) throw new Error(`D1 schema request failed (HTTP ${response.status}).`);
  const payload = await response.json().catch(() => {
    throw new Error("D1 returned an invalid JSON response; Terraform apply stopped.");
  });
  if (payload?.success !== true || !Array.isArray(payload.result) || payload.result.length === 0 ||
      payload.result.some(result => result?.success !== true)) {
    throw new Error("D1 rejected one or more schema statements; Terraform apply stopped.");
  }
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
