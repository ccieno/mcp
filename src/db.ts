// Shared query logic used by both the MCP tools (src/index.ts) and the
// plain REST endpoints (src/rest.ts) that Zoom Virtual Agent's flow-builder
// "Custom API" actions can call directly.

export async function getOrderDetails(db: D1Database, orderId: string) {
	const order = await db
		.prepare(
			`SELECT o.id AS order_id, o.status, o.order_date, o.total_amount,
			        c.id AS customer_id, c.name AS customer_name, c.email
			 FROM orders o
			 JOIN customers c ON c.id = o.customer_id
			 WHERE o.id = ?`,
		)
		.bind(orderId)
		.first();

	if (!order) return null;

	const items = await db
		.prepare(
			`SELECT p.sku, p.name, oi.quantity, oi.unit_price
			 FROM order_items oi
			 JOIN products p ON p.sku = oi.product_sku
			 WHERE oi.order_id = ?`,
		)
		.bind(orderId)
		.all();

	return { order, line_items: items.results };
}

export async function lookupCustomerAccount(db: D1Database, query: string) {
	const customer = await db
		.prepare(
			`SELECT id, name, email, company, plan_tier, account_status, created_at
			 FROM customers
			 WHERE id = ? OR email = ? OR name LIKE ?
			 LIMIT 1`,
		)
		.bind(query, query, `%${query}%`)
		.first();

	if (!customer) return null;

	const recentOrders = await db
		.prepare(
			`SELECT id AS order_id, order_date, status, total_amount
			 FROM orders
			 WHERE customer_id = ?
			 ORDER BY order_date DESC
			 LIMIT 5`,
		)
		.bind(customer.id)
		.all();

	return { account: customer, recent_orders: recentOrders.results };
}

export async function checkProductInventory(db: D1Database, query: string) {
	const products = await db
		.prepare(
			`SELECT sku, name, category, price, stock_quantity, warehouse_location
			 FROM products
			 WHERE sku = ? OR name LIKE ?
			 LIMIT 5`,
		)
		.bind(query, `%${query}%`)
		.all();

	return products.results;
}
