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

// ⚠️ SLASH FINAL OBLIGATOIRE
const OAUTH_ISSUER = `https://${OAUTH_ISSUER_HOST}/`;

// =======================
// AUTH (JWT via Auth0)
// =======================
const jwks = createRemoteJWKSet(
  new URL(`${OAUTH_ISSUER}.well-known/jwks.json`)
);

async function requireAuth(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;

  try {
    await jwtVerify(auth.slice(7), jwks, {
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
const mcp = new McpServer({
  name: "airtable-mcp",
  version: "1.0.0",
});

const airtable = new Airtable({ apiKey: AIRTABLE_PAT });

// =======================
// TOOLS AIRTABLE
// =======================

// List bases
mcp.tool("airtable_list_bases", {}, async () => {
  const res = await fetch("https://api.airtable.com/v0/meta/bases", {
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
});

// List tables
mcp.tool(
  "airtable_list_tables",
  { baseId: "string" },
  async ({ baseId }) => {
    const res = await fetch(
      `https://api.airtable.com/v0/meta/bases/${baseId}/tables`,
      { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` } }
    );
    if (!res.ok) throw new Error(await res.text());
    return await res.json();
  }
);

// List records
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
    return { records: records.map(r => ({ id: r.id, fields: r.fields })) };
  }
);

// Create record
mcp.tool(
  "airtable_create_record",
  {
    baseId: "string",
    tableName: "string",
    fields: "object",
  },
  async ({ baseId, tableName, fields }) => {
    const base = airtable.base(baseId);
    const rec = await base(tableName).create(fields);
    return { id: rec.id, fields: rec.fields };
  }
);

// Update record
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
    const rec = await base(tableName).update(recordId, fields);
    return { id: rec.id, fields: rec.fields };
  }
);

// =======================
// EXPRESS APP
// =======================
const app = express();
app.use(express.json({ limit: "2mb" }));

// 🔑 OAUTH DISCOVERY — CONFORME CLAUDE WEB
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource: "https://mcp-airtable-wdjk.onrender.com/mcp",
    authorization_servers: [
      "https://dev-pauyk4xelhthqkfg.eu.auth0.com/"
    ]
  });
});

// =======================
// MCP ENDPOINT
// =======================
const transports = new Map();

app.all("/mcp", async (req, res) => {
  const ok = await requireAuth(req);
  if (!ok) return res.status(401).send("Unauthorized");

  let transport = transports.get(req.header("mcp-session-id"));

  try {
    if (!transport) {
      if (!isInitializeRequest(req.body)) {
        return res.status(400).send("Expected initialize request");
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => transports.set(id, transport),
        enableDnsRebindingProtection: true,
      });

      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };

      await mcp.connect(transport);
    }

    await transport.handleRequest(req, res);
  } catch (e) {
    res.status(500).send(e?.message || "Server error");
  }
});

// =======================
// HEALTH
// =======================
app.get("/", (_, res) => res.send("OK"));

// =======================
// START
// =======================
app.listen(PORT, () => {
  console.log(`MCP running on ${PORT}`);
});

