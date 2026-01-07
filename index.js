import express from "express";
import Airtable from "airtable";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;

if (!AIRTABLE_PAT) throw new Error("Missing AIRTABLE_PAT");

const airtable = new Airtable({ apiKey: AIRTABLE_PAT });

// =======================
// AIRTABLE FUNCTIONS
// =======================
async function listBases() {
  const res = await fetch("https://api.airtable.com/v0/meta/bases", {
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function listTables(baseId) {
  const res = await fetch(
    `https://api.airtable.com/v0/meta/bases/${baseId}/tables`,
    { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` } }
  );
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function listRecords(baseId, tableName, maxRecords = 50) {
  const base = airtable.base(baseId);
  const records = await base(tableName).select({ maxRecords }).all();
  return { records: records.map(r => ({ id: r.id, fields: r.fields })) };
}

async function createRecord(baseId, tableName, fields) {
  const base = airtable.base(baseId);
  const rec = await base(tableName).create(fields);
  return { id: rec.id, fields: rec.fields };
}

async function updateRecord(baseId, tableName, recordId, fields) {
  const base = airtable.base(baseId);
  const rec = await base(tableName).update(recordId, fields);
  return { id: rec.id, fields: rec.fields };
}

async function deleteRecord(baseId, tableName, recordId) {
  const base = airtable.base(baseId);
  const deleted = await base(tableName).destroy(recordId);
  return { id: deleted.id, deleted: true };
}

// =======================
// TOOLS
// =======================
const tools = [
  {
    name: "airtable_list_bases",
    description: "List all Airtable bases",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "airtable_list_tables",
    description: "List tables in a base",
    inputSchema: {
      type: "object",
      properties: { baseId: { type: "string", description: "Base ID" } },
      required: ["baseId"],
    },
  },
  {
    name: "airtable_list_records",
    description: "List records from a table",
    inputSchema: {
      type: "object",
      properties: {
        baseId: { type: "string" },
        tableName: { type: "string" },
        maxRecords: { type: "number", default: 50 },
      },
      required: ["baseId", "tableName"],
    },
  },
  {
    name: "airtable_create_record",
    description: "Create a record",
    inputSchema: {
      type: "object",
      properties: {
        baseId: { type: "string" },
        tableName: { type: "string" },
        fields: { type: "object" },
      },
      required: ["baseId", "tableName", "fields"],
    },
  },
  {
    name: "airtable_update_record",
    description: "Update a record",
    inputSchema: {
      type: "object",
      properties: {
        baseId: { type: "string" },
        tableName: { type: "string" },
        recordId: { type: "string" },
        fields: { type: "object" },
      },
      required: ["baseId", "tableName", "recordId", "fields"],
    },
  },
  {
    name: "airtable_delete_record",
    description: "Delete a record",
    inputSchema: {
      type: "object",
      properties: {
        baseId: { type: "string" },
        tableName: { type: "string" },
        recordId: { type: "string" },
      },
      required: ["baseId", "tableName", "recordId"],
    },
  },
];

// =======================
// EXECUTE TOOL
// =======================
async function executeTool(name, args) {
  console.log(`🔧 ${name}:`, args);
  
  switch (name) {
    case "airtable_list_bases":
      return await listBases();
    case "airtable_list_tables":
      return await listTables(args.baseId);
    case "airtable_list_records":
      return await listRecords(args.baseId, args.tableName, args.maxRecords);
    case "airtable_create_record":
      return await createRecord(args.baseId, args.tableName, args.fields);
    case "airtable_update_record":
      return await updateRecord(args.baseId, args.tableName, args.recordId, args.fields);
    case "airtable_delete_record":
      return await deleteRecord(args.baseId, args.tableName, args.recordId);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// =======================
// MCP ENDPOINT
// =======================
app.post("/mcp", async (req, res) => {
  const { jsonrpc, id, method, params } = req.body;
  console.log(`📨 ${method}`);
  
  try {
    let result;
    
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "airtable-mcp", version: "1.0.0" },
        };
        break;
        
      case "notifications/initialized":
        // Claude envoie cette notification après l'initialisation
        // Pas besoin de réponse, juste un accusé de réception
        console.log("✅ Client initialized");
        return res.json({ jsonrpc: "2.0", id, result: {} });
        
      case "tools/list":
        result = { tools };
        break;
        
      case "tools/call":
        const data = await executeTool(params.name, params.arguments || {});
        result = {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
        break;
        
      default:
        throw new Error(`Unknown method: ${method}`);
    }
    
    res.json({ jsonrpc: "2.0", id, result });
  } catch (error) {
    console.error("❌", error.message);
    res.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error.message },
    });
  }
});

app.get("/mcp", (req, res) => {
  res.json({ status: "ready" });
});

app.get("/", (req, res) => {
  res.json({
    service: "Airtable MCP",
    version: "1.0.0",
    endpoint: "/mcp",
  });
});

app.listen(PORT, () => console.log(`🚀 Port ${PORT}`));
