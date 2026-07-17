// Editable admin UI for the demo D1 tables, served at /db.
// Intended to sit behind Cloudflare Access (Google SSO) on a zone route
// like app.eno.solutions/db* — this Worker does not implement its own
// auth, it trusts Access to gate access before requests arrive.
//
// Schema is introspected live from D1 (sqlite_master + PRAGMA table_info)
// rather than hardcoded, so adding/renaming columns or adding whole new
// "collections" (tables) from the UI just works without a code change.

interface Env {
	DB: D1Database;
	AI: Ai;
}

type ColumnType = "text" | "number";

interface ColumnConfig {
	name: string;
	label: string;
	type: ColumnType;
	editable: boolean;
}

interface TableConfig {
	name: string;
	label: string;
	pk: string; // column used in WHERE clause for updates; "rowid" if no declared PK
	pkIsRowid: boolean;
	columns: ColumnConfig[];
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_NAMES = new Set(["rowid", "oid", "_rowid_"]);

function assertIdentifier(name: string, kind: string): void {
	if (!IDENTIFIER_RE.test(name) || RESERVED_NAMES.has(name.toLowerCase())) {
		throw new Error(
			`Invalid ${kind} "${name}" — use letters, numbers, and underscores, starting with a letter or underscore.`,
		);
	}
}

function prettifyLabel(name: string): string {
	return name
		.split("_")
		.map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
		.join(" ");
}

function sqlTypeToColumnType(sqlType: string): ColumnType {
	const t = sqlType.toUpperCase();
	if (t.includes("INT") || t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB") || t.includes("NUMERIC")) {
		return "number";
	}
	return "text";
}

function columnTypeToSql(type: ColumnType): string {
	return type === "number" ? "REAL" : "TEXT";
}

async function listTableNames(db: D1Database): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT name FROM sqlite_master
			 WHERE type = 'table'
			   AND name NOT LIKE 'sqlite_%'
			   AND name NOT LIKE 'd1_%'
			   AND name NOT LIKE '_cf_%'
			 ORDER BY name`,
		)
		.all<{ name: string }>();
	return results.map((r) => r.name);
}

async function getTableConfig(db: D1Database, tableName: string): Promise<TableConfig> {
	const { results: pragma } = await db
		.prepare(`PRAGMA table_info("${tableName}")`)
		.all<{ name: string; type: string; pk: number }>();

	if (!pragma.length) throw new Error(`Unknown table "${tableName}"`);

	const pkCols = pragma.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
	const pkIsRowid = pkCols.length !== 1;
	const pk = pkIsRowid ? "rowid" : pkCols[0].name;

	const columns: ColumnConfig[] = pragma.map((c) => ({
		name: c.name,
		label: prettifyLabel(c.name),
		type: sqlTypeToColumnType(c.type || "TEXT"),
		editable: c.pk === 0,
	}));

	if (pkIsRowid) {
		columns.unshift({ name: "rowid", label: "Row", type: "number", editable: false });
	}

	return { name: tableName, label: prettifyLabel(tableName), pk, pkIsRowid, columns };
}

async function getAllTableConfigs(db: D1Database): Promise<TableConfig[]> {
	const names = await listTableNames(db);
	return Promise.all(names.map((n) => getTableConfig(db, n)));
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

interface ForeignKey {
	from: string;
	table: string;
	to: string;
}

async function getForeignKeys(db: D1Database, tableName: string): Promise<ForeignKey[]> {
	const { results } = await db
		.prepare(`PRAGMA foreign_key_list("${tableName}")`)
		.all<{ from: string; table: string; to: string }>();
	return results.map((r) => ({ from: r.from, table: r.table, to: r.to }));
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

// ---- Generate Records (Workers AI) ----

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

function buildJsonSchema(tables: TableConfig[]) {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];

	for (const table of tables) {
		const itemProps: Record<string, unknown> = {};
		const itemRequired: string[] = [];
		for (const col of table.columns) {
			if (col.name === "rowid") continue;
			itemProps[col.name] = { type: col.type === "number" ? "number" : "string" };
			itemRequired.push(col.name);
		}
		properties[table.name] = {
			type: "array",
			minItems: Math.max(3, rowCountFor(table.name) - 2),
			maxItems: rowCountFor(table.name) + 2,
			items: {
				type: "object",
				properties: itemProps,
				required: itemRequired,
			},
		};
		required.push(table.name);
	}

	return { type: "object", properties, required };
}

function buildPrompt(businessType: string, tables: TableConfig[]): string {
	const lines: string[] = [];
	lines.push(
		`Generate a realistic, internally consistent sample dataset for a demo backend belonging to a "${businessType}" business.`,
	);
	lines.push(`Return JSON with one array per collection, matching this structure:`);
	for (const table of tables) {
		const colDesc = table.columns
			.filter((c) => c.name !== "rowid")
			.map((c) => `${c.name} (${c.type})`)
			.join(", ");
		lines.push(`- "${table.name}": ~${rowCountFor(table.name)} rows, columns: ${colDesc}`);
	}
	lines.push(
		`Make the content specific to "${businessType}" — e.g. for a travel company, products are destinations/packages; for a clothing company, products are garments; adapt every table's values (names, categories, statuses) to fit the business, not just the products.`,
	);
	if (tables.some((t) => t.name === "orders") && tables.some((t) => t.name === "customers")) {
		lines.push(
			`Every "orders" row's customer_id must exactly match the id of one of the generated "customers" rows.`,
		);
	}
	if (
		tables.some((t) => t.name === "order_items") &&
		tables.some((t) => t.name === "orders") &&
		tables.some((t) => t.name === "products")
	) {
		lines.push(
			`Every "order_items" row's order_id must exactly match the id of one of the generated "orders" rows, and product_sku must exactly match the sku of one of the generated "products" rows.`,
		);
	}
	lines.push(
		`Use plausible IDs like ACC-1001, ORD-5001, SKU-2001 style codes where a column looks like an identifier. Output JSON only, no commentary.`,
	);
	return lines.join("\n");
}

/** Best-effort repair of the well-known foreign-key relationships so the
 * demo stays internally consistent even if the AI drifts slightly. */
function repairKnownRelationships(data: Record<string, unknown[]>) {
	const customers = data.customers as Array<Record<string, unknown>> | undefined;
	const products = data.products as Array<Record<string, unknown>> | undefined;
	const orders = data.orders as Array<Record<string, unknown>> | undefined;
	const orderItems = data.order_items as Array<Record<string, unknown>> | undefined;

	if (orders && customers?.length) {
		const ids = customers.map((c) => c.id).filter(Boolean);
		if (ids.length) {
			for (const o of orders) {
				if (!ids.includes(o.customer_id)) o.customer_id = ids[Math.floor(Math.random() * ids.length)];
			}
		}
	}
	if (orderItems && orders?.length) {
		const ids = orders.map((o) => o.id).filter(Boolean);
		if (ids.length) {
			for (const oi of orderItems) {
				if (!ids.includes(oi.order_id)) oi.order_id = ids[Math.floor(Math.random() * ids.length)];
			}
		}
	}
	if (orderItems && products?.length) {
		const skus = products.map((p) => p.sku).filter(Boolean);
		if (skus.length) {
			for (const oi of orderItems) {
				if (!skus.includes(oi.product_sku)) oi.product_sku = skus[Math.floor(Math.random() * skus.length)];
			}
		}
	}
}

async function generateRecords(db: D1Database, ai: Ai, businessType: string) {
	const tables = await getAllTableConfigs(db);
	const schema = buildJsonSchema(tables);
	const prompt = buildPrompt(businessType, tables);

	const aiResponse: any = await ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
		messages: [
			{
				role: "system",
				content:
					"You generate realistic sample demo data as strict JSON matching the given schema. Output only JSON, no prose, no markdown fences.",
			},
			{ role: "user", content: prompt },
		],
		response_format: { type: "json_schema", json_schema: schema },
		max_tokens: 4096,
	});

	let data: Record<string, unknown[]>;
	const raw = aiResponse?.response ?? aiResponse;
	try {
		data = typeof raw === "string" ? JSON.parse(raw) : raw;
	} catch {
		throw new Error("The AI didn't return valid JSON — try again.");
	}

	repairKnownRelationships(data);

	const deleteOrder = ["order_items", "orders", "products", "customers"];
	const tableNames = tables.map((t) => t.name);
	const orderedForDelete = [
		...deleteOrder.filter((n) => tableNames.includes(n)),
		...tableNames.filter((n) => !deleteOrder.includes(n)),
	];
	for (const name of orderedForDelete) {
		await db.prepare(`DELETE FROM "${name}"`).run();
	}

	const insertOrder = ["customers", "products", "orders", "order_items"];
	const orderedForInsert = [
		...insertOrder.filter((n) => tableNames.includes(n)),
		...tableNames.filter((n) => !insertOrder.includes(n)),
	];
	for (const name of orderedForInsert) {
		const table = tables.find((t) => t.name === name)!;
		const rows = (data[name] as Array<Record<string, unknown>>) || [];
		for (const row of rows) {
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
			await generateRecords(env.DB, env.AI, body.business_type);
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
	.btn.primary { background: #d97757; border-color: #d97757; color: #fff; }
	.btn.primary:hover { background: #c8663f; }
	main { padding: 24px; max-width: 1100px; margin: 0 auto; }
	.toolbar { display: flex; align-items: center; margin-bottom: 12px; }
	.toolbar .spacer { flex: 1; }
	.card {
		background: #fff;
		border: 1px solid #e5e5e7;
		border-radius: 10px;
		overflow: auto;
	}
	table { width: 100%; border-collapse: collapse; font-size: 13px; }
	thead th {
		text-align: left;
		font-weight: 600;
		color: #6b6b70;
		padding: 0;
		background: #fafafa;
		border-bottom: 1px solid #e5e5e7;
		white-space: nowrap;
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
	}
	thead th input:focus { outline: none; border-color: #d97757; background: #fffaf7; }
	tbody td {
		padding: 0;
		border-bottom: 1px solid #f0f0f1;
	}
	tbody tr:last-child td { border-bottom: none; }
	td.readonly { padding: 10px 12px; color: #444; }
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
		<p class="hint">Replaces the rows in every collection with data appropriate for the business type you pick.</p>
		<label>Business type</label>
		<select id="gen-business-type"></select>
		<div id="gen-custom-wrap" style="display:none;">
			<label>Describe your business</label>
			<input type="text" id="gen-custom" placeholder="e.g. artisanal cheese subscription box" />
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

async function loadTable(name) {
	const config = schema.find((t) => t.name === name);
	const container = document.getElementById("table-container");
	container.innerHTML = "<div class=\\"empty\\">Loading…</div>";
	const rows = await api("/db/api/" + name);

	const table = document.createElement("table");
	const thead = document.createElement("thead");
	const headRow = document.createElement("tr");
	for (const col of config.columns) {
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
		}
		headRow.appendChild(th);
	}
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
	openModal("overlay-generate");
};

async function submitGenerate() {
	const select = document.getElementById("gen-business-type");
	const businessType = select.value === "__custom__"
		? document.getElementById("gen-custom").value.trim()
		: select.value;
	if (!businessType) return;
	const btn = document.getElementById("gen-submit");
	btn.disabled = true;
	btn.textContent = "Generating…";
	try {
		await api("/db/api/generate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ business_type: businessType }),
		});
		closeModal("overlay-generate");
		loadTable(activeTable);
	} catch (err) {
		alert("Generation failed: " + err.message);
	} finally {
		btn.disabled = false;
		btn.textContent = "Generate";
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
