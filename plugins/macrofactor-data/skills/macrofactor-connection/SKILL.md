---
name: macrofactor-connection
description: Check whether MacroFactor Data is connected and show how much nutrition, food and workout data is available and when it was last imported. Use during plugin setup or when the user asks whether the connection works.
---

# Check MacroFactor Data

Use the plugin's `data_status` MCP tool for an authenticated, read-only check.

If the tool is unavailable, direct the user to **Plugins → MacroFactor Data → Connect**.
The connection opens Cloudflare sign-in through OAuth. Have the user sign in with
the Cloudflare account allowed by the server's owner policy and complete consent
in the browser. No application token is needed in the connection form.
Never request credentials in chat, put credentials in plugin files, extract
credentials from another session, or rotate a token without an explicit request.

After connection, retry tool discovery once and call `data_status`. Report:

- Whether the authenticated call succeeded.
- The available row counts and most recent dates for daily nutrition, food logs
  and workouts, using the returned fields.
- Whether the requested period is covered, empty or out of date.

An empty dataset can still be a working connection. Missing tables, failed tool
calls and missing tools are different conditions; report the observed condition
without guessing. Do not claim success from installation, an HTTP health response,
or the plugin's presence alone. Summarize errors without echoing credentials,
connector URLs containing tokens, or raw provider responses.

Full history depends on uploaded exports. Today's phone feed is a separate source;
use `get_today` when the user asks about its freshness. Do not upload, log, enqueue,
acknowledge or delete anything as a connection test.
