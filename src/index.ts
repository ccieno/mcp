import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import {
	checkProductInventory,
	getOrderDetails,
	listCollectionNames,
	lookupCustomerAccount,
	queryCollection,
} from "./db";
import { handleRest } from "./rest";
import { handleAdmin } from "./admin";

interface Env {
	DB: D1Database;
	OPENAI_API_KEY: string;
	MCP_OBJECT: DurableObjectNamespace<MyMCP>;
}

function errorText(err: unknown) {
	return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
}

// Demo backend for Zoom Virtual Agent: exposes order details, customer
// account lookup, and product inventory as MCP tools backed by D1, plus a
// generic query_collection tool that covers any collection added later via
// the /db admin UI without needing a bespoke tool written for it.
export class MyMCP extends McpAgent<Env> {
	server = new McpServer({
		name: "ZVA Demo Backend",
		version: "1.0.0",
	});

	async init() {
		this.server.registerTool(
			"get_order_details",
			{
				description:
					"Look up a customer order and its line items by order ID (e.g. ORD-5001).",
				inputSchema: {
					order_id: z.string().describe("Order ID, e.g. ORD-5001"),
				},
			},
			async ({ order_id }) => {
				try {
					const result = await getOrderDetails(this.env.DB, order_id);
					if (!result) {
						return {
							content: [
								{ type: "text", text: `No order found with ID "${order_id}".` },
							],
						};
					}
					return {
						content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					};
				} catch (err) {
					return errorText(err);
				}
			},
		);

		this.server.registerTool(
			"lookup_customer_account",
			{
				description:
					"Find a customer account by account ID, email, or name, and list their 5 most recent orders.",
				inputSchema: {
					query: z
						.string()
						.describe("Account ID (ACC-1001), email, or customer name"),
				},
			},
			async ({ query }) => {
				try {
					const result = await lookupCustomerAccount(this.env.DB, query);
					if (!result) {
						return {
							content: [
								{
									type: "text",
									text: `No customer account found matching "${query}".`,
								},
							],
						};
					}
					return {
						content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					};
				} catch (err) {
					return errorText(err);
				}
			},
		);

		this.server.registerTool(
			"check_product_inventory",
			{
				description:
					"Check stock level, price, and warehouse location for one or more products matching a SKU or name.",
				inputSchema: {
					query: z.string().describe("Product SKU (SKU-2001) or product name"),
				},
			},
			async ({ query }) => {
				try {
					const products = await checkProductInventory(this.env.DB, query);
					if (!products.length) {
						return {
							content: [
								{ type: "text", text: `No products found matching "${query}".` },
							],
						};
					}
					return {
						content: [{ type: "text", text: JSON.stringify(products, null, 2) }],
					};
				} catch (err) {
					return errorText(err);
				}
			},
		);

		this.server.registerTool(
			"query_collection",
			{
				description:
					"Generic lookup over any collection in the demo database, including ones added later via the /db admin UI (e.g. a custom 'suppliers' table). Pass no query to list a sample of rows.",
				inputSchema: {
					collection: z
						.string()
						.describe("Collection/table name — call without a query first if unsure what's available"),
					query: z
						.string()
						.optional()
						.describe("Optional search term matched against the collection's ID and text columns"),
				},
			},
			async ({ collection, query }) => {
				try {
					const results = await queryCollection(this.env.DB, collection, query);
					if (!results.length) {
						return { content: [{ type: "text", text: `No rows found in "${collection}".` }] };
					}
					return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
				} catch (err) {
					const names = await listCollectionNames(this.env.DB).catch(() => []);
					return {
						content: [
							{
								type: "text",
								text: `${(err as Error).message}${names.length ? ` Available collections: ${names.join(", ")}.` : ""}`,
							},
						],
					};
				}
			},
		);
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		// Streamable HTTP (current MCP spec) and legacy SSE transport, both
		// backed by the same McpAgent — ZVA (and most MCP clients) can use
		// either; startsWith guards the SSE sub-path used to post messages
		// back (/sse/message).
		if (url.pathname.startsWith("/mcp")) {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}
		if (url.pathname.startsWith("/sse")) {
			return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		// Editable admin UI, meant to be routed at app.eno.solutions/db*
		// behind Cloudflare Access (see README).
		const adminResponse = await handleAdmin(request, env);
		if (adminResponse) return adminResponse;

		// Plain REST endpoints for Zoom Virtual Agent's flow-builder
		// Custom API actions (see README for setup).
		const restResponse = await handleRest(request, env);
		if (restResponse) return restResponse;

		return new Response("Not found", { status: 404 });
	},
};
