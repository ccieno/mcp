// Shared live-schema introspection helpers, used by the admin UI
// (src/admin.ts), the MCP tools, and the REST handlers (src/db.ts,
// src/rest.ts) so all of them stay in sync with whatever tables/columns
// actually exist in D1 — including ones added or renamed after the fact.

export type ColumnType = "text" | "number";

export interface ColumnConfig {
	name: string;
	label: string;
	type: ColumnType;
	editable: boolean;
}

export interface TableConfig {
	name: string;
	label: string;
	pk: string; // column used in WHERE clause for updates; "rowid" if no declared PK
	pkIsRowid: boolean;
	columns: ColumnConfig[];
}

export interface ForeignKey {
	from: string;
	table: string;
	to: string;
}

export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_NAMES = new Set(["rowid", "oid", "_rowid_"]);

export function assertIdentifier(name: string, kind: string): void {
	if (!IDENTIFIER_RE.test(name) || RESERVED_NAMES.has(name.toLowerCase())) {
		throw new Error(
			`Invalid ${kind} "${name}" — use letters, numbers, and underscores, starting with a letter or underscore.`,
		);
	}
}

export function prettifyLabel(name: string): string {
	return name
		.split("_")
		.map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
		.join(" ");
}

export function sqlTypeToColumnType(sqlType: string): ColumnType {
	const t = sqlType.toUpperCase();
	if (t.includes("INT") || t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB") || t.includes("NUMERIC")) {
		return "number";
	}
	return "text";
}

export function columnTypeToSql(type: ColumnType): string {
	return type === "number" ? "REAL" : "TEXT";
}

export async function listTableNames(db: D1Database): Promise<string[]> {
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

export async function getTableConfig(db: D1Database, tableName: string): Promise<TableConfig> {
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

export async function getAllTableConfigs(db: D1Database): Promise<TableConfig[]> {
	const names = await listTableNames(db);
	return Promise.all(names.map((n) => getTableConfig(db, n)));
}

export async function getForeignKeys(db: D1Database, tableName: string): Promise<ForeignKey[]> {
	const { results } = await db
		.prepare(`PRAGMA foreign_key_list("${tableName}")`)
		.all<{ from: string; table: string; to: string }>();
	return results.map((r) => ({ from: r.from, table: r.table, to: r.to }));
}

/** All tables that declare a foreign key pointing at `parentTable`, i.e. its
 * "children" in a one-to-many sense (e.g. order_items is a child of orders). */
export async function getChildTables(
	db: D1Database,
	allTables: TableConfig[],
	parentTable: string,
): Promise<{ table: TableConfig; fk: ForeignKey }[]> {
	const out: { table: TableConfig; fk: ForeignKey }[] = [];
	for (const t of allTables) {
		const fks = await getForeignKeys(db, t.name);
		const fk = fks.find((f) => f.table === parentTable);
		if (fk) out.push({ table: t, fk });
	}
	return out;
}

/** Topologically sorts tables so referenced ("parent") tables come before
 * the tables that point at them via foreign keys. Reverse this for a safe
 * delete order (children before parents). */
export async function topoSortByForeignKeys(
	db: D1Database,
	tables: TableConfig[],
): Promise<string[]> {
	const names = new Set(tables.map((t) => t.name));
	const visited = new Set<string>();
	const order: string[] = [];

	async function visit(name: string) {
		if (visited.has(name) || !names.has(name)) return;
		visited.add(name);
		for (const fk of await getForeignKeys(db, name)) {
			await visit(fk.table);
		}
		order.push(name);
	}

	for (const t of tables) await visit(t.name);
	return order;
}
