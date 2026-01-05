import express from "express";
import Airtable from "airtable";
import { jwtVerify, createRemoteJWKSet } from "jose";
import {
  McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = express();
app.use(express.json());

const {
  AIRTABLE_PAT,
  OAUTH_ISSUER,
  OAUTH_AUDIENCE,
  PORT = 3000,
} = process.env;

// ===== MCP SERVER =====
const server = new McpServer({
  name: "airtable-mcp",
  version: "1.0.0",
});

const airtable = new Airtable({ apiKey: AIRTABLE_PAT });

// 🔓 FULL ACCESS (comme tu l’as demandé)
server.tool("list_bases", {}, async () => {
  const res = await fetch("https://api.airtable.com/v0/meta/bases", {
    headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
  });
  return await res.json();
});

server.tool("list_records", {
  inputSchema: {
    baseId: "string",
    table: "string",
  },
}, async ({ baseId, table }) => {
  const base = airtable.base(baseId);
  const records = await base(table).select().all();
  return records.map(r => ({ id: r.id, fields: r.fields }));
});

// ===== OAUTH CHECK =====
const jwks = createRemoteJWKSet(
  new URL(`https://${OAUTH_ISSUER}/.well-known/jwks.json`)
);

async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.sendStatus(401);

  const token = header.replace("Bearer ", "");
  await jwtVerify(token, jwks, {
    issuer: `https://${OAUTH_ISSUER}/`,
    audience: OAUTH_AUDIENCE,
  });

  next();
}

// ===== DISCOVERY ENDPOINT =====
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource: "https://mrtechlab.cloud/mcp",
    authorization_servers: [`https://${OAUTH_ISSUER}`],
  });
});

// ===== MCP ENDPOINT =====
app.all("/mcp", auth, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    request: req,
    response: res,
  });
  await server.connect(transport);
  await transport.handleRequest();
});

app.listen(PORT, () => {
  console.log("MCP running");
});
