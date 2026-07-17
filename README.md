# ZVA Demo MCP Server

A small Cloudflare Worker that demos a Zoom Virtual Agent (ZVA) backend: order
details, customer account lookups, and product inventory, backed by a
Cloudflare D1 database. It exposes the same three lookups two ways:

- **MCP** at `/mcp` (Streamable HTTP, current spec) and `/sse` (legacy SSE
  transport) — same tools either way, for AI clients that speak the Model
  Context Protocol (Claude Desktop, the Cloudflare AI Playground, MCP
  Inspector, Zoom Virtual Agent, or a custom agent).
- **Plain REST** at `/api/...` — for Zoom Virtual Agent's flow-builder
  **Custom API** / Action step, which calls a regular JSON HTTP endpoint, not
  raw MCP. Use this path to actually wire the data into a ZVA bot flow.
- **Admin UI** at `/db` — a small editable-table view over all four tables,
  meant to be published at `https://app.eno.solutions/db` behind your
  existing Cloudflare Access (Google SSO) policy.

## What's included

| Data | MCP tool | REST endpoint |
|---|---|---|
| Order details | `get_order_details(order_id)` | `GET /api/orders/:order_id` |
| Customer account lookup | `lookup_customer_account(query)` | `GET /api/customers?query=` |
| Product inventory | `check_product_inventory(query)` | `GET /api/products?query=` |
| Any collection (generic) | `query_collection(collection, query?)` | `GET /api/collections/:name?query=` |

`query` matches the row's ID plus any text column (email, name, phone
number, etc. — whatever text columns currently exist). Sample seed data
lives in `schema.sql` (8 customers, 8 products, 8 orders with line items).

Customer phone numbers use Ofcom's reserved fictional-use ranges (E.164
UK): `+441632960000`–`+441632960999` (geographic) and
`+447700900000`–`+447700900999` (mobile) — safe to generate freely, never
real subscribers. Two records always exist with fixed, non-Ofcom numbers for
testing: **Joe Bloggs** (`+447794516641`) and **James Smith**
(`+442038852824`). Generate Records enforces both rules deterministically
after the AI response comes back (see `enforcePhoneFormat` /
`enforceGuaranteedCustomers` in `src/admin.ts`), so they hold regardless of
business type or what the model actually generates.

`query_collection` / `/api/collections/:name` works over **any** table,
including ones you add later via **+ Collection** in the admin UI — no code
change needed for new collections to become queryable.

## Project layout

```
src/index.ts   MCP agent (McpAgent) + Worker fetch handler / router
src/schema.ts  Shared live D1 schema introspection (tables, columns, FKs)
src/db.ts      Shared query logic used by both MCP and REST — schema-driven
src/rest.ts    Plain REST router for ZVA Custom API actions
src/admin.ts   Editable admin UI + JSON API, served at /db
schema.sql     D1 schema + seed data
wrangler.jsonc Worker + Durable Object + D1 binding config
```

## Prerequisites

- Node.js 18+
- A Cloudflare account (free tier is fine) and the [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (installed as a dependency below)

## Setup

```bash
npm install
npx wrangler login          # opens a browser to authorize Wrangler

# Create the D1 database
npx wrangler d1 create zva-demo-db
# Copy the returned database_id into wrangler.jsonc (d1_databases[0].database_id)

# Load schema + seed data
npm run db:init             # local dev DB
npm run db:init:remote      # the real, deployed D1 instance

# Generate Records needs an OpenAI key with billing set up (platform.openai.com —
# a ChatGPT subscription alone does not include API access)
npx wrangler secret put OPENAI_API_KEY   # prompts for the key, stores it encrypted
# For local `wrangler dev`, instead create a .dev.vars file (gitignored):
#   echo 'OPENAI_API_KEY=sk-...' > .dev.vars

# Run locally
npm run dev                 # serves http://localhost:8787/mcp and /api/*

# Deploy
npm run deploy               # prints your worker URL, e.g. https://zva-demo-mcp.<subdomain>.workers.dev
```

## Testing the MCP endpoint

Point the [Cloudflare AI Playground](https://playground.ai.cloudflare.com/) or
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) at:

```
https://zva-demo-mcp.<your-subdomain>.workers.dev/mcp
```

For MCP clients that only support local/stdio servers (e.g. Claude Desktop),
use the `mcp-remote` proxy to bridge to the remote endpoint — see
[Cloudflare's remote MCP guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/).

## Wiring into a Zoom Virtual Agent flow

In the ZVA flow builder, add an **Action** step calling a **Custom API**, and
point it at the REST endpoints above, e.g.:

```
GET https://zva-demo-mcp.<your-subdomain>.workers.dev/api/orders/ORD-5001
GET https://zva-demo-mcp.<your-subdomain>.workers.dev/api/customers?query=dana.whitfield@brightloop.io
GET https://zva-demo-mcp.<your-subdomain>.workers.dev/api/products?query=headset
```

Map the JSON response fields to flow variables to surface them in the bot's
reply. This demo has no authentication — for anything beyond a demo, add an
API key check in `src/rest.ts` before pointing a real ZVA instance at it.

## Publishing the DB admin UI at app.eno.solutions/db

`/db` is served by this same Worker (it already owns the D1 binding), so
there's no separate app to deploy — you just need to route that one path on
your zone to this Worker, alongside whatever already serves the rest of
`app.eno.solutions`. This does **not** touch your existing Worker's code.

1. Deploy this Worker (`npm run deploy`) so it exists in your account.
2. Add a route for just this path, either:
   - **Dashboard:** Workers & Pages → `zva-demo-mcp` → Settings → Domains &
     Routes → Add → pattern `app.eno.solutions/db*`, or
   - **wrangler.jsonc:** uncomment the `routes` block at the bottom, set
     `zone_name` to your actual zone (e.g. `eno.solutions`), then
     `npm run deploy` again.
3. Since Cloudflare Access already protects `app.eno.solutions`, the `/db`
   path inherits that policy automatically once routed — no new Access
   application needed. The page reads the `Cf-Access-Authenticated-User-Email`
   header Access injects, just to show who's signed in; it doesn't enforce
   auth itself, so don't expose this route without Access (or your own
   auth) in front of it.
4. Add a link to `/db` from your `app.eno.solutions` homepage yourself if you
   want it discoverable from `/` — this Worker only serves the `/db` path
   itself.

Every cell marked editable in the table saves via `PATCH` on blur/change;
each table's primary key column is read-only (shown as plain text).

## Admin UI features

The schema is introspected live from D1 (`sqlite_master` + `PRAGMA
table_info`) rather than hardcoded, so the UI adapts automatically as you
change things:

- **+ Column** — adds a column to the current collection (`ALTER TABLE ...
  ADD COLUMN`).
- **Rename column** — click directly on a column header and edit it; renames
  on blur (`ALTER TABLE ... RENAME COLUMN`).
- **+ Row** — inserts a new row with sensible defaults (auto-generated ID,
  empty/zero values, and any required foreign keys borrowed from an existing
  row so the insert doesn't violate D1's FK constraints) so you can edit it
  in place immediately.
- **+ Collection** — creates a brand new table (`id TEXT PRIMARY KEY` plus
  whatever columns you define) and it shows up as a new tab right away.
- **✨ Generate Records** — pick a business type (25 presets, or "Other" to
  describe your own) and it replaces the rows in every collection with data
  generated for that business via OpenAI (e.g. a travel company gets
  destination packages as "products"; a clothing company gets garments).
  Fires one small structured-output request per collection *in parallel*
  (rather than one giant combined request) for speed and reliability, then
  repairs foreign keys afterward using D1's real `PRAGMA foreign_key_list`
  metadata — this works for any collection, including ones you added
  yourself, not just the original four tables. The modal shows a live
  "Processing… (Ns)" indicator and gives up client-side after 28s with a
  clear failed state (the server-side generation may still complete after
  that — reload the table if so).

**Requires an OpenAI API key** with billing enabled at platform.openai.com
(see Setup above) — stored as a Wrangler secret, never committed. If
Generate Records errors, the message returned is OpenAI's own error text
(e.g. invalid key, rate limit); for anything unclear, `npx wrangler tail`
shows the full request.

## Notes

- This is a mock backend with a handful of seed rows for demo purposes, not
  a real order/inventory system.
- MCP (`/mcp`) and ZVA's Custom API action (`/api/...`) are different
  protocols — the MCP endpoint is for MCP-speaking AI clients/tooling, the
  REST endpoints are what ZVA itself can actually call from a flow.
- The three named MCP tools/REST endpoints (`get_order_details`,
  `lookup_customer_account`, `check_product_inventory`) and the generic
  `query_collection` tool all introspect the live schema (`src/schema.ts`)
  rather than hardcoding column names, so renaming or adding columns —
  even the ones just added (`phone_number`, `delivery_date`, etc.) — doesn't
  break them, and brand new collections are automatically reachable through
  `query_collection` / `/api/collections/:name` with no code change. The one
  thing that *can't* be papered over: if you rename or delete the table
  itself (`orders`, `customers`, `products`) or the foreign key linking them
  (e.g. `orders.customer_id`), the tool that depends on that specific
  relationship returns a clear error naming what's missing rather than
  silently breaking — that's a real behavior change, not a bug.
- The JSON shape returned by `get_order_details` / `lookup_customer_account`
  nests related rows under the actual table name (e.g. `order.customers`,
  `order.order_items`) instead of flattening prefixed fields like
  `customer_name` — this is what makes it schema-agnostic. If you've already
  wired a ZVA flow to the old flattened shape, its field mappings will need
  updating.
