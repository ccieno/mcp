// Plain REST endpoints over the same demo data, for wiring into a Zoom
// Virtual Agent bot flow's "Custom API" / Action step (which calls a
// regular JSON HTTP endpoint, not the MCP protocol used by src/index.ts).

import { checkProductInventory, getOrderDetails, lookupCustomerAccount, queryCollection } from "./db";

interface Env {
	DB: D1Database;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "content-type": "application/json" },
	});
}

export async function handleRest(request: Request, env: Env): Promise<Response | null> {
	const url = new URL(request.url);
	const segments = url.pathname.split("/").filter(Boolean); // ["api", ...]

	if (segments[0] !== "api") return null;

	try {
		// GET /api/orders/:order_id
		if (segments[1] === "orders" && segments[2]) {
			const result = await getOrderDetails(env.DB, decodeURIComponent(segments[2]));
			return result
				? json(result)
				: json({ error: `No order found with ID "${segments[2]}".` }, 404);
		}

		// GET /api/customers?query=...
		if (segments[1] === "customers") {
			const query = url.searchParams.get("query");
			if (!query) return json({ error: "Missing required 'query' parameter." }, 400);
			const result = await lookupCustomerAccount(env.DB, query);
			return result
				? json(result)
				: json({ error: `No customer account found matching "${query}".` }, 404);
		}

		// GET /api/products?query=...
		if (segments[1] === "products") {
			const query = url.searchParams.get("query");
			if (!query) return json({ error: "Missing required 'query' parameter." }, 400);
			const results = await checkProductInventory(env.DB, query);
			return results.length
				? json(results)
				: json({ error: `No products found matching "${query}".` }, 404);
		}

		// GET /api/collections/:name?query=... — generic lookup over any
		// collection, including ones added later via the admin UI.
		if (segments[1] === "collections" && segments[2]) {
			const query = url.searchParams.get("query") || undefined;
			const results = await queryCollection(env.DB, decodeURIComponent(segments[2]), query);
			return json(results);
		}

		return json({ error: "Not found" }, 404);
	} catch (err) {
		return json({ error: (err as Error).message }, 400);
	}
}
