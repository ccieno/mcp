// Editable admin UI for the demo D1 tables, served at /db.
// Intended to sit behind Cloudflare Access (Google SSO) on a zone route
// like app.eno.solutions/db* — this Worker does not implement its own
// auth, it trusts Access to gate access before requests arrive.

interface Env {
	DB: D1Database;
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
	pk: string; // column used in WHERE clause for updates
	pkIsRowid?: boolean; // true when pk is SQLite's implicit rowid (order_items has no single-column key)
	columns: ColumnConfig[];
}

const TABLES: TableConfig[] = [
	{
		name: "customers",
		label: "Customers",
		pk: "id",
		columns: [
			{ name: "id", label: "Account ID", type: "text", editable: false },
			{ name: "name", label: "Name", type: "text", editable: true },
			{ name: "email", label: "Email", type: "text", editable: true },
			{ name: "company", label: "Company", type: "text", editable: true },
			{ name: "plan_tier", label: "Plan", type: "text", editable: true },
			{
				name: "account_status",
				label: "Status",
				type: "text",
				editable: true,
			},
			{ name: "created_at", label: "Created", type: "text", editable: false },
		],
	},
	{
		name: "products",
		label: "Products",
		pk: "sku",
		columns: [
			{ name: "sku", label: "SKU", type: "text", editable: false },
			{ name: "name", label: "Name", type: "text", editable: true },
			{ name: "category", label: "Category", type: "text", editable: true },
			{ name: "price", label: "Price", type: "number", editable: true },
			{
				name: "stock_quantity",
				label: "Stock",
				type: "number",
				editable: true,
			},
			{
				name: "warehouse_location",
				label: "Location",
				type: "text",
				editable: true,
			},
		],
	},
	{
		name: "orders",
		label: "Orders",
		pk: "id",
		columns: [
			{ name: "id", label: "Order ID", type: "text", editable: false },
			{
				name: "customer_id",
				label: "Customer ID",
				type: "text",
				editable: false,
			},
			{
				name: "order_date",
				label: "Order Date",
				type: "text",
				editable: true,
			},
			{ name: "status", label: "Status", type: "text", editable: true },
			{
				name: "total_amount",
				label: "Total",
				type: "number",
				editable: true,
			},
		],
	},
	{
		name: "order_items",
		label: "Order Items",
		pk: "rowid",
		pkIsRowid: true,
		columns: [
			{ name: "rowid", label: "Row", type: "number", editable: false },
			{
				name: "order_id",
				label: "Order ID",
				type: "text",
				editable: false,
			},
			{
				name: "product_sku",
				label: "SKU",
				type: "text",
				editable: false,
			},
			{ name: "quantity", label: "Qty", type: "number", editable: true },
			{
				name: "unit_price",
				label: "Unit Price",
				type: "number",
				editable: true,
			},
		],
	},
];

function getTable(name: string): TableConfig | undefined {
	return TABLES.find((t) => t.name === name);
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function listRows(db: D1Database, table: TableConfig) {
	const cols = table.columns
		.map((c) => c.name)
		.filter((name) => name !== "rowid")
		.join(", ");
	const select = table.pkIsRowid ? `rowid AS rowid, ${cols}` : cols;
	const { results } = await db
		.prepare(`SELECT ${select} FROM ${table.name} ORDER BY ${table.pk}`)
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

	await db
		.prepare(`UPDATE ${table.name} SET ${column} = ? WHERE ${table.pk} = ?`)
		.bind(bindValue, pkValue)
		.run();
}

export async function handleAdmin(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const url = new URL(request.url);

	if (url.pathname === "/db") {
		return new Response(renderPage(), {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}

	if (url.pathname === "/db/api/schema") {
		return json(
			TABLES.map((t) => ({
				name: t.name,
				label: t.label,
				pk: t.pkIsRowid ? "rowid" : t.pk,
				columns: t.columns,
			})),
		);
	}

	if (url.pathname === "/db/api/whoami") {
		const email = request.headers.get("Cf-Access-Authenticated-User-Email");
		return json({ email: email ?? null });
	}

	const listMatch = url.pathname.match(/^\/db\/api\/([a-z_]+)$/);
	if (listMatch && request.method === "GET") {
		const table = getTable(listMatch[1]);
		if (!table) return json({ error: `Unknown table "${listMatch[1]}"` }, 404);
		return json(await listRows(env.DB, table));
	}

	const patchMatch = url.pathname.match(/^\/db\/api\/([a-z_]+)\/([^/]+)$/);
	if (patchMatch && request.method === "PATCH") {
		const table = getTable(patchMatch[1]);
		if (!table) return json({ error: `Unknown table "${patchMatch[1]}"` }, 404);

		const pkValue = decodeURIComponent(patchMatch[2]);
		let body: { column?: string; value?: string };
		try {
			body = await request.json();
		} catch {
			return json({ error: "Invalid JSON body" }, 400);
		}
		if (!body.column || body.value === undefined) {
			return json({ error: "Body must include 'column' and 'value'" }, 400);
		}

		try {
			await patchRow(env.DB, table, pkValue, body.column, String(body.value));
			return json({ ok: true });
		} catch (err) {
			return json({ error: (err as Error).message }, 400);
		}
	}

	if (url.pathname.startsWith("/db")) {
		return json({ error: "Not found" }, 404);
	}

	return null;
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
		gap: 4px;
		padding: 12px 24px 0;
		background: #fff;
		border-bottom: 1px solid #e5e5e7;
	}
	nav button {
		border: none;
		background: transparent;
		padding: 10px 14px;
		font-size: 13px;
		font-weight: 500;
		color: #6b6b70;
		cursor: pointer;
		border-bottom: 2px solid transparent;
	}
	nav button.active { color: #1a1a1a; border-bottom-color: #d97757; }
	main { padding: 24px; max-width: 1100px; margin: 0 auto; }
	.card {
		background: #fff;
		border: 1px solid #e5e5e7;
		border-radius: 10px;
		overflow: hidden;
	}
	table { width: 100%; border-collapse: collapse; font-size: 13px; }
	thead th {
		text-align: left;
		font-weight: 600;
		color: #6b6b70;
		padding: 10px 12px;
		background: #fafafa;
		border-bottom: 1px solid #e5e5e7;
		white-space: nowrap;
	}
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
</style>
</head>
<body>
<header>
	<h1>ZVA Demo — DB Admin</h1>
	<span class="who" id="who"></span>
</header>
<nav id="tabs"></nav>
<main><div class="card"><div id="table-container"></div></div></main>
<script>
let schema = [];
let activeTable = null;

async function api(path, options) {
	const res = await fetch(path, options);
	if (!res.ok) throw new Error((await res.json()).error || res.statusText);
	return res.json();
}

async function loadWhoami() {
	try {
		const { email } = await api("/db/api/whoami");
		document.getElementById("who").textContent = email ? "Signed in as " + email : "";
	} catch {}
}

function renderTabs() {
	const nav = document.getElementById("tabs");
	nav.innerHTML = "";
	for (const t of schema) {
		const btn = document.createElement("button");
		btn.textContent = t.label;
		btn.className = t.name === activeTable ? "active" : "";
		btn.onclick = () => { activeTable = t.name; renderTabs(); loadTable(t.name); };
		nav.appendChild(btn);
	}
}

async function loadTable(name) {
	const config = schema.find((t) => t.name === name);
	const container = document.getElementById("table-container");
	container.innerHTML = "<div class=\\"empty\\">Loading…</div>";
	const rows = await api("/db/api/" + name);

	if (!rows.length) {
		container.innerHTML = "<div class=\\"empty\\">No rows.</div>";
		return;
	}

	const table = document.createElement("table");
	const thead = document.createElement("thead");
	const headRow = document.createElement("tr");
	for (const col of config.columns) {
		const th = document.createElement("th");
		th.textContent = col.label;
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
				input.step = col.type === "number" ? "any" : undefined;
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
	container.appendChild(table);
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

(async function init() {
	schema = await api("/db/api/schema");
	activeTable = schema[0]?.name;
	renderTabs();
	loadWhoami();
	if (activeTable) loadTable(activeTable);
})();
</script>
</body>
</html>`;
}
