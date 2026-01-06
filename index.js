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

// Auth0 optionnel si vous voulez garder l'endpoint protégé
const OAUTH_ISSUER = OAUTH_ISSUER_HOST ? `https://${OAUTH_ISSUER_HOST}/` : null;

// =======================
// AUTH (JWT via Auth0)
// =======================
let jwks = null;
if (OAUTH_ISSUER) {
  jwks = createRemoteJWKSet(
    new URL(`${OAUTH_ISSUER}.well-known/jwks.json`)
  );
}

async function requireAuth(req) {
  if (!jwks || !OAUTH_ISSUER || !OAUTH_AUDIENCE) return false;
  
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

// Delete record
mcp.tool(
  "airtable_delete_record",
  {
    baseId: "string",
    tableName: "string",
    recordId: "string",
  },
  async ({ baseId, tableName, recordId }) => {
    const base = airtable.base(baseId);
    const deleted = await base(tableName).destroy(recordId);
    return { id: deleted.id, deleted: true };
  }
);

// =======================
// HELPER: MCP Request Handler
// =======================
async function handleMcpRequest(req, res, transports) {
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
    console.error("MCP Error:", e);
    res.status(500).send(e?.message || "Server error");
  }
}

// =======================
// EXPRESS APP
// =======================
const app = express();
app.use(express.json({ limit: "2mb" }));

// Transports pour chaque endpoint
const publicTransports = new Map();
const protectedTransports = new Map();

// 🔑 OAUTH DISCOVERY — CONFORME CLAUDE WEB (optionnel)
if (OAUTH_ISSUER) {
  app.get("/.well-known/oauth-protected-resource", (req, res) => {
    res.json({
      resource: "https://mcp-airtable-wdjk.onrender.com/mcp",
      authorization_servers: [OAUTH_ISSUER]
    });
  });
}

// =======================
// MCP ENDPOINT PUBLIC (pour Claude.ai)
// =======================
app.all("/mcp-public", async (req, res) => {
  console.log("📥 MCP Public request received");
  await handleMcpRequest(req, res, publicTransports);
});

// =======================
// MCP ENDPOINT PROTÉGÉ (avec OAuth)
// =======================
app.all("/mcp", async (req, res) => {
  const ok = await requireAuth(req);
  if (!ok) {
    console.log("❌ Unauthorized MCP request");
    return res.status(401).send("Unauthorized");
  }
  
  console.log("✅ Authorized MCP request");
  await handleMcpRequest(req, res, protectedTransports);
});

// =======================
// HEALTH CHECK
// =======================
app.get("/", (_, res) => {
  res.json({
    status: "OK",
    service: "Airtable MCP Server",
    version: "1.0.0",
    endpoints: {
      public: "/mcp-public (no auth required)",
      protected: "/mcp (OAuth required)",
    }
  });
});

app.get("/health", (_, res) => {
  res.json({ 
    status: "healthy",
    timestamp: new Date().toISOString()
  });
});

// =======================
// START
// =======================
app.listen(PORT, () => {
  console.log(`
🚀 MCP Airtable Server running on port ${PORT}
📍 Public endpoint:    /mcp-public (for Claude.ai)
🔒 Protected endpoint: /mcp (OAuth required)
  `);
});
