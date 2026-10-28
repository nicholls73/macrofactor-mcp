# MacroFactor MCP

A personal [Model Context Protocol](https://modelcontextprotocol.io) server that lets
**Claude.ai** read your MacroFactor nutrition data and log food back into MacroFactor.

MacroFactor has no public API, so this uses only **official** mechanisms:

- **Reads** come from MacroFactor's built‑in **Data Export** (`.xlsx`), parsed locally and
  uploaded to the server.
- **Writes** (logging food) go through MacroFactor's official **Apple Shortcuts**
  `Log by JSON` action on your iPhone, triggered via a notification you tap to confirm.

No reverse‑engineering, no private API — so no meaningful ToS/ban risk (see "Risk").

## Architecture

```
        reads                                   writes
  ┌──────────────┐   export.xlsx   ┌─────────────────────┐   /mcp    ┌──────────┐
  │ MacroFactor  │ ──────────────▶ │ scripts/ingest.mjs  │           │ Claude.ai│
  │   app (iOS)  │   (manual)      │ (local parse+upload)│           │   web    │
  └──────────────┘                 └──────────┬──────────┘           └────┬─────┘
        ▲                                      │ /ingest                   │ tool calls
        │ Log by JSON (tap)                    ▼                           ▼
  ┌─────┴────────┐   push    ┌────────────────────────────────────────────────┐
  │ iPhone       │ ◀──────── │  Cloudflare Worker (this repo)                   │
  │ Shortcut     │  Pushcut  │  • /mcp/<token>   authenticated MCP tools        │
  └──────────────┘           │  • /upload-export  parses an export, refreshes D1│
                             │  • /today  live today feed from the phone        │
                             │  • /pending(-water) queues for iPhone Shortcut   │
                             └────────────────────────────────────────────────┘
```

## Tools exposed to Claude

| Tool | What it does |
|------|--------------|
| `get_daily_nutrition` | Daily calories / protein / carbs / fat / expenditure / weight / steps |
| `get_micronutrients` | Daily micros — fiber, sugars, sodium, vitamins, minerals, amino acids |
| `get_food_log` | Individual foods with time, serving, macros and suspect flags; `detail: "full"` adds per-food nutrients ([response contract](docs/claude-project-doc.md#get_food_log)) |
| `get_weight_history` | Scale weight (kg and lbs), trend weight, body‑fat % |
| `get_expenditure` | MacroFactor's calculated TDEE vs intake |
| `get_steps` | Daily step count |
| `search_my_foods` | Your Favorites / Custom Foods / history, with per‑serving macros |
| `data_status` | How fresh the loaded data is (incl. the live "today" feed) |
| `get_today` | Today's running totals **live from your phone** (no export needed) — consumed, micros, targets, what's left, freshness |
| `get_targets` | Calorie/macro targets for a date (resolves weekday cycling) + weight‑goal progress; `week:true` returns all 7 weekday rows of the governing program |
| `get_goal_history` | Every weight goal ever set, with planned (rate, ETA) vs actual (trend change, duration, realized rate) per goal |
| `get_adherence` | Per‑day intake vs target — hit‑rate, surplus/deficit, avg carb/fat gap vs target, true energy balance, est. kg change |
| `weekly_summary` | ONE digest over rolling 7/14/28‑day windows — avg calories/macros, adherence (incl. carb/fat gap), trend‑weight rate, TDEE drift, training volume, recent PRs |
| `weekly_review` | The whole weekly check-in in one call: `weekly_summary` + `get_pr_alerts` + `day_of_week_patterns`, sharing one end date |
| `get_training_volume` | Working sets + tonnage per muscle group over a range |
| `get_exercise_progress` | MacroFactor's per‑exercise metrics over time (1RM/3RM/10RM, heaviest, volume, reps, sets) |
| `get_workouts` | Logged sessions with per‑exercise sets (weight × reps × RIR), duration, top set; timed/distance/assisted sets carry duration/distance/base-weight fields |
| `get_prs` | Personal records per exercise — estimated 1RM (Epley), heaviest weight, best‑set volume; duration/distance bests for timed exercises |
| `get_body_metrics` | Body measurements (cm) + visual body‑fat assessment over time |
| `get_program` | Your **planned** training program — cycles, workouts, each exercise's planned sets (type, rep range, RIR, rest) + rest days |
| `forecast_weight` | When you'll hit goal weight — OLS trend regression **and** a calorie-math ETA; their divergence flags TDEE miscalibration. Optional `target_date` → required daily deficit |
| `reconcile_energy_balance` | Your **implied** maintenance calories (from weight delta + intake) vs MacroFactor's TDEE — catches under/over-logging |
| `day_of_week_patterns` | Per-weekday averages + each weekday's share of your weekly surplus — pinpoints the single highest-leverage day |
| `get_nutrient_timing` | Food log bucketed by time of day (fasted/morning/midday/afternoon/evening/late) — reveals protein distribution |
| `detect_stall` | Plateau vs **metabolic adaptation** vs intake-drift classifier with an adaptation_kcal estimate |
| `micro_gap_analysis` | 28-day micronutrient averages vs NIH RDAs → ranked deficiency list (real export columns) |
| `get_training_day_nutrition` | Nutrition grouped by training-load tier (rest/light/moderate/heavy) — do you eat more on heavy days? |
| `get_pr_alerts` | Lifts that hit a new all-time PR (e1RM / heaviest / best-set volume / duration / distance), detected automatically on each export; includes the live front-squat:back-squat e1RM ratio (`bottleneck_kpi`) |
| `log_food` | Send a food to your phone to log in MacroFactor — optional `intended_time` records when you ate it and matches against the Food Log CSV on the next export import |
| `log_saved_food` | Log one of your saved Favorites/Custom foods by name × servings — scales the food's stored macros; disambiguates when the name matches more than one; accepts `intended_time` |
| `log_water` | Log water (mL) via MacroFactor's dedicated **Log Water** action on your phone |
| `log_weight` | Log a body weight (kg or lbs) via MacroFactor's dedicated **Log Weight** action on your phone |
| `log_recipe` | Log a named multi-ingredient meal — sums macros, attaches a `recipe[]` breakdown (reuses the food push); accepts `intended_time` |
| `relog_meal` | Re-log a past day's meal (optional hour window) as one entry — "log yesterday's lunch" in one tap; accepts `intended_time` |
| `log_foods_batch` | Log up to 20 foods in a **single** phone tap — ideal for a full meal or photo-estimated intake; each item accepts `intended_time` |
| `cancel_pending_log` | Delete queued-but-not-yet-tapped food/water/weight/batch logs ("never mind") |
| `get_day` | Full picture of a single day — nutrition totals, food log entries, body weight, and workout in one call |
| `get_pending_logs` | Queued (not-yet-tapped) food dispatches and recent dispatch history with `landed` status — see whether Claude's log reached MacroFactor |

**Proactive:** when you upload an export (and once daily via cron), the server checks your lift
log for new personal records and fires a Pushcut **"New PR"** push (set `PUSHCUT_PR_WEBHOOK_URL`);
tap it and ask Claude `get_pr_alerts` for specifics.

**Write-path audit log:** every food dispatch is recorded in `food_dispatch_log` (queued, landed, or cancelled); optional `intended_time` on all five food-write tools is stored in `food_intent_log` and matched against the Food Log CSV on the next export import. When Shortcut 2 runs after a tap, it POSTs `?ack_id=N` to `/today`, which simultaneously marks the dispatch **landed** in the audit log and refreshes live today data.

> **Three exports**, all sent to the same `/upload-export` endpoint (auto‑detected by content):
> the **.xlsx workbook** (daily totals, all micronutrients, saved‑food library, **nutrition
> targets + weight goals**, **body measurements + visual body‑fat**, your **planned training
> program**, and MacroFactor's **per‑muscle / per‑exercise training aggregates**); the **Food
> Log .csv** (every item you ate, with time + macros); and the
> **Workout Log .csv** (every set: weight, reps, RIR). Upload any subset — each refreshes only
> its own tables.
>
> **Strength numbers:** `get_prs` and `get_workouts` report the **barbell load** from your
> logged sets. `get_exercise_progress` and `get_training_volume` mirror **MacroFactor's own
> figures**, which (a) **include bodyweight contribution** for compound lifts — so a 100 kg
> front squat can show as ~160 kg — and (b) for per-muscle volume, **credit each exercise to every
> muscle it trains**, so per-muscle tonnage overlaps and sums to more than the session's bar
> tonnage. All correct; they just measure different things (bar load vs. training stimulus).

## Prerequisites

- **Node.js** matching the [package requirement](./package.json) and **Terraform 1.16.x**.
- A **Cloudflare** account with a `workers.dev` subdomain configured.
- A Cloudflare API token scoped to that account with **Workers Scripts: Edit** and
  **D1: Edit** permissions.
- The MacroFactor iOS app for the optional logging path.

## Setup

Terraform owns the Worker upload, D1 database and schema bootstrap, Durable Objects,
secret bindings, public endpoint and cron schedule. No Wrangler installation or commands
are needed. esbuild compiles TypeScript before Terraform uploads it.

### Deploy with GitHub Actions

1. Apply the MacroFactor policy in
   [cloudflare-infrastructure](https://github.com/nicholls73/cloudflare-infrastructure)
   first. Its GitHub App must have access to this repository. That repository owns
   the deployment token, dedicated R2 state bucket and credentials, and the `production`
   GitHub environment restricted to `main`.
2. In this repository's `production` environment, set secrets `INGEST_SECRET` and
   `MCP_TOKEN` using independent random URL-safe values of at least 32 characters.
   Save them in your password manager for your Shortcuts and MCP connector. Optionally
   set `PUSHCUT_WEBHOOKS` to the full JSON webhook map described below. Cloudflare/state
   credentials and variables are supplied by the infrastructure repository.
3. After merging the deployment workflow, select **Actions → Deploy → Run workflow**,
   choose **main**, and enable **bootstrap_durable_objects** for a new installation.
   It checks that the Worker is absent, creates the resources and clears the one-time
   migration setting. The initial automatic run stops before applying until you do
   this bootstrap. Never enable it for an existing Worker; use the adoption path below.

Later pushes to `main` validate, test and deploy automatically; manual normal runs are
also supported. Deploy waits for its validation job, uses one production concurrency
group plus Terraform state locking, and stops on failed or ambiguous Worker checks.
No secrets or state are uploaded as workflow artifacts. The environment restricts the
branch but has no required reviewer by default, so merging to `main` authorizes deployment.

If bootstrap partially succeeds, do not blindly rerun it: an existing Worker will be
refused. Inspect the remote resources and recover/import state before a normal run.
A failed final cleanup apply can be recovered with a normal run. If another deployment
already wrote local state, migrate that state to R2 before enabling this workflow.

### 1. Local Terraform configuration (optional)

Use the same R2 backend and credentials as Actions when deploying from your computer.
Local app development with `npm run dev` does not need cloud credentials.

```bash
npm ci
cp infra/terraform.tfvars.example infra/terraform.tfvars
cp infra/backend.hcl.example infra/backend.hcl
```

Set your Cloudflare account ID in `infra/terraform.tfvars`. Supply
`CLOUDFLARE_API_TOKEN` through your shell or password manager. Supply
`TF_VAR_ingest_secret` and `TF_VAR_mcp_token` the same way, or let Terraform prompt
for them. Use independent random values of at least 32 characters; the MCP token must
contain only letters, digits, `_` and `-`. Save both in your password manager.

Fill in the state account endpoint in `infra/backend.hcl`; supply the dedicated R2
credentials as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. For a new checkout:

```bash
terraform -chdir=infra init -backend-config=backend.hcl
```

If this checkout already has deployment state, preserve a secure backup and use
`terraform -chdir=infra init -migrate-state -backend-config=backend.hcl` instead;
confirm migration into the dedicated bucket before running Actions. Never start
from empty state against existing resources.

**State contains secrets:** Terraform's `sensitive` flag hides display values; it does
not encrypt state or saved plans. State lives in the dedicated private R2 bucket.
Restrict its credentials, protect backups, and do not commit local state or plans.

### 2. New installation only

Already deployed with Wrangler? Skip these bootstrap commands and follow
[Import an existing deployment](#import-an-existing-deployment) instead.

```bash
npm run plan -- -var=bootstrap_durable_objects=true
npm run deploy -- -var=bootstrap_durable_objects=true
npm run deploy
```

Review each plan before confirming. The first apply creates both SQLite Durable Object
classes. The final normal apply clears the creation request from Terraform's configuration
and state; it does **not** delete those classes or their data. Never save
`bootstrap_durable_objects = true` in a variable file or reuse it for routine updates.
If the initial apply fails after creating the Worker, inspect its migration status in
Cloudflare before retrying; omit the bootstrap flag if its classes already exist.

Schema-only D1 migrations live in [`migrations/`](migrations/): [`0001_initial_schema.sql`](migrations/0001_initial_schema.sql) creates the original tables and indexes; [`0002_food_log_nutrients.sql`](migrations/0002_food_log_nutrients.sql) adds per-food nutrients. Neither contains seed or application data.
Terraform runs [Wrangler D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/) through [`scripts/migrate.mjs`](scripts/migrate.mjs) after creating the database and before Worker updates. The adapter takes its database configuration from Terraform; Wrangler only manages SQL migration history, while Terraform owns infrastructure and deployment.
`npm run dev` uses the same native runner against the existing local database. The adapter recognises the legacy nutrient column and records its migration as applied without changing application rows.
Keep Wrangler and Miniflare versions aligned: a newer local runtime can update database internals that older runtimes cannot reopen.
Add future numbered SQL files; Wrangler discovers them and tracks completed files in `d1_migrations`. Never edit applied migrations, and keep data imports separate.
Changing a `CREATE TABLE IF NOT EXISTS` definition alone cannot upgrade an existing table.

Your base URL is `https://macrofactor-mcp.<your-subdomain>.workers.dev` (adjust the
prefix if you changed `worker_name`). Terraform prints the Worker name and database ID.

#### Import an existing deployment

This path adopts an existing deployment with both `MyMCP` and `ImportDO` SQLite
classes already created (migration tag `v2`). Stop if its classes or tag differ;
that requires a migration specific to the deployed version.

1. Back up the D1 database and retain the old deployment configuration. Complete
   step 1 above using the existing account, `worker_name` and `database_name`.
   Supply the existing ingest/MCP secrets and every active Pushcut webhook; import
   cannot recover secret values. If old secrets do not meet Terraform's validation,
   rotate them and update the affected Shortcuts or connector after applying.
2. Leave `bootstrap_durable_objects` **false** in all variable sources. Build and
   import the existing resources, replacing the placeholders with their actual IDs:

   ```bash
   npm run build
   terraform -chdir=infra import cloudflare_d1_database.data '<ACCOUNT_ID>/<DATABASE_ID>'
   terraform -chdir=infra import cloudflare_workers_script.mcp '<ACCOUNT_ID>/<WORKER_NAME>'
   terraform -chdir=infra import cloudflare_workers_script_subdomain.mcp '<ACCOUNT_ID>/<WORKER_NAME>'
   terraform -chdir=infra import cloudflare_workers_cron_trigger.prs '<ACCOUNT_ID>/<WORKER_NAME>'
   ```

3. Run `npm run plan`. Confirm the DB binding uses the original database ID, the
   Worker and database have no create/replace/delete actions, and there is no
   Durable Object class-creation migration. Review bindings, secrets and schedules
   for unintended changes before applying with `npm run deploy`. The new schema
   helper is expected to run its idempotent bootstrap against the imported database.

Import records ownership in Terraform state; it does not recreate the database or
Durable Objects. This adoption procedure has not been exercised against a live account.

### 3. Load your data

Use the **Update MF** Shortcut in [iPhone setup](./ios-setup.md) to send exports directly
from your phone. For computer uploads:

1. Export from MacroFactor: **More → Data Management → Data Export**.
2. Copy `ingest.config.example.json` to `ingest.config.json`; fill in your Worker URL
   and `INGEST_SECRET`.
3. Upload any subset of the three exports:
   ```bash
   npm run ingest -- /path/to/workbook.xlsx /path/to/foodlog.csv /path/to/workoutlog.csv
   ```

Each file refreshes only its own tables. For automatic updates to today's nutrition
**totals**, configure **MF Today → MCP** in [iPhone setup](./ios-setup.md). Full food
history and workout data still depend on exports.

### 4. Connect to Claude.ai

Claude.ai → **Settings → Connectors → Add custom connector**:

- URL: `https://macrofactor-mcp.<your-subdomain>.workers.dev/mcp/<MCP_TOKEN>`
- Authentication: **None** (the secret token in the URL is the authentication).

Terraform requires the MCP token. Treat the full connector URL as a secret.
Ask *"what was my protein this week?"* or *"how does my intake compare to expenditure?"*

### 5. Optional Pushcut webhooks

Follow [iPhone setup](./ios-setup.md) to create the notifications and Shortcuts. Set the
`pushcut_webhooks` Terraform map using `TF_VAR_pushcut_webhooks` (a JSON object supplied
by your secret manager) or your ignored `infra/terraform.tfvars`. For example:

```hcl
pushcut_webhooks = {
  PUSHCUT_WEBHOOK_URL = "https://api.pushcut.io/REPLACE_ME/notifications/LogFood"
}
```

Use only the entries you need. Supported binding names are validated in
[`infra/variables.tf`](./infra/variables.tf); [iPhone setup](./ios-setup.md) explains
which notification each action uses. Apply webhook changes with the normal deployment
commands below. Keep the complete map available on later deployments: an omitted entry
removes that secret binding.

## Development and updates

```bash
npm run dev
```

Local development binds to `127.0.0.1:8787`, creates a separate database automatically,
and persists local data under `.local/`. Its MCP URL is
`http://127.0.0.1:8787/mcp/local-mcp-only`; its ingest secret is `local-ingest-only`.
These fixed credentials are for local use only. Restart the command after source changes.

For subsequent deployments, supply the same Terraform variables and API token:

```bash
npm run plan
npm run deploy
```

Both commands rebuild the Worker; Terraform owns the upload. Keep runtime compatibility
and Durable Object bindings in `infra/runtime.tf.json`, shared with the local runtime.
Do not edit production secrets or bindings separately in the Cloudflare dashboard.

[CI](./.github/workflows/ci.yml) defines the automated checks. The tests
use a local Workers runtime and a mock Terraform provider; they need no cloud credentials
and do not create cloud resources or prove a live Cloudflare deployment.

## Risk

- **Data export → reads:** clean. Your own data via a feature built for it.
- **Apple Shortcuts → writes:** low risk. MacroFactor publishes the Shortcuts integration
  and endorses LLM‑driven `Log by JSON`; the write path requires a physical tap.
- We avoid the private Firestore API (App Check–blocked since ~May 2026, and a ToS breach).
- Optional: email `support@macrofactor.com` to confirm automation use in writing.

## Known limits

- Food-write tools log at the **tap time** — MacroFactor's Log by JSON action uses the current time when the Shortcut runs. Pass `intended_time` to any food-write tool to store your intended eat-time server-side; it is matched against the Food Log CSV on the next import.
- Reads are as fresh as your last export/upload. Refresh from your phone with the
  "Update MF" Shortcut (POSTs the export to `/upload-export`) or from a PC with
  `npm run ingest` — see [ios-setup.md](./ios-setup.md).
- `get_food_log` needs the **Food Log CSV** and the training tools need the **Workout Log
  CSV**; the `.xlsx` workbook gives daily totals + micros + saved foods + targets +
  body metrics + planned training program + per‑muscle/per‑exercise training aggregates.
- After deploying the per-food nutrient upgrade, **re-upload the Food Log CSV once** to
  populate previously discarded columns. Terraform's schema step adds storage without
  changing existing rows. The same export is accepted once under the new parser version;
  subsequent identical uploads skip. The daily workbook remains a separate source.
- `get_exercise_progress` for `1RM`/`3RM`/`10RM` only returns data once MacroFactor has
  computed those estimates (needs a few logged sessions); until then use `get_prs` or the
  `heaviest_weight` / `total_volume` metrics.
- Weights are in **kg** (MacroFactor exports normalise to kg even if your app shows pounds).

## Make it yours

Three constants encode preferences you'll want to adjust:

- **Timezone** — `USER_TZ` in `src/db/utils.ts` decides what "today" means (defaults to
  `UTC`). Set it to your IANA timezone (e.g. `America/New_York`) or post-midnight `/today`
  updates can land on the wrong day.
- **Bottleneck KPI** — `squatBottleneck()` in `src/db/prs.ts` tracks a front-squat :
  back-squat e1RM ratio surfaced by `get_pr_alerts` / `weekly_review`. Swap the exercise
  pair for your own, or ignore it — it returns `null` when either lift is absent.
- **Micronutrient RDAs** — `MICRO_RDA` in `src/db/analytics.ts` uses NIH DRI values for an
  adult male 19–50. Adjust the table for your demographic.

## License

MIT — see [LICENSE](./LICENSE).
