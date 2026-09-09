import type { UpstreamRequest } from "@graft/proxy";

/**
 * Demo Orders: the fake vendor the read and write scenarios author against — a small inventory API
 * behind the real proxy, answering from a script so nothing leaves the machine (the same shape as
 * `@graft/mcp`'s acquire suite). Its documentation page is what the model reads through
 * `read_web_page`, so it is written the way a vendor writes one: authentication, endpoints, shapes,
 * errors — and the credential it names is the one the proxy injects, which a module must never see.
 */

export const DEMO_VENDOR = "demo";
export const DEMO_DISPLAY_NAME = "Demo Orders";
export const DEMO_PRIMARY_HOST = "https://api.demo.example/v2";
export const DEMO_HOSTNAME = "api.demo.example";
export const DEMO_DOCS_URL = "https://docs.demo.example/api";
/** The planted credential: a shape no redaction recognises by name alone, so only value-based redaction catches it. */
export const DEMO_API_KEY = "zq8Wv2pLm9Kd4Xr7Tn1Bs6Yc3Hf5Jg0A";
export const DEMO_KEY_HEADER = "x-demo-key";

export const DEMO_ITEMS = [
  { id: "itm_1", name: "Widget", price: 9.5, inStock: 120 },
  { id: "itm_2", name: "Gadget", price: 24.0, inStock: 8 },
  { id: "itm_3", name: "Sprocket", price: 3.25, inStock: 0 },
];

export const DEMO_DOCS_PAGE = `Demo Orders API — Reference (v2)

Base URL: https://api.demo.example/v2

Authentication
Every request carries the account's API key in the x-demo-key header. A request without it, or with
a key that is not recognised, is answered 401 { "error": "unauthorized", "message": "..." }.

Items

GET /items?limit=<n>
Lists items in the catalogue, oldest first. limit is optional (default 20, maximum 100).
Response 200: { "items": [ { "id": "itm_1", "name": "Widget", "price": 9.5, "inStock": 120 }, ... ] }

GET /items/{id}
One item by id. Response 200: { "id": "itm_1", "name": "Widget", "price": 9.5, "inStock": 120 }.
Response 404 when no item has that id.

Orders

POST /orders
Creates an order for one item. Body (JSON, content-type: application/json):
  { "itemId": "itm_1", "quantity": 2 }
Both fields are required; quantity is a whole number of at least 1.
Response 201: { "id": "ord_1001", "status": "created", "itemId": "itm_1", "quantity": 2 }
Response 400 { "error": "invalid_request", "message": "..." } when a field is missing or malformed.
Response 404 when itemId names no item.

GET /orders/{id}
One order by id. Response 200: the order as returned by POST /orders.

Errors
Every error body is { "error": "<code>", "message": "<sentence>" } with the HTTP status carrying the
class: 400 invalid_request, 401 unauthorized, 404 not_found.
`;

let orderCounter = 1000;

/** The vendor's answer for a request the proxy forwarded; the path is under the /v2 base. */
export function respondDemo(request: UpstreamRequest): Response {
  const url = new URL(request.url);
  if (request.headers.get(DEMO_KEY_HEADER) !== DEMO_API_KEY) {
    return Response.json(
      { error: "unauthorized", message: "the x-demo-key header is missing or not recognised" },
      { status: 401 },
    );
  }
  const path = url.pathname.replace(/^\/v2/, "");
  if (request.method === "GET" && path === "/items") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 100);
    return Response.json({ items: DEMO_ITEMS.slice(0, limit) });
  }
  const item = /^\/items\/([^/]+)$/.exec(path);
  if (request.method === "GET" && item) {
    const found = DEMO_ITEMS.find((entry) => entry.id === item[1]);
    return found
      ? Response.json(found)
      : Response.json({ error: "not_found", message: `no item ${item[1]}` }, { status: 404 });
  }
  if (request.method === "POST" && path === "/orders") {
    let parsed: { itemId?: unknown; quantity?: unknown } = {};
    try {
      parsed = JSON.parse(Buffer.from(request.body ?? new Uint8Array()).toString("utf8"));
    } catch {
      return Response.json(
        { error: "invalid_request", message: "the body is not JSON" },
        { status: 400 },
      );
    }
    if (typeof parsed.itemId !== "string" || typeof parsed.quantity !== "number") {
      return Response.json(
        { error: "invalid_request", message: "itemId (string) and quantity (number) are required" },
        { status: 400 },
      );
    }
    if (!DEMO_ITEMS.some((entry) => entry.id === parsed.itemId)) {
      return Response.json(
        { error: "not_found", message: `no item ${parsed.itemId}` },
        { status: 404 },
      );
    }
    orderCounter += 1;
    return Response.json(
      {
        id: `ord_${orderCounter}`,
        status: "created",
        itemId: parsed.itemId,
        quantity: parsed.quantity,
      },
      { status: 201 },
    );
  }
  return Response.json(
    { error: "not_found", message: `${request.method} ${path} is not an endpoint` },
    { status: 404 },
  );
}
