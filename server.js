// ============================================================================
// Lightspeed Retail (R-Series) — remote MCP server for Render (Node.js)
// A long-running HTTP server. Reads secrets from environment variables.
//
// Required environment variables (set them in the Render dashboard):
//   SECRET_PATH, LS_CLIENT_ID, LS_CLIENT_SECRET, LS_REFRESH_TOKEN
//
// Connector URL you give Claude:  https://<your-service>.onrender.com/<SECRET_PATH>
// ============================================================================
import http from "node:http";

const SECRET_PATH   = process.env.SECRET_PATH   || "";
const CLIENT_ID     = process.env.LS_CLIENT_ID  || "";
const CLIENT_SECRET = process.env.LS_CLIENT_SECRET || "";
const REFRESH_TOKEN = process.env.LS_REFRESH_TOKEN || "";
const PORT = process.env.PORT || 3000;

const TOKEN_URL = "https://cloud.lightspeedapp.com/oauth/access_token.php";
const API_BASE  = "https://api.lightspeedapp.com/API/V3";
const PROTOCOL_VERSION = "2024-11-05";

let _tok = { token: null, exp: 0 };
let _accountId = null;

async function getAccessToken() {
  const now = Date.now() / 1000;
  if (_tok.token && now < _tok.exp) return _tok.token;
  const body = new URLSearchParams({
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    grant_type: "refresh_token", refresh_token: REFRESH_TOKEN,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error("token refresh failed: " + r.status + " " + (await r.text()));
  const j = await r.json();
  _tok = { token: j.access_token, exp: now + (j.expires_in || 1800) - 60 };
  return _tok.token;
}

async function apiGet(path) {
  const token = await getAccessToken();
  const r = await fetch(API_BASE + path, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
  });
  const text = await r.text();
  if (!r.ok) throw new Error("Lightspeed API " + r.status + ": " + text);
  return JSON.parse(text);
}

async function accountId() {
  if (_accountId) return _accountId;
  const data = await apiGet("/Account.json");
  let a = data.Account;
  if (Array.isArray(a)) a = a[0];
  _accountId = String(a.accountID);
  return _accountId;
}

async function resourceGet(resource, params) {
  const id = await accountId();
  let path = "/Account/" + id + "/" + resource + ".json";
  if (params && Object.keys(params).length) {
    const qs = new URLSearchParams();
    for (const k in params) qs.set(k, String(params[k]));
    path += "?" + qs.toString();
  }
  return apiGet(path);
}

const TOOLS = [
  {
    name: "lightspeed_account",
    description: "Get the Lightspeed Retail (R-Series) account info, including the account ID and business name. Call this first to confirm the connection works.",
    inputSchema: { type: "object", properties: {} },
    run: async () => apiGet("/Account.json"),
  },
  {
    name: "lightspeed_get",
    description: "Generic read from the Lightspeed Retail (R-Series) API. Fetches a collection or single record for a resource under the account. Common resources: Sale, SaleLine, Item, Category, Customer, Shop, Employee, InventoryCount, PaymentType, TaxCategory. Use params for query options like limit, offset, sort (e.g. '-createTime'), timeStamp filters, or load_relations. Returns raw JSON.",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string", description: "Resource name, e.g. 'Sale', 'Item', 'Customer', 'Shop'." },
        params: { type: "object", description: "Optional query params, e.g. {\"limit\": 5, \"sort\": \"-createTime\"}." },
      },
      required: ["resource"],
    },
    run: async (a) => resourceGet(a.resource, a.params || {}),
  },
  {
    name: "lightspeed_recent_sales",
    description: "Get the most recent sales (transactions), newest first. Set load_lines=true to include line items (SaleLines).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "How many sales to return (default 10)." },
        load_lines: { type: "boolean", description: "Include SaleLines (line items)." },
      },
    },
    run: async (a) => {
      const params = { limit: a.limit || 10, sort: "-createTime" };
      if (a.load_lines) params.load_relations = '["SaleLines"]';
      return resourceGet("Sale", params);
    },
  },
  {
    name: "lightspeed_find_item",
    description: "Search inventory items by a text fragment in the description. Returns matching Item records (price, quantity on hand, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Text to match within the item description." },
        limit: { type: "integer", description: "Max items to return (default 20)." },
      },
      required: ["search"],
    },
    run: async (a) => resourceGet("Item", { description: "~,%" + a.search + "%", limit: a.limit || 20 }),
  },
];
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const publicTools = () => TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

async function dispatch(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return { jsonrpc: "2.0", id, result: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "lightspeed-retail", version: "1.0.0" },
    }};
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: publicTools() } };
  if (method === "tools/call") {
    const tool = TOOL_BY_NAME[params && params.name];
    if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } };
    try {
      const data = await tool.run((params && params.arguments) || {});
      let text = JSON.stringify(data, null, 2);
      if (text.length > 60000) text = text.slice(0, 60000) + "\n... (truncated)";
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
    } catch (e) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Error: " + e.message }], isError: true } };
    }
  }
  if (id === undefined || id === null) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 5_000_000) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, obj, contentType) => {
    res.writeHead(status, { "Content-Type": contentType || "application/json" });
    res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
  };

  // health check
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
    return send(200, "Lightspeed MCP server is running.", "text/plain");
  }
  // access control
  if (url.pathname.replace(/^\//, "") !== SECRET_PATH) {
    return send(404, "Not found", "text/plain");
  }
  if (req.method === "GET") return send(200, "", "text/plain");
  if (req.method !== "POST") return send(405, "Method not allowed", "text/plain");

  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return send(200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(dispatch))).filter((x) => x !== null);
    return send(200, out);
  }
  const result = await dispatch(body);
  if (result === null) { res.writeHead(202); return res.end(); }
  return send(200, result);
});

server.listen(PORT, () => console.log("Lightspeed MCP server listening on :" + PORT));
