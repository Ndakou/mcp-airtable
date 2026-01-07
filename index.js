import express from "express";
import Airtable from "airtable";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BASE_URL = "https://mcp-airtable-wdjk.onrender.com";
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;

if (!AIRTABLE_PAT) {
  throw new Error("Missing AIRTABLE_PAT environment variable");
}

const airtable = new Airtable({ apiKey: AIRTABLE_PAT });

// =======================
// MCP SERVER
// =======================
const mcp = new McpServer({
  name: "airtable-mcp",
  version: "1.0.0",
});

// =======================
// AIRTABLE TOOLS
// =======================

// List bases
mcp.tool("airtable_list_bases", {}, async () => {
  console.log("🔧 Tool: airtable_list_bases");
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
    console.log("🔧 Tool: airtable_list_tables", { baseId });
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
    console.log("🔧 Tool: airtable_list_records", { baseId, tableName, maxRecords });
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
    console.log("🔧 Tool: airtable_create_record", { baseId, tableName });
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
    console.log("🔧 Tool: airtable_update_record", { baseId, tableName, recordId });
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
    console.log("🔧 Tool: airtable_delete_record", { baseId, tableName, recordId });
    const base = airtable.base(baseId);
    const deleted = await base(tableName).destroy(recordId);
    return { id: deleted.id, deleted: true };
  }
);

// =======================
// TRANSPORT MANAGEMENT
// =======================
const transports = new Map();

// =======================
// ENDPOINTS
// =======================

/**
 * OAuth discovery (OBLIGATOIRE pour Claude Web)
 */
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource: `${BASE_URL}/mcp`,
    authorization_servers: [
      "https://dev-pauyk4xelhthqkfg.eu.auth0.com/"
    ]
  });
});

/**
 * MCP HTTP endpoint
 */
app.all("/mcp", async (req, res) => {
  console.log("📥 MCP request:", {
    method: req.method,
    body: req.body ? JSON.stringify(req.body).substring(0, 200) : 'no body',
    sessionId: req.header("mcp-session-id")
  });

  let transport = transports.get(req.header("mcp-session-id"));

  try {
    if (!transport) {
      console.log("🔄 No existing transport");
      
      if (!isInitializeRequest(req.body)) {
        console.log("❌ Not an initialize request");
        return res.status(400).send("Expected initialize request");
      }

      console.log("✅ Valid initialize request, creating transport");
      
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          console.log("🎯 Session initialized:", id);
          transports.set(id, transport);
        },
        enableDnsRebindingProtection: false,
      });

      transport.onclose = () => {
        console.log("🔒 Transport closed:", transport.sessionId);
        if (transport.sessionId) transports.delete(transport.sessionId);
      };

      console.log("🔌 Connecting to MCP server");
      await mcp.connect(transport);
      console.log("✅ MCP connected successfully");
    } else {
      console.log("♻️ Using existing transport:", req.header("mcp-session-id"));
    }

    console.log("🚀 Handling request");
    await transport.handleRequest(req, res);
    console.log("✅ Request handled successfully");
    
  } catch (e) {
    console.error("💥 MCP Error:", {
      message: e?.message,
      stack: e?.stack,
    });
    
    if (!res.headersSent) {
      res.status(500).json({
        error: e?.message || "Server error"
      });
    }
  }
});

/**
 * Healthcheck
 */
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "Airtable MCP Server",
    version: "1.0.0",
    protocol: "HTTP",
    endpoints: {
      mcp: "/mcp",
    },
    activeSessions: transports.size,
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    activeSessions: transports.size,
  });
});

// =======================
// START
// =======================
app.listen(PORT, () => {
  console.log(`
🚀 ======================================
   MCP Airtable Server (HTTP)
   Port: ${PORT}
======================================
📡 MCP endpoint: /mcp
======================================
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received');
  transports.forEach((t, id) => {
    console.log('Closing transport:', id);
    t.close?.();
  });
  transports.clear();
  process.exit(0);
});
