-- Schema + seed data for the ZVA demo MCP server.
-- Run with: npm run db:init (local) or npm run db:init:remote (deployed D1)

DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS customers;

CREATE TABLE customers (
	id TEXT PRIMARY KEY,           -- account id, e.g. ACC-1001
	name TEXT NOT NULL,
	email TEXT NOT NULL,
	company TEXT,
	plan_tier TEXT,                -- e.g. Free, Pro, Business
	account_status TEXT,           -- e.g. Active, Past Due, Suspended
	created_at TEXT,
	phone_number TEXT,
	language TEXT,                 -- e.g. en, es, fr
	loyalty_tier TEXT               -- e.g. Bronze, Silver, Gold, Platinum
);

CREATE TABLE products (
	sku TEXT PRIMARY KEY,          -- e.g. SKU-1001
	name TEXT NOT NULL,
	category TEXT,
	price REAL NOT NULL,
	stock_quantity INTEGER NOT NULL,
	warehouse_location TEXT
);

CREATE TABLE orders (
	id TEXT PRIMARY KEY,           -- order id, e.g. ORD-5001
	customer_id TEXT NOT NULL REFERENCES customers(id),
	order_date TEXT NOT NULL,
	status TEXT NOT NULL,          -- e.g. Processing, Shipped, Delivered, Cancelled
	total_amount REAL NOT NULL,
	delivery_date TEXT,            -- actual or expected delivery date
	product_name TEXT              -- denormalized primary/first product name for quick display
);

CREATE TABLE order_items (
	order_id TEXT NOT NULL REFERENCES orders(id),
	product_sku TEXT NOT NULL REFERENCES products(sku),
	quantity INTEGER NOT NULL,
	unit_price REAL NOT NULL,
	product_name TEXT              -- denormalized copy of products.name at order time
);

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_order_items_order ON order_items(order_id);

-- Customers. Phone numbers use Ofcom's reserved "drama numbers" ranges
-- (safe to publish — never allocated to real subscribers): geographic
-- +441632960000-960999, mobile +447700900000-900999, both E.164 formatted.
-- Joe Bloggs and James Smith are guaranteed test records with fixed numbers
-- (kept in sync by Generate Records too — see src/admin.ts).
INSERT INTO customers (id, name, email, company, plan_tier, account_status, created_at, phone_number, language, loyalty_tier) VALUES
('ACC-1001', 'Dana Whitfield', 'dana.whitfield@brightloop.io', 'Brightloop', 'Business', 'Active', '2023-02-14', '+441632960142', 'en', 'Gold'),
('ACC-1002', 'Marcus Ide', 'marcus.ide@nordlyworks.com', 'Nordly Works', 'Pro', 'Active', '2023-05-30', '+447700900187', 'en', 'Silver'),
('ACC-1003', 'Priya Naik', 'priya.naik@fernhollow.co', 'Fern Hollow', 'Free', 'Active', '2024-01-09', '+441632960958', 'en', 'Bronze'),
('ACC-1004', 'Oliver Bass', 'oliver.bass@quarrytech.com', 'Quarry Tech', 'Business', 'Past Due', '2022-11-02', '+447700900173', 'en', 'Gold'),
('ACC-1005', 'Selene Marsh', 'selene.marsh@cobaltline.com', 'Cobalt Line', 'Pro', 'Suspended', '2023-09-18', '+441632960122', 'en', 'Silver'),
('ACC-1006', 'Terrence Boyle', 'terrence.boyle@driftandco.com', 'Drift & Co', 'Business', 'Active', '2021-07-21', '+447700900199', 'en', 'Platinum'),
('ACC-1007', 'Joe Bloggs', 'joe.bloggs@example.com', 'Bloggs & Co', 'Free', 'Active', '2024-03-11', '+447794516641', 'en', 'Bronze'),
('ACC-1008', 'James Smith', 'james.smith@example.com', 'Smith Consulting', 'Pro', 'Active', '2023-08-22', '+442038852824', 'en', 'Silver');

-- Products
INSERT INTO products (sku, name, category, price, stock_quantity, warehouse_location) VALUES
('SKU-2001', 'Aria Desk Headset', 'Audio', 89.99, 214, 'Warehouse A - Bin 12'),
('SKU-2002', 'Compass USB-C Dock', 'Accessories', 129.00, 47, 'Warehouse B - Bin 4'),
('SKU-2003', 'Loop Conference Speakerphone', 'Audio', 249.50, 12, 'Warehouse A - Bin 30'),
('SKU-2004', 'Vantage 4K Webcam', 'Video', 159.00, 0, 'Warehouse A - Bin 18'),
('SKU-2005', 'Nimbus Wireless Mic Kit', 'Audio', 199.99, 33, 'Warehouse C - Bin 2'),
('SKU-2006', 'Halo Ring Light', 'Video', 45.00, 88, 'Warehouse B - Bin 21'),
('SKU-2007', 'Trestle Standing Mat', 'Furniture', 65.00, 5, 'Warehouse C - Bin 9'),
('SKU-2008', 'Pathway Cable Organizer 3-Pack', 'Accessories', 19.99, 302, 'Warehouse B - Bin 1');

-- Orders (delivery_date is left NULL for cancelled orders; product_name is
-- the primary/first line item's product, for quick display without a join)
INSERT INTO orders (id, customer_id, order_date, status, total_amount, delivery_date, product_name) VALUES
('ORD-5001', 'ACC-1001', '2026-06-02', 'Delivered', 338.99, '2026-06-07', 'Aria Desk Headset'),
('ORD-5002', 'ACC-1001', '2026-07-10', 'Shipped', 129.00, '2026-07-17', 'Compass USB-C Dock'),
('ORD-5003', 'ACC-1002', '2026-06-25', 'Processing', 249.50, '2026-07-02', 'Loop Conference Speakerphone'),
('ORD-5004', 'ACC-1003', '2026-07-01', 'Delivered', 64.99, '2026-07-05', 'Halo Ring Light'),
('ORD-5005', 'ACC-1004', '2026-05-15', 'Cancelled', 159.00, NULL, 'Vantage 4K Webcam'),
('ORD-5006', 'ACC-1005', '2026-04-22', 'Delivered', 199.99, '2026-04-27', 'Nimbus Wireless Mic Kit'),
('ORD-5007', 'ACC-1006', '2026-07-14', 'Processing', 110.00, '2026-07-21', 'Aria Desk Headset'),
('ORD-5008', 'ACC-1002', '2026-07-16', 'Shipped', 45.00, '2026-07-19', 'Halo Ring Light');

-- Order line items
INSERT INTO order_items (order_id, product_sku, quantity, unit_price, product_name) VALUES
('ORD-5001', 'SKU-2001', 1, 89.99, 'Aria Desk Headset'),
('ORD-5001', 'SKU-2002', 1, 129.00, 'Compass USB-C Dock'),
('ORD-5001', 'SKU-2008', 6, 19.99, 'Pathway Cable Organizer 3-Pack'),
('ORD-5002', 'SKU-2002', 1, 129.00, 'Compass USB-C Dock'),
('ORD-5003', 'SKU-2003', 1, 249.50, 'Loop Conference Speakerphone'),
('ORD-5004', 'SKU-2006', 1, 45.00, 'Halo Ring Light'),
('ORD-5004', 'SKU-2008', 1, 19.99, 'Pathway Cable Organizer 3-Pack'),
('ORD-5005', 'SKU-2004', 1, 159.00, 'Vantage 4K Webcam'),
('ORD-5006', 'SKU-2005', 1, 199.99, 'Nimbus Wireless Mic Kit'),
('ORD-5007', 'SKU-2001', 1, 89.99, 'Aria Desk Headset'),
('ORD-5007', 'SKU-2008', 1, 19.99, 'Pathway Cable Organizer 3-Pack'),
('ORD-5008', 'SKU-2006', 1, 45.00, 'Halo Ring Light');
