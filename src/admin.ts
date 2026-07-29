// Editable admin UI for the demo D1 tables, served at /db.
// Intended to sit behind Cloudflare Access (Google SSO) on a zone route
// like app.eno.solutions/db* — this Worker does not implement its own
// auth, it trusts Access to gate access before requests arrive.
//
// Schema is introspected live from D1 (see src/schema.ts) rather than
// hardcoded, so adding/renaming columns or adding whole new "collections"
// (tables) from the UI just works without a code change.

import {
	type ColumnType,
	type ForeignKey,
	type TableConfig,
	assertIdentifier,
	columnTypeToSql,
	getAllTableConfigs,
	getForeignKeys,
	getTableConfig,
	listTableNames,
	topoSortByForeignKeys,
} from "./schema";

interface Env {
	DB: D1Database;
	OPENAI_API_KEY: string;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function listRows(db: D1Database, table: TableConfig) {
	const cols = table.columns.map((c) => c.name).filter((n) => n !== "rowid");
	const select = table.pkIsRowid ? `rowid AS rowid, ${cols.join(", ")}` : cols.join(", ");
	const { results } = await db
		.prepare(`SELECT ${select} FROM "${table.name}" ORDER BY ${table.pk === "rowid" ? "rowid" : `"${table.pk}"`}`)
		.all();
	return results;
}

async function patchRow(
	db: D1Database,
	table: TableConfig,
	pkValue: string,
	column: string,
	value: string,
) {
	const colConfig = table.columns.find((c) => c.name === column);
	if (!colConfig) throw new Error(`Unknown column "${column}"`);
	if (!colConfig.editable) throw new Error(`Column "${column}" is not editable`);

	const bindValue = colConfig.type === "number" ? Number(value) : value;
	if (colConfig.type === "number" && Number.isNaN(bindValue)) {
		throw new Error(`"${value}" is not a valid number`);
	}

	const pkExpr = table.pk === "rowid" ? "rowid" : `"${table.pk}"`;
	await db
		.prepare(`UPDATE "${table.name}" SET "${column}" = ? WHERE ${pkExpr} = ?`)
		.bind(bindValue, pkValue)
		.run();
}

async function addColumn(db: D1Database, tableName: string, columnName: string, type: ColumnType) {
	assertIdentifier(columnName, "column name");
	const config = await getTableConfig(db, tableName);
	if (config.columns.some((c) => c.name === columnName)) {
		throw new Error(`Column "${columnName}" already exists on "${tableName}"`);
	}
	await db
		.prepare(`ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${columnTypeToSql(type)}`)
		.run();
}

async function renameColumn(db: D1Database, tableName: string, oldName: string, newName: string) {
	assertIdentifier(newName, "column name");
	const config = await getTableConfig(db, tableName);
	if (!config.columns.some((c) => c.name === oldName)) {
		throw new Error(`Unknown column "${oldName}" on "${tableName}"`);
	}
	if (config.columns.some((c) => c.name === newName)) {
		throw new Error(`Column "${newName}" already exists on "${tableName}"`);
	}
	await db
		.prepare(`ALTER TABLE "${tableName}" RENAME COLUMN "${oldName}" TO "${newName}"`)
		.run();
}

async function nextGeneratedId(db: D1Database, table: TableConfig): Promise<string | null> {
	if (table.pkIsRowid) return null;
	const rows = await db.prepare(`SELECT "${table.pk}" AS pk FROM "${table.name}"`).all<{ pk: string }>();
	let maxN = 0;
	let prefix = table.name.slice(0, 3).toUpperCase() + "-";
	for (const row of rows.results) {
		const m = /^([A-Za-z]+-?)(\d+)$/.exec(String(row.pk));
		if (m) {
			prefix = m[1];
			maxN = Math.max(maxN, parseInt(m[2], 10));
		}
	}
	return `${prefix}${maxN + 1}`;
}

async function addRow(db: D1Database, tableName: string, values: Record<string, unknown>) {
	const table = await getTableConfig(db, tableName);

	if (!table.pkIsRowid && (values[table.pk] === undefined || values[table.pk] === "")) {
		values = { ...values, [table.pk]: await nextGeneratedId(db, table) };
	}

	// D1 enforces foreign keys, so a blank orders.customer_id (etc.) would
	// fail. For any FK column the caller didn't supply, borrow an existing
	// value from the referenced table so the insert succeeds; the user can
	// change it afterwards like any other editable cell.
	const fks = await getForeignKeys(db, tableName);
	for (const fk of fks) {
		if (values[fk.from] !== undefined && values[fk.from] !== "") continue;
		const row = await db
			.prepare(`SELECT "${fk.to}" AS v FROM "${fk.table}" LIMIT 1`)
			.first<{ v: unknown }>();
		if (row) values = { ...values, [fk.from]: row.v };
	}

	// Always supply a value for every remaining column (defaulting to ""
	// / 0) — some columns in the original demo schema (e.g. customers.name)
	// are NOT NULL with no default, so a bare INSERT would fail otherwise.
	const cols: string[] = [];
	const placeholders: string[] = [];
	const binds: unknown[] = [];
	for (const col of table.columns) {
		if (col.name === "rowid") continue;
		const supplied = values[col.name];
		cols.push(`"${col.name}"`);
		placeholders.push("?");
		if (col.type === "number") {
			binds.push(supplied === undefined || supplied === "" ? 0 : Number(supplied));
		} else {
			binds.push(supplied === undefined ? "" : String(supplied));
		}
	}

	await db
		.prepare(`INSERT INTO "${tableName}" (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`)
		.bind(...binds)
		.run();
}

async function createCollection(
	db: D1Database,
	name: string,
	columns: { name: string; type: ColumnType }[],
) {
	assertIdentifier(name, "collection name");
	const existing = await listTableNames(db);
	if (existing.includes(name)) throw new Error(`A collection named "${name}" already exists`);

	const extraCols = columns.length ? columns : [{ name: "name", type: "text" as ColumnType }];
	for (const c of extraCols) assertIdentifier(c.name, "column name");

	const colDefs = extraCols.map((c) => `"${c.name}" ${columnTypeToSql(c.type)}`).join(", ");
	await db.prepare(`CREATE TABLE "${name}" (id TEXT PRIMARY KEY, ${colDefs})`).run();
}

// ---- Generate Records (OpenAI) ----

const BUSINESS_TYPES = [
	"Holiday & Travel",
	"Clothing & Apparel",
	"Electronics & Gadgets",
	"Restaurant & Food Delivery",
	"Grocery & Supermarket",
	"Furniture & Home Decor",
	"Pet Supplies",
	"Beauty & Cosmetics",
	"Sporting Goods",
	"Toys & Games",
	"Jewelry & Watches",
	"Books & Media",
	"Automotive Parts",
	"Office Supplies",
	"Musical Instruments",
	"Baby & Kids Products",
	"Outdoor & Camping Gear",
	"Wine & Spirits",
	"Art & Crafts Supplies",
	"Health & Pharmacy",
	"Software & SaaS",
	"Real Estate Listings",
	"Insurance Products",
	"Fitness & Gym Equipment",
	"Coffee & Specialty Beverages",
];

function rowCountFor(tableName: string): number {
	if (tableName === "customers") return 6;
	if (tableName === "products") return 9;
	if (tableName === "orders") return 8;
	if (tableName === "order_items") return 12;
	return 6;
}

/** OpenAI structured-output ("strict" json_schema) shape for one table's rows. */
function buildTableSchema(table: TableConfig) {
	const itemProps: Record<string, unknown> = {};
	const itemRequired: string[] = [];
	for (const col of table.columns) {
		if (col.name === "rowid") continue;
		itemProps[col.name] = { type: col.type === "number" ? "number" : "string" };
		itemRequired.push(col.name);
	}
	return {
		type: "object",
		properties: {
			rows: {
				type: "array",
				items: {
					type: "object",
					properties: itemProps,
					required: itemRequired,
					additionalProperties: false,
				},
			},
		},
		required: ["rows"],
		additionalProperties: false,
	};
}

function buildTablePrompt(businessType: string, table: TableConfig): string {
	const count = rowCountFor(table.name);
	const colDesc = table.columns
		.filter((c) => c.name !== "rowid")
		.map((c) => `${c.name} (${c.type})`)
		.join(", ");
	return [
		`Generate about ${count} realistic sample rows for the "${table.label}" collection of a demo backend belonging to a "${businessType}" business.`,
		`Columns: ${colDesc}.`,
		`Make every value specific and appropriate to a "${businessType}" business — names, categories, statuses, everything should read like real data for that kind of company, not generic placeholders.`,
		`Use plausible ID-style codes (e.g. ACC-1001, ORD-5001, SKU-2001 style) for any column that looks like an identifier or foreign key — exact cross-table matching isn't necessary, that gets reconciled separately.`,
		`Output JSON only.`,
	].join("\n");
}

async function callOpenAI(
	apiKey: string,
	businessType: string,
	table: TableConfig,
): Promise<Record<string, unknown>[]> {
	const res = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: "gpt-4o-mini",
			messages: [
				{
					role: "system",
					content: "You generate realistic sample demo data as strict JSON matching the given schema.",
				},
				{ role: "user", content: buildTablePrompt(businessType, table) },
			],
			response_format: {
				type: "json_schema",
				json_schema: {
					name: `${table.name}_rows`,
					strict: true,
					schema: buildTableSchema(table),
				},
			},
			max_tokens: 2000,
		}),
	});

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`OpenAI error for "${table.name}" (${res.status}): ${text.slice(0, 300)}`);
	}

	const data: any = await res.json();
	const content = data.choices?.[0]?.message?.content;
	if (!content) throw new Error(`OpenAI returned no content for "${table.name}"`);

	let parsed: any;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error(`OpenAI didn't return valid JSON for "${table.name}"`);
	}
	return Array.isArray(parsed.rows) ? parsed.rows : [];
}

// UK numbers reserved by Ofcom for fictional/drama use — safe to generate
// freely, guaranteed never to be a real subscriber. E.164 formatted.
const OFCOM_MOBILE_PREFIX = "+447700900"; // 07700 900000-900999
const OFCOM_GEOGRAPHIC_PREFIX = "+441632960"; // 01632 960000-960999

function randomOfcomPhoneNumber(): string {
	const suffix = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
	const prefix = Math.random() < 0.5 ? OFCOM_MOBILE_PREFIX : OFCOM_GEOGRAPHIC_PREFIX;
	return prefix + suffix;
}

// Fixed test customers that must always exist after a (re)generation,
// regardless of business type — real numbers outside the Ofcom-safe
// ranges, used deliberately for a specific test purpose.
const GUARANTEED_CUSTOMERS = [
	{ name: "Joe Bloggs", phone: "+447794516641", email: "joe.bloggs@example.com" },
	{ name: "James Smith", phone: "+442038852824", email: "james.smith@example.com" },
];

function findColumn(table: TableConfig, pattern: RegExp, exclude?: RegExp): string | undefined {
	return table.columns.find((c) => pattern.test(c.name) && !(exclude && exclude.test(c.name)))?.name;
}

/** Any generated column that looks like a phone number gets overwritten
 * with an Ofcom-safe E.164 UK number — deterministic, so this holds
 * regardless of what the model actually produced. */
function enforcePhoneFormat(table: TableConfig, rows: Array<Record<string, unknown>>) {
	const phoneCol = findColumn(table, /phone/i);
	if (!phoneCol) return;
	for (const row of rows) row[phoneCol] = randomOfcomPhoneNumber();
}

/** The "customers" collection specifically always includes Joe Bloggs and
 * James Smith with their fixed numbers, overwriting whichever two rows the
 * model generated first. */
function enforceGuaranteedCustomers(table: TableConfig, rows: Array<Record<string, unknown>>) {
	if (table.name !== "customers") return;
	const nameCol = findColumn(table, /name/i, /company|product|category/i);
	if (!nameCol) return;
	const phoneCol = findColumn(table, /phone/i);
	const emailCol = findColumn(table, /email/i);

	GUARANTEED_CUSTOMERS.forEach((person, i) => {
		if (!rows[i]) return;
		rows[i][nameCol] = person.name;
		if (phoneCol) rows[i][phoneCol] = person.phone;
		if (emailCol) rows[i][emailCol] = person.email;
	});
}

/** Generalized FK repair using real schema metadata (works for any
 * collection, not just the original 4 tables) — replaces any foreign-key
 * value the model got wrong with a real value from the referenced table's
 * freshly generated rows. */
function repairForeignKeys(
	tables: TableConfig[],
	fkMap: Map<string, ForeignKey[]>,
	data: Record<string, Array<Record<string, unknown>>>,
) {
	for (const table of tables) {
		const fks = fkMap.get(table.name) || [];
		const rows = data[table.name] || [];
		for (const fk of fks) {
			const refRows = data[fk.table] || [];
			const refValues = refRows.map((r) => r[fk.to]).filter((v) => v !== undefined && v !== null && v !== "");
			if (!refValues.length) continue;
			for (const row of rows) {
				if (!refValues.includes(row[fk.from])) {
					row[fk.from] = refValues[Math.floor(Math.random() * refValues.length)];
				}
			}
		}
	}
}

async function generateRecords(db: D1Database, apiKey: string, businessType: string) {
	if (!apiKey) throw new Error("OPENAI_API_KEY is not configured — run 'wrangler secret put OPENAI_API_KEY'.");

	const tables = await getAllTableConfigs(db);
	const fkMap = new Map<string, ForeignKey[]>();
	for (const t of tables) fkMap.set(t.name, await getForeignKeys(db, t.name));

	// Small, independent, per-collection requests run concurrently — much
	// faster and more reliable than one giant multi-table structured call.
	const results = await Promise.all(
		tables.map(async (t) => ({ name: t.name, rows: await callOpenAI(apiKey, businessType, t) })),
	);
	const data: Record<string, Array<Record<string, unknown>>> = {};
	for (const r of results) data[r.name] = r.rows;

	for (const table of tables) {
		const rows = data[table.name] || [];
		enforcePhoneFormat(table, rows);
		enforceGuaranteedCustomers(table, rows);
	}

	repairForeignKeys(tables, fkMap, data);

	const insertOrder = await topoSortByForeignKeys(db, tables); // parents first
	const deleteOrder = [...insertOrder].reverse(); // children first

	for (const name of deleteOrder) {
		await db.prepare(`DELETE FROM "${name}"`).run();
	}

	for (const name of insertOrder) {
		const table = tables.find((t) => t.name === name)!;
		for (const row of data[name] || []) {
			const cols = table.columns.filter((c) => c.name !== "rowid" && row[c.name] !== undefined);
			if (!cols.length) continue;
			const placeholders = cols.map(() => "?").join(", ");
			const binds = cols.map((c) => (c.type === "number" ? Number(row[c.name]) : String(row[c.name])));
			await db
				.prepare(
					`INSERT INTO "${name}" (${cols.map((c) => `"${c.name}"`).join(", ")}) VALUES (${placeholders})`,
				)
				.bind(...binds)
				.run();
		}
	}
}

// ---- Router ----

export async function handleAdmin(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);

	if (url.pathname === "/db") {
		return new Response(renderPage(), {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}

	if (!url.pathname.startsWith("/db/api/")) {
		return null;
	}

	try {
		if (url.pathname === "/db/api/schema" && request.method === "GET") {
			return json(await getAllTableConfigs(env.DB));
		}

		if (url.pathname === "/db/api/business-types" && request.method === "GET") {
			return json(BUSINESS_TYPES);
		}

		if (url.pathname === "/db/api/whoami") {
			const email = request.headers.get("Cf-Access-Authenticated-User-Email");
			return json({ email: email ?? null });
		}

		if (url.pathname === "/db/api/collections" && request.method === "POST") {
			const body = await request.json<{ name?: string; columns?: { name: string; type: ColumnType }[] }>();
			if (!body.name) return json({ error: "Missing collection name" }, 400);
			await createCollection(env.DB, body.name, body.columns || []);
			return json({ ok: true });
		}

		if (url.pathname === "/db/api/generate" && request.method === "POST") {
			const body = await request.json<{ business_type?: string }>();
			if (!body.business_type) return json({ error: "Missing business_type" }, 400);
			await generateRecords(env.DB, env.OPENAI_API_KEY, body.business_type);
			return json({ ok: true });
		}

		const columnsMatch = url.pathname.match(/^\/db\/api\/([a-zA-Z_][a-zA-Z0-9_]*)\/columns$/);
		if (columnsMatch && request.method === "POST") {
			const body = await request.json<{ name?: string; type?: ColumnType }>();
			if (!body.name || !body.type) return json({ error: "Body must include 'name' and 'type'" }, 400);
			await addColumn(env.DB, columnsMatch[1], body.name, body.type);
			return json({ ok: true });
		}

		const renameMatch = url.pathname.match(/^\/db\/api\/([a-zA-Z_][a-zA-Z0-9_]*)\/columns\/([^/]+)$/);
		if (renameMatch && request.method === "PATCH") {
			const body = await request.json<{ newName?: string }>();
			if (!body.newName) return json({ error: "Body must include 'newName'" }, 400);
			await renameColumn(env.DB, renameMatch[1], decodeURIComponent(renameMatch[2]), body.newName);
			return json({ ok: true });
		}

		const rowsMatch = url.pathname.match(/^\/db\/api\/([a-zA-Z_][a-zA-Z0-9_]*)\/rows$/);
		if (rowsMatch && request.method === "POST") {
			const body = await request
				.json<{ values?: Record<string, unknown> }>()
				.catch(() => ({ values: {} }));
			await addRow(env.DB, rowsMatch[1], body.values || {});
			return json({ ok: true });
		}

		const listMatch = url.pathname.match(/^\/db\/api\/([a-zA-Z_][a-zA-Z0-9_]*)$/);
		if (listMatch && request.method === "GET") {
			const table = await getTableConfig(env.DB, listMatch[1]).catch(() => null);
			if (!table) return json({ error: `Unknown table "${listMatch[1]}"` }, 404);
			return json(await listRows(env.DB, table));
		}

		const patchMatch = url.pathname.match(/^\/db\/api\/([a-zA-Z_][a-zA-Z0-9_]*)\/([^/]+)$/);
		if (patchMatch && request.method === "PATCH") {
			const table = await getTableConfig(env.DB, patchMatch[1]).catch(() => null);
			if (!table) return json({ error: `Unknown table "${patchMatch[1]}"` }, 404);

			const pkValue = decodeURIComponent(patchMatch[2]);
			const body = await request.json<{ column?: string; value?: string }>();
			if (!body.column || body.value === undefined) {
				return json({ error: "Body must include 'column' and 'value'" }, 400);
			}
			await patchRow(env.DB, table, pkValue, body.column, String(body.value));
			return json({ ok: true });
		}

		return json({ error: "Not found" }, 404);
	} catch (err) {
		return json({ error: (err as Error).message }, 400);
	}
}

function renderPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ZVA Demo — DB Admin</title>
<style>
	:root { color-scheme: light; }
	* { box-sizing: border-box; }
	body {
		margin: 0;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
		background: #f7f7f8;
		color: #1a1a1a;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 24px;
		background: #fff;
		border-bottom: 1px solid #e5e5e7;
	}
	header h1 { font-size: 16px; font-weight: 600; margin: 0; }
	header .who { font-size: 13px; color: #6b6b70; }
	nav {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 8px 24px;
		background: #fff;
		border-bottom: 1px solid #e5e5e7;
	}
	nav button.tab {
		border: none;
		background: transparent;
		padding: 10px 14px;
		font-size: 13px;
		font-weight: 500;
		color: #6b6b70;
		cursor: pointer;
		border-bottom: 2px solid transparent;
	}
	nav button.tab.active { color: #1a1a1a; border-bottom-color: #d97757; }
	nav .spacer { flex: 1; }
	.btn {
		border: 1px solid #d8d8db;
		background: #fff;
		border-radius: 7px;
		padding: 6px 12px;
		font-size: 12.5px;
		font-weight: 500;
		color: #333;
		cursor: pointer;
		margin-left: 6px;
	}
	.btn:hover { background: #f5f5f6; }
	.btn:disabled { opacity: .5; cursor: default; }
	.btn.primary { background: #d97757; border-color: #d97757; color: #fff; }
	.btn.primary:hover { background: #c8663f; }
	main { padding: 24px; max-width: min(1800px, 96vw); margin: 0 auto; }
	.toolbar { display: flex; align-items: center; margin-bottom: 12px; }
	.toolbar .spacer { flex: 1; }
	.card {
		background: #fff;
		border: 1px solid #e5e5e7;
		border-radius: 10px;
		overflow: auto;
	}
	table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
	thead th {
		position: relative;
		text-align: left;
		font-weight: 600;
		color: #6b6b70;
		padding: 0;
		background: #fafafa;
		border-bottom: 1px solid #e5e5e7;
		overflow: hidden;
	}
	thead th input {
		width: 100%;
		border: 1px solid transparent;
		background: transparent;
		padding: 10px 12px;
		font-size: 13px;
		font-weight: 600;
		color: #6b6b70;
		font-family: inherit;
		text-overflow: ellipsis;
	}
	thead th input:focus { outline: none; border-color: #d97757; background: #fffaf7; }
	.col-resize-handle {
		position: absolute;
		top: 0; right: 0; bottom: 0;
		width: 6px;
		cursor: col-resize;
		z-index: 2;
	}
	.col-resize-handle:hover, .col-resize-handle.resizing { background: #d97757; opacity: .5; }
	tbody td {
		padding: 0;
		border-bottom: 1px solid #f0f0f1;
		overflow: hidden;
	}
	tbody tr:last-child td { border-bottom: none; }
	td.readonly {
		padding: 10px 12px;
		color: #444;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	td input {
		width: 100%;
		border: 1px solid transparent;
		background: transparent;
		padding: 10px 12px;
		font-size: 13px;
		font-family: inherit;
		color: #1a1a1a;
	}
	td input:focus {
		outline: none;
		border-color: #d97757;
		background: #fffaf7;
	}
	td.saved input { background: #f0f9f0; border-color: #8fbc8f; }
	td.error input { background: #fdf0f0; border-color: #c96a6a; }
	.empty { padding: 40px; text-align: center; color: #8a8a8e; font-size: 13px; }
	.overlay {
		display: none;
		position: fixed; inset: 0;
		background: rgba(0,0,0,.25);
		align-items: center; justify-content: center;
		z-index: 50;
	}
	.overlay.open { display: flex; }
	.modal {
		background: #fff;
		border-radius: 12px;
		padding: 22px;
		width: 420px;
		max-width: calc(100vw - 32px);
		box-shadow: 0 12px 40px rgba(0,0,0,.2);
	}
	.modal h3 { font-size: 15px; margin: 0 0 14px; }
	.modal label { display: block; font-size: 12.5px; color: #6b6b70; margin: 12px 0 4px; }
	.modal input[type=text], .modal select {
		width: 100%;
		padding: 8px 10px;
		border: 1px solid #d8d8db;
		border-radius: 7px;
		font-size: 13px;
		font-family: inherit;
	}
	.modal .col-row { display: flex; gap: 8px; margin-top: 6px; }
	.modal .col-row input { flex: 2; }
	.modal .col-row select { flex: 1; }
	.modal .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
	.modal .hint { font-size: 12px; color: #8a8a8e; margin-top: 4px; }
	.link-btn { background: none; border: none; color: #d97757; font-size: 12.5px; cursor: pointer; padding: 6px 0; }
	.gen-status {
		display: none;
		align-items: center;
		gap: 8px;
		margin-top: 14px;
		padding: 10px 12px;
		border-radius: 8px;
		background: #f7f7f8;
		font-size: 12.5px;
		color: #444;
	}
	.gen-status.show { display: flex; }
	.gen-status.gen-status-error { background: #fdf0f0; color: #a33; }
	.gen-status.gen-status-ok { background: #f0f9f0; color: #2a6b2a; }
	.spinner {
		width: 14px; height: 14px;
		border: 2px solid #d8d8db;
		border-top-color: #d97757;
		border-radius: 50%;
		animation: spin .7s linear infinite;
		flex-shrink: 0;
	}
	.gen-status-error .spinner, .gen-status-ok .spinner { display: none; }
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<header>
	<h1>ZVA Demo — DB Admin</h1>
	<span class="who" id="who"></span>
</header>
<nav id="tabs">
	<div class="spacer"></div>
	<button class="btn" id="btn-add-collection">+ Collection</button>
	<button class="btn primary" id="btn-generate">✨ Generate Records</button>
</nav>
<main>
	<div class="toolbar">
		<div class="spacer"></div>
		<button class="btn" id="btn-add-column">+ Column</button>
		<button class="btn" id="btn-add-row">+ Row</button>
	</div>
	<div class="card"><div id="table-container"></div></div>
</main>

<div class="overlay" id="overlay-column">
	<div class="modal">
		<h3>Add column</h3>
		<label>Column name</label>
		<input type="text" id="col-name" placeholder="e.g. discount_code" />
		<label>Type</label>
		<select id="col-type"><option value="text">Text</option><option value="number">Number</option></select>
		<div class="actions">
			<button class="btn" onclick="closeModal('overlay-column')">Cancel</button>
			<button class="btn primary" onclick="submitAddColumn()">Add column</button>
		</div>
	</div>
</div>

<div class="overlay" id="overlay-collection">
	<div class="modal">
		<h3>Add collection</h3>
		<label>Collection name (lowercase, underscores)</label>
		<input type="text" id="coll-name" placeholder="e.g. suppliers" />
		<label>Columns (an "id" text column is added automatically)</label>
		<div id="coll-columns"></div>
		<button class="link-btn" onclick="addCollectionColumnRow()">+ add another column</button>
		<div class="actions">
			<button class="btn" onclick="closeModal('overlay-collection')">Cancel</button>
			<button class="btn primary" onclick="submitAddCollection()">Create collection</button>
		</div>
	</div>
</div>

<div class="overlay" id="overlay-generate">
	<div class="modal">
		<h3>Generate Records</h3>
		<p class="hint">Replaces the rows in every collection with data appropriate for the business type you pick. Runs one small request per collection in parallel.</p>
		<label>Business type</label>
		<select id="gen-business-type"></select>
		<div id="gen-custom-wrap" style="display:none;">
			<label>Describe your business</label>
			<input type="text" id="gen-custom" placeholder="e.g. artisanal cheese subscription box" />
		</div>
		<div class="gen-status" id="gen-status">
			<div class="spinner"></div>
			<span class="gen-status-text">Processing…</span>
		</div>
		<div class="actions">
			<button class="btn" onclick="closeModal('overlay-generate')">Cancel</button>
			<button class="btn primary" id="gen-submit" onclick="submitGenerate()">Generate</button>
		</div>
	</div>
</div>

<script>
let schema = [];
let activeTable = null;

async function api(path, options) {
	const res = await fetch(path, options);
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(body.error || res.statusText);
	return body;
}

function openModal(id) { document.getElementById(id).classList.add("open"); }
function closeModal(id) { document.getElementById(id).classList.remove("open"); }

async function loadWhoami() {
	try {
		const { email } = await api("/db/api/whoami");
		document.getElementById("who").textContent = email ? "Signed in as " + email : "";
	} catch {}
}

async function loadSchema() {
	schema = await api("/db/api/schema");
	if (!activeTable || !schema.find((t) => t.name === activeTable)) {
		activeTable = schema[0]?.name;
	}
	renderTabs();
}

function renderTabs() {
	const nav = document.getElementById("tabs");
	nav.querySelectorAll(".tab").forEach((el) => el.remove());
	const spacer = nav.querySelector(".spacer");
	for (const t of schema) {
		const btn = document.createElement("button");
		btn.textContent = t.label;
		btn.className = "tab" + (t.name === activeTable ? " active" : "");
		btn.onclick = () => { activeTable = t.name; renderTabs(); loadTable(t.name); };
		nav.insertBefore(btn, spacer);
	}
}

// Columns that should size themselves to their longest value rather than
// use a fixed default width. A manual drag-resize (see resizedWidths)
// always takes priority over this.
const AUTO_SIZE_COLUMNS = new Set(["name", "email", "date", "location", "appointment_type", "doctor"]);
const resizedWidths = {}; // "table.column" -> px, set once the user drags a header

function estimateColumnWidth(col, rows) {
	const CHAR_PX = 7.2;
	const PADDING = 30;
	const MIN = 90;
	const MAX = 420;
	let longest = col.label.length;
	for (const row of rows) {
		const v = row[col.name];
		if (v != null) longest = Math.max(longest, String(v).length);
	}
	return Math.min(MAX, Math.max(MIN, Math.round(longest * CHAR_PX + PADDING)));
}

function defaultColumnWidth(col) {
	return col.type === "number" ? 90 : 140;
}

function columnWidthFor(tableName, col, rows) {
	const key = tableName + "." + col.name;
	if (resizedWidths[key]) return resizedWidths[key];
	if (AUTO_SIZE_COLUMNS.has(col.name)) return estimateColumnWidth(col, rows);
	return defaultColumnWidth(col);
}

function startColumnResize(evt, tableName, colName, colEl, handleEl) {
	evt.preventDefault();
	const startX = evt.clientX;
	const startWidth = colEl.getBoundingClientRect().width;
	handleEl.classList.add("resizing");

	function onMove(moveEvt) {
		const next = Math.max(60, Math.min(700, startWidth + (moveEvt.clientX - startX)));
		colEl.style.width = next + "px";
		resizedWidths[tableName + "." + colName] = next;
	}
	function onUp() {
		handleEl.classList.remove("resizing");
		document.removeEventListener("mousemove", onMove);
		document.removeEventListener("mouseup", onUp);
	}
	document.addEventListener("mousemove", onMove);
	document.addEventListener("mouseup", onUp);
}

async function loadTable(name) {
	const config = schema.find((t) => t.name === name);
	const container = document.getElementById("table-container");
	container.innerHTML = "<div class=\\"empty\\">Loading…</div>";
	const rows = await api("/db/api/" + name);

	const table = document.createElement("table");

	const colgroup = document.createElement("colgroup");
	const colEls = config.columns.map((col) => {
		const colEl = document.createElement("col");
		colEl.style.width = columnWidthFor(name, col, rows) + "px";
		colgroup.appendChild(colEl);
		return colEl;
	});
	table.appendChild(colgroup);

	const thead = document.createElement("thead");
	const headRow = document.createElement("tr");
	config.columns.forEach((col, i) => {
		const th = document.createElement("th");
		if (col.editable) {
			const input = document.createElement("input");
			input.value = col.label;
			input.title = "Click to rename this column";
			input.addEventListener("change", () => renameColumn(config, col.name, input.value));
			th.appendChild(input);
		} else {
			th.textContent = col.label;
			th.style.padding = "10px 12px";
			th.style.whiteSpace = "nowrap";
		}
		const handle = document.createElement("div");
		handle.className = "col-resize-handle";
		handle.title = "Drag to resize";
		handle.addEventListener("mousedown", (e) => startColumnResize(e, name, col.name, colEls[i], handle));
		th.appendChild(handle);
		headRow.appendChild(th);
	});
	thead.appendChild(headRow);
	table.appendChild(thead);

	const tbody = document.createElement("tbody");
	for (const row of rows) {
		const tr = document.createElement("tr");
		for (const col of config.columns) {
			const td = document.createElement("td");
			if (!col.editable) {
				td.className = "readonly";
				td.textContent = row[col.name] ?? "";
			} else {
				const input = document.createElement("input");
				input.type = col.type === "number" ? "number" : "text";
				if (col.type === "number") input.step = "any";
				input.value = row[col.name] ?? "";
				input.addEventListener("change", () => saveCell(td, config, row, col.name, input.value));
				td.appendChild(input);
			}
			tr.appendChild(td);
		}
		tbody.appendChild(tr);
	}
	table.appendChild(tbody);
	container.innerHTML = "";
	if (!rows.length) {
		container.innerHTML = "<div class=\\"empty\\">No rows yet — use + Row to add one.</div>";
	} else {
		container.appendChild(table);
	}
}

async function saveCell(td, config, row, column, value) {
	const pkValue = row[config.pk];
	td.classList.remove("saved", "error");
	try {
		await api("/db/api/" + config.name + "/" + encodeURIComponent(pkValue), {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ column, value }),
		});
		row[column] = value;
		td.classList.add("saved");
		setTimeout(() => td.classList.remove("saved"), 1200);
	} catch (err) {
		td.classList.add("error");
		alert("Save failed: " + err.message);
	}
}

async function renameColumn(config, oldName, newLabel) {
	const newName = newLabel.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
	if (!newName || newName === oldName) { loadTable(config.name); return; }
	try {
		await api("/db/api/" + config.name + "/columns/" + encodeURIComponent(oldName), {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ newName }),
		});
		await loadSchema();
		loadTable(config.name);
	} catch (err) {
		alert("Rename failed: " + err.message);
		loadTable(config.name);
	}
}

document.getElementById("btn-add-row").onclick = async () => {
	try {
		await api("/db/api/" + activeTable + "/rows", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ values: {} }),
		});
		loadTable(activeTable);
	} catch (err) {
		alert("Couldn't add row: " + err.message);
	}
};

document.getElementById("btn-add-column").onclick = () => {
	document.getElementById("col-name").value = "";
	openModal("overlay-column");
};

async function submitAddColumn() {
	const name = document.getElementById("col-name").value.trim();
	const type = document.getElementById("col-type").value;
	if (!name) return;
	try {
		await api("/db/api/" + activeTable + "/columns", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name, type }),
		});
		closeModal("overlay-column");
		await loadSchema();
		loadTable(activeTable);
	} catch (err) {
		alert("Couldn't add column: " + err.message);
	}
}

document.getElementById("btn-add-collection").onclick = () => {
	document.getElementById("coll-name").value = "";
	document.getElementById("coll-columns").innerHTML = "";
	addCollectionColumnRow();
	addCollectionColumnRow();
	openModal("overlay-collection");
};

function addCollectionColumnRow() {
	const wrap = document.getElementById("coll-columns");
	const row = document.createElement("div");
	row.className = "col-row";
	row.innerHTML = '<input type="text" placeholder="column name" />' +
		'<select><option value="text">Text</option><option value="number">Number</option></select>';
	wrap.appendChild(row);
}

async function submitAddCollection() {
	const name = document.getElementById("coll-name").value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
	if (!name) return;
	const columns = [...document.querySelectorAll("#coll-columns .col-row")]
		.map((row) => ({
			name: row.querySelector("input").value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_"),
			type: row.querySelector("select").value,
		}))
		.filter((c) => c.name);
	try {
		await api("/db/api/collections", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name, columns }),
		});
		closeModal("overlay-collection");
		activeTable = name;
		await loadSchema();
		loadTable(activeTable);
	} catch (err) {
		alert("Couldn't create collection: " + err.message);
	}
}

document.getElementById("btn-generate").onclick = async () => {
	const select = document.getElementById("gen-business-type");
	if (!select.options.length) {
		const types = await api("/db/api/business-types");
		for (const t of types) {
			const opt = document.createElement("option");
			opt.value = t; opt.textContent = t;
			select.appendChild(opt);
		}
		const custom = document.createElement("option");
		custom.value = "__custom__"; custom.textContent = "Other (describe below)";
		select.appendChild(custom);
	}
	select.onchange = () => {
		document.getElementById("gen-custom-wrap").style.display = select.value === "__custom__" ? "block" : "none";
	};
	const status = document.getElementById("gen-status");
	status.classList.remove("show", "gen-status-error", "gen-status-ok");
	openModal("overlay-generate");
};

async function submitGenerate() {
	const select = document.getElementById("gen-business-type");
	const businessType = select.value === "__custom__"
		? document.getElementById("gen-custom").value.trim()
		: select.value;
	if (!businessType) return;

	const btn = document.getElementById("gen-submit");
	const status = document.getElementById("gen-status");
	const statusText = status.querySelector(".gen-status-text");

	btn.disabled = true;
	select.disabled = true;
	status.classList.remove("gen-status-error", "gen-status-ok");
	status.classList.add("show");
	let seconds = 0;
	statusText.textContent = "Processing… (0s)";
	const ticker = setInterval(() => {
		seconds += 1;
		statusText.textContent = "Processing… (" + seconds + "s)";
	}, 1000);

	const controller = new AbortController();
	const abortTimer = setTimeout(() => controller.abort(), 28000);

	try {
		await api("/db/api/generate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ business_type: businessType }),
			signal: controller.signal,
		});
		status.classList.add("gen-status-ok");
		statusText.textContent = "Done!";
		loadTable(activeTable);
		setTimeout(() => closeModal("overlay-generate"), 600);
	} catch (err) {
		status.classList.add("gen-status-error");
		statusText.textContent = err.name === "AbortError"
			? "Timed out after 28s client-side (it may still finish server-side — reload the table in a moment) — try again."
			: "Failed: " + err.message;
	} finally {
		clearInterval(ticker);
		clearTimeout(abortTimer);
		btn.disabled = false;
		select.disabled = false;
	}
}

(async function init() {
	await loadSchema();
	loadWhoami();
	if (activeTable) loadTable(activeTable);
})();
</script>
</body>
</html>`;
}
