// Shared query logic used by both the MCP tools (src/index.ts) and the
// plain REST endpoints (src/rest.ts) that Zoom Virtual Agent's flow-builder
// "Custom API" actions can call directly.
//
// Everything here is schema-driven (see src/schema.ts) rather than
// hardcoded to specific column names, so adding columns/collections from
// the admin UI doesn't require touching this file. Renaming or deleting a
// column a tool's *logic* actually depends on (e.g. the FK linking orders
// to customers) is a real behavior change no amount of introspection can
// paper over — those cases throw a clear error instead of quietly doing
// the wrong thing.

import { type TableConfig, getAllTableConfigs, getChildTables, getForeignKeys } from "./schema";

function requireTable(tables: TableConfig[], name: string): TableConfig {
	const table = tables.find((t) => t.name === name);
	if (!table) {
		throw new Error(
			`No "${name}" collection found — has it been renamed or deleted? Available collections: ${tables.map((t) => t.name).join(", ")}`,
		);
	}
	return table;
}

/** Exact PK match OR substring match on any text column. */
async function searchTable(db: D1Database, table: TableConfig, query: string, limit = 5) {
	const textCols = table.columns.filter((c) => c.type === "text" && c.name !== "rowid").map((c) => c.name);
	const pkExpr = table.pk === "rowid" ? "rowid" : `"${table.pk}"`;
	const conditions = [`${pkExpr} = ?`, ...textCols.map((c) => `"${c}" LIKE ?`)];
	const binds: unknown[] = [query, ...textCols.map(() => `%${query}%`)];
	const { results } = await db
		.prepare(`SELECT * FROM "${table.name}" WHERE ${conditions.join(" OR ")} LIMIT ${limit}`)
		.bind(...binds)
		.all();
	return results;
}

/** For each FK on `table`, fetch the referenced row and nest it under the
 * referenced table's name (e.g. an "orders" row gets a "customers" key). */
async function attachParents(db: D1Database, table: TableConfig, row: Record<string, unknown>) {
	const fks = await getForeignKeys(db, table.name);
	const out: Record<string, unknown> = {};
	for (const fk of fks) {
		const parentRow = await db
			.prepare(`SELECT * FROM "${fk.table}" WHERE "${fk.to}" = ?`)
			.bind(row[fk.from])
			.first();
		if (parentRow) out[fk.table] = parentRow;
	}
	return out;
}

/** For each table with an FK pointing at `table`, fetch matching rows and
 * nest them under that child table's name (e.g. "orders" gets "order_items"). */
async function attachChildren(
	db: D1Database,
	allTables: TableConfig[],
	table: TableConfig,
	pkValue: unknown,
	limit = 5,
) {
	const children = await getChildTables(db, allTables, table.name);
	const out: Record<string, unknown[]> = {};
	for (const { table: childTable, fk } of children) {
		const { results } = await db
			.prepare(`SELECT * FROM "${childTable.name}" WHERE "${fk.from}" = ? ORDER BY rowid DESC LIMIT ${limit}`)
			.bind(pkValue)
			.all();
		out[childTable.name] = results;
	}
	return out;
}

export async function getOrderDetails(db: D1Database, orderId: string) {
	const tables = await getAllTableConfigs(db);
	const ordersTable = requireTable(tables, "orders");

	const pkExpr = ordersTable.pk === "rowid" ? "rowid" : `"${ordersTable.pk}"`;
	const order = await db.prepare(`SELECT * FROM "orders" WHERE ${pkExpr} = ?`).bind(orderId).first();
	if (!order) return null;

	const parents = await attachParents(db, ordersTable, order as Record<string, unknown>);
	const children = await attachChildren(db, tables, ordersTable, orderId, 20);

	return { order, ...parents, ...children };
}

export async function lookupCustomerAccount(db: D1Database, query: string) {
	const tables = await getAllTableConfigs(db);
	const customersTable = requireTable(tables, "customers");

	const matches = await searchTable(db, customersTable, query, 1);
	const account = matches[0] as Record<string, unknown> | undefined;
	if (!account) return null;

	const pkValue = account[customersTable.pk === "rowid" ? "rowid" : customersTable.pk];
	const children = await attachChildren(db, tables, customersTable, pkValue, 5);

	return { account, ...children };
}

export async function checkProductInventory(db: D1Database, query: string) {
	const tables = await getAllTableConfigs(db);
	const productsTable = requireTable(tables, "products");
	return searchTable(db, productsTable, query, 5);
}

/** Generic lookup over any collection (existing or added later via the
 * admin UI) — backs the query_collection MCP tool / REST endpoint so new
 * collections don't need a bespoke tool written for them. */
export async function queryCollection(db: D1Database, collectionName: string, query?: string) {
	const tables = await getAllTableConfigs(db);
	const table = requireTable(tables, collectionName);

	if (!query) {
		const cols = table.columns.map((c) => c.name).filter((n) => n !== "rowid");
		const select = table.pkIsRowid ? `rowid AS rowid, ${cols.join(", ")}` : cols.join(", ");
		const { results } = await db.prepare(`SELECT ${select} FROM "${table.name}" LIMIT 20`).all();
		return results;
	}

	return searchTable(db, table, query, 10);
}

export async function listCollectionNames(db: D1Database): Promise<string[]> {
	const tables = await getAllTableConfigs(db);
	return tables.map((t) => t.name);
}
