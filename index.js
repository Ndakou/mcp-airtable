import express from "express";
import Airtable from "airtable";
import { jwtVerify, createRemoteJWKSet } from "jose";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

// =======================
// ENV
// =======================
const PORT = process.env.PORT || 3000;
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const OAUTH_ISSUER_HOST = process.env.OAUTH_ISSUER; // ex: dev-xxx.eu.auth0.com
const OAUTH_AUDIENCE = process.env.OAUTH_AUDIENCE;  // ex: https://mrtechlab.cloud/

if (!AIRTABLE_PAT) throw new Error("Missing AIRTABLE_PAT");
if (!OAUTH_ISSUER_HOST) throw new Error("Missing OAUTH_ISSUER");
if (!OAUTH_AUDIENCE) throw new Error("Missing OAUTH_AUDIENCE");

const OAUTH_ISSUER = `https://${OAUTH_ISSUER_HOST}/`;

// =======================
// AUTH (JWT via Auth0 JWKS)
// =======================
const jwks = createRemoteJWKSet(new URL(`${OAUTH_ISSUER}.well-known/jwks.json`));

async function requireAuth(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;

  const token = auth.slice("Bearer ".length);
  try {
    await jwtVerify(token, jwks, {
      issuer: OAUTH_ISSUER,
      audience: OAUTH_AUDIENCE,
    });
    return true;
  } catch {
    return false;
  }
}

// =======================
// MCP SERVER
// =======================
const mcp = new McpServer({ name: "airtable-mcp", version: "1.0.0" });
const airtable = new Airtable({ apiKey: AIRTABLE_PAT });

// Tools (tu voulais full accès : bases/tables présentes & futures)
// 1) list bases
mcp.tool("airtable_list_bases", {}, async () => {
  const res = await fetch("https://api.airtable.com/v0/meta/bases", {
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
  });
  if (!res.ok) throw new Error(`Airtable error ${res.status}: ${await res.text()}`);
  return await res.json();
});

// 2) list tables for a base
mcp.tool(
  "airtable_list_tables",
  {
    baseId: "string",
  },
  async ({ baseId }) => {
    const res = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    });
    if (!res.ok) throw new Error(`Airtable error ${res.status}: ${await res.text()}`);
    return await res.json();
  }
);

// 3) list records
mcp.tool(
  "airtable_list_records",
  {
    baseId: "string",
    tableName: "string",
    maxRecords: "number",
  },
  async ({ baseId, tableName, maxRecords = 50 }) => {
    const base = airtable.base(baseId);
    const records = await base(tableName).select({ maxRecords }).all();
    return { records: records.map((r) => ({ id: r.id, fields: r.fields })) };
  }
);

// 4) create record
mcp.tool(
  "airtable_create_record",
  {
    baseId: "string",
    tableName: "string",
    fields: "object",
  },
  async ({ baseId, tableName, fields }) => {
    const base = airtable.base(baseId);
    const created = await base(tableName).create(fields);
    return { id: created.id, fields: created.fields };
  }
);

// 5) update record
mcp.tool(
  "airtable_update_record",
  {
    baseId: "string",
    tableName: "string",
    recordId: "string",
    fields: "object",
  },
  async ({ baseId, tableName, recordId, fields }) => {
    const base = airtable.base(baseId);
    const updated = await base(tableName).update(recordId, fields);
    return { id: updated.id, fields: updated.fields };
  }
);

// =======================
// EXPRESS APP
// =======================
const app = express();
app.use(express.json({ limit: "2mb" }));

// OAuth discovery endpoint (Claude web)
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const host = req.get("host");
  res.json({
    resource: `https://${host}/mcp`,
    authorization_servers: [`https://${OAUTH_ISSUER_HOST}`],
  });
});

// Streamable HTTP transport needs sessions
const transports = new Map();

app.all("/mcp", async (req, res) => {
  // Auth
  const ok = await requireAuth(req);
  if (!ok) return res.status(401).send("Unauthorized");

  // Session handling
  const sessionId = req.header("mcp-session-id") || null;
  let transport = sessionId ? transports.get(sessionId) : null;

  try {
    if (!transport) {
      if (!isInitializeRequest(req.body)) {
        return res.status(400).send("Expected initialize request");
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => transports.set(id, transport),
        // sécurité DNS rebinding (bon réflexe)
        enableDnsRebindingProtection: true,
      });

      transport.onclose = () => {
        if (transport?.sessionId) transports.delete(transport.sessionId);
      };

      await mcp.connect(transport);
    }

    await transport.handleRequest(req, res);
  } catch (e) {
    res.status(500).send(e?.message || "Server error");
  }
});

app.get("/", (req, res) => res.send("OK"));

app.listen(PORT, () => console.log(`MCP running on ${PORT}`));
