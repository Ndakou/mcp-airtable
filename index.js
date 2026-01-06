import express from "express";
import Airtable from "airtable";

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
// AIRTABLE HELPERS
// =======================
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
// MCP TOOLS DEFINITION
// =======================
const TOOLS = [
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
];

// =======================
// TOOL EXECUTION
// =======================
async function executeTool(name, args) {
  console.log("🔧 Executing tool:", name, args);
  
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

    console.log("✅ Tool completed:", name);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error("❌ Tool error:", name, error);
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
}

// =======================
// ENDPOINTS
// =======================

/**
 * MCP root
 */
app.get("/mcp", (req, res) => {
  res.json({
    name: "Airtable MCP",
    version: "1.0.0",
    capabilities: {
      tools: {},
    },
  });
});

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
 * SSE endpoint (Claude s'y connecte automatiquement)
 */
app.get("/sse", (req, res) => {
  console.log("📡 SSE connection request");
  
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  // Send initialization message
  res.write("event: message\n");
  res.write(`data: ${JSON.stringify({
    jsonrpc: "2.0",
    method: "initialized",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "airtable-mcp",
        version: "1.0.0",
      },
    },
  })}\n\n`);
  
  console.log("✅ SSE connected");
  
  req.on("close", () => {
    console.log("🔒 SSE closed");
    res.end();
  });
});

/**
 * Messages endpoint (Claude envoie ses requêtes ici)
 */
app.post("/message", async (req, res) => {
  console.log("📨 Message received:", JSON.stringify(req.body).substring(0, 200));
  
  const { method, params, id } = req.body;
  
  try {
    let result;
    
    if (method === "tools/list") {
      console.log("📋 Listing tools");
      result = { tools: TOOLS };
    } else if (method === "tools/call") {
      const { name, arguments: args } = params;
      result = await executeTool(name, args);
    } else if (method === "initialize") {
      result = {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "airtable-mcp",
          version: "1.0.0",
        },
      };
    } else {
      throw new Error(`Unknown method: ${method}`);
    }
    
    res.json({
      jsonrpc: "2.0",
      id: id,
      result: result,
    });
  } catch (error) {
    console.error("💥 Error handling message:", error);
    res.json({
      jsonrpc: "2.0",
      id: id,
      error: {
        code: -32603,
        message: error.message,
      },
    });
  }
});

/**
 * Healthcheck (Render)
 */
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    service: "Airtable MCP Server",
    version: "1.0.0",
    endpoints: {
      sse: "/sse",
      message: "/message",
      mcp: "/mcp",
    },
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
  });
});

// =======================
// START
// =======================
app.listen(PORT, () => {
  console.log(`
🚀 ======================================
   MCP Airtable Server
   Port: ${PORT}
======================================
📡 SSE:     /sse
📨 Message: /message
======================================
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('👋 SIGINT received');
  process.exit(0);
});
