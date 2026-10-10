import { pathToFileURL } from "node:url";

export async function checkDeployment(env = process.env, request = fetch) {
  const { TF_VAR_account_id: account, CLOUDFLARE_API_TOKEN: token,
    TF_VAR_worker_name: worker, BOOTSTRAP: bootstrap } = env;
  if (!/^[a-f0-9]{32}$/.test(account ?? "") || !token ||
      !/^[a-z0-9][a-z0-9-]*$/.test(worker ?? "") || !["true", "false"].includes(bootstrap)) {
    throw new Error("Deployment account, token, Worker name and bootstrap mode are required.");
  }
  let response, body;
  try {
    response = await request(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/settings`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    body = await response.json();
  } catch {
    throw new Error("Cannot verify Worker status; deployment stopped.");
  }
  const absent = response.status === 404 && body?.success === false &&
    Array.isArray(body.errors) && body.errors.length === 1 && body.errors[0]?.code === 10007;
  const exists = response.ok && body?.success === true &&
    body.result !== null && typeof body.result === "object" && !Array.isArray(body.result);
  if (!absent && !exists) throw new Error(`Cannot verify Worker status (HTTP ${response.status}); deployment stopped.`);
  if (bootstrap === "true" && exists) {
    throw new Error("Worker already exists. Do not replay bootstrap; inspect/import its state and use a normal deployment.");
  }
  if (bootstrap === "false" && absent) {
    throw new Error("Worker does not exist. Run Deploy manually on main with bootstrap_durable_objects enabled for the first deployment.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkDeployment();
    console.log("Worker lifecycle check passed.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
