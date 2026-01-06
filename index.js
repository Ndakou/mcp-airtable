import express from "express";
import Airtable from "airtable";
import { jwtVerify, createRemoteJWKSet } from "jose";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { 
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

// =======================
// ENV
// =======================
const PORT = process.env.PORT || 3000;
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const OAUTH_ISSUER_HOST = process.env.OAUTH_ISSUER;
const OAUTH_AUDIENCE = process.env.OAUTH_AUDIENCE;

if (!AIRTABLE_PAT) throw new Error("Missing AIRTABLE_PAT");

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
// AIRTABLE HELPERS
// =======================
const airtable = new Airtable({ apiKey: AIRTABLE_PAT });

async function listBases() {
  console.log("🔧 Tool: airtable_list_bases");
  const res = await fetch("https://api.airtable.com/v0/meta/bases", {
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function listTables(baseId) {
  console.log("🔧 Tool: airtable_list_tables", { baseId });
  const res = await fetch(
    `https://api.airtable.com/v0/meta/bases/${baseId}/tables`,
    { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` } }
  );
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function listRecords(baseId, tableName, maxRecords = 50) {
  console.log("🔧 Tool: airtable_list_records", { baseId, tableName, maxRecords });
  const base = airtable.base(baseId);
  const records = await base(tableName).select({ maxRecords }).all();
  return { records: records.map(r => ({ id: r.id, fields: r.fields })) };
}

async function createRecord(baseId, tableName, fields) {
  console.log("🔧 Tool: airtable_create_record", { baseId, tableName });
  const base = airtable.base(baseId);
  const rec = await base(tableName).create(fields);
  return { id: rec.id, fields: rec.fields };
}

async function updateRecord(baseId, tableName, recordId, fields) {
  console.log("🔧 Tool: airtable_update_record", { baseId, tableName, recordId });
  const base = airtable.base(baseId);
  const rec = await base(tableName).update(recordId, fields);
  return { id: rec.id, fields: rec.fields };
}

async function deleteRecord(baseId, tableName, recordId) {
  console.log("🔧 Tool: airtable_delete_record", { baseId, tableName, recordId });
  const base = airtable.base(baseId);
  const deleted = await base(tableName).destroy(recordId);
  return { id: deleted.id, deleted: true };
}

// =======================
// MCP SERVER FACTORY
// =======================
function createMCPServer() {
  const server = new Server(
    {
      name: "airtable-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "airtable_list_bases",
        description: "List all Airtable bases accessible with your API key",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "airtable_list_tables",
        description: "List all tables in a specific Airtable base",
        inputSchema: {
          type: "object",
          properties: {
            baseId: { 
              type: "string", 
              description: "The Airtable base ID (starts with 'app')" 
            },
          },
          required: ["baseId"],
        },
      },
      {
        name: "airtable_list_records",
        description: "List records from a table in an Airtable base",
        inputSchema: {
          type: "object",
          properties: {
            baseId: { 
              type: "string", 
              description: "The Airtable base ID" 
            },
            tableName: { 
              type: "string", 
              description: "The name of the table" 
            },
            maxRecords: { 
              type: "number", 
              description: "Maximum number of records to return (default: 50)" 
            },
          },
          required: ["baseId", "tableName"],
        },
      },
      {
        name: "airtable_create_record",
        description: "Create a new record in an Airtable table",
        inputSchema: {
          type: "object",
          properties: {
            baseId: { type: "string", description: "The Airtable base ID" },
            tableName: { type: "string", description: "The table name" },
            fields: { 
              type: "object", 
              description: "Object with field names as keys and values" 
            },
          },
          required: ["baseId", "tableName", "fields"],
        },
      },
      {
        name: "airtable_update_record",
        description: "Update an existing record in an Airtable table",
        inputSchema: {
          type: "object",
          properties: {
            baseId: { type: "string" },
            tableName: { type: "string" },
            recordId: { type: "string", description: "The record ID to update" },
            fields: { type: "object", description: "Fields to update" },
          },
          required: ["baseId", "tableName", "recordId", "fields"],
        },
      },
      {
        name: "airtable_delete_record",
        description: "Delete a record from an Airtable table",
        inputSchema: {
          type: "object",
          properties: {
            baseId: { type: "string" },
            tableName: { type: "string" },
            recordId: { type: "string", description: "The record ID to delete" },
          },
          required: ["baseId", "tableName", "recordId"],
        },
      },
    ],
  }));

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result;
      switch (name) {
        case "airtable_list_bases":
          result = await listBases();
          break;
        case "airtable_list_tables":
          result = await listTables(args.baseId);
          break;
        case "airtable_list_records":
          result = await listRecords(args.baseId, args.tableName, args.maxRecords);
          break;
        case "airtable_create_record":
          result = await createRecord(args.baseId, args.tableName, args.fields);
          break;
        case "airtable_update_record":
          result = await updateRecord(args.baseId, args.tableName, args.recordId, args.fields);
          break;
        case "airtable_delete_record":
          result = await deleteRecord(args.baseId, args.tableName, args.recordId);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error("Tool error:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// =======================
// EXPRESS APP
// =======================
const app = express();
app.use(express.json());

// Logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Sessions
const sessions = new Map();

// =======================
// SSE ENDPOINT PUBLIC
// =======================
app.get("/mcp-public/sse", async (req, res) => {
  console.log("📡 SSE connection request");
  
  const sessionId = randomUUID();
  console.log("🆔 Session ID:", sessionId);
  
  try {
    // 1. Créer le serveur et le transport
    const server = createMCPServer();
    const transport = new SSEServerTransport("/mcp-public/message", res);
    
    // 2. Sauvegarder la session
    sessions.set(sessionId, { server, transport });
    
    // 3. Connecter (cela gère les headers SSE automatiquement)
    await server.connect(transport);
    console.log("✅ SSE connected:", sessionId);
    
    // 4. Cleanup on close
    req.on("close", () => {
      console.log("🔒 SSE closed:", sessionId);
      sessions.delete(sessionId);
    });
    
  } catch (error) {
    console.error("💥 SSE connection error:", error);
    sessions.delete(sessionId);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

app.post("/mcp-public/message", async (req, res) => {
  const sessionId = req.header("x-session-id");
  console.log("📨 Message for session:", sessionId);
  
  const session = sessions.get(sessionId);
  if (!session) {
    console.log("❌ Session not found:", sessionId);
    return res.status(404).json({ error: "Session not found" });
  }

  try {
    await session.transport.handlePostMessage(req, res);
    console.log("✅ Message handled");
  } catch (error) {
    console.error("💥 Error handling message:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// =======================
// SSE ENDPOINT PROTÉGÉ
// =======================
app.get("/mcp/sse", async (req, res) => {
  const ok = await requireAuth(req);
  if (!ok) return res.status(401).send("Unauthorized");

  console.log("📡 Protected SSE connection request");
  
  const sessionId = randomUUID();
  
  try {
    const server = createMCPServer();
    const transport = new SSEServerTransport("/mcp/message", res);
    sessions.set(sessionId, { server, transport });
    
    await server.connect(transport);
    console.log("✅ Protected SSE connected:", sessionId);

    req.on("close", () => {
      console.log("🔒 Protected SSE closed:", sessionId);
      sessions.delete(sessionId);
    });
  } catch (error) {
    console.error("Error:", error);
    sessions.delete(sessionId);
  }
});

app.post("/mcp/message", async (req, res) => {
  const ok = await requireAuth(req);
  if (!ok) return res.status(401).send("Unauthorized");

  const sessionId = req.header("x-session-id");
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  try {
    await session.transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// =======================
// HEALTH
// =======================
app.get("/", (_, res) => {
  res.json({
    status: "OK",
    service: "Airtable MCP Server",
    version: "2.0.0",
    protocol: "SSE",
    endpoints: {
      public: "/mcp-public/sse",
      protected: "/mcp/sse",
    },
    sessions: sessions.size,
  });
});

app.get("/health", (_, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    sessions: sessions.size,
  });
});

// =======================
// ERROR HANDLER
// =======================
app.use((err, req, res, next) => {
  console.error("💥 Express Error:", err);
  if (!res.headersSent) {
    res.status(500).json({
      error: "Internal Server Error",
      message: err.message,
    });
  }
});

// =======================
// START
// =======================
app.listen(PORT, () => {
  console.log(`
🚀 ======================================
   MCP Airtable Server (SSE)
   Port: ${PORT}
======================================
📡 Public SSE:     /mcp-public/sse
🔒 Protected SSE:  /mcp/sse
❤️  Health:        /health
======================================
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received');
  sessions.clear();
  process.exit(0);
});
