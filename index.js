import express from "express";
import Airtable from "airtable";
import { jwtVerify, createRemoteJWKSet } from "jose";

import { McpServer } from "@modelcontextprotocol/sdk/server";
import { HttpServerTransport } from "@modelcontextprotocol/sdk/server/http";

// =======================
// CONFIG
// =======================
const PORT = process.env.PORT || 3000;
const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
const OAUTH_ISSUER = `https://${process.env.OAUTH_ISSUER}`;
const OAUTH_AUDIENCE = process.env.OAUTH_AUDIENCE;

// =======================
// EXPRESS
// =======================
const app = express();
app.use(express.json());

// =======================
// OAUTH (CLAUDE)
// =======================
const jwks = createRemoteJWKSet(
  new URL(`${OAUTH_ISSUER}/.well-known/jwks.json`)
);

async function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    await jwtVerify(auth.slice(7), jwks, {
      issuer: OAUTH_ISSUER,
      audience: OAUTH_AUDIENCE,
    });
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// =======================
// MCP SERVER
// =======================
const mcp = new McpServer({
  name: "airtable-mcp",
  version: "1.0.0",
});

// =======================
// AIRTABLE TOOL
// =======================
mcp.tool(
  "list_airtable_records",
  {
    baseId: "string",
    tableName: "string",
  },
  async ({ baseId, tableName }) => {
    const base = new Airtable({ apiKey: AIRTABLE_PAT }).base(baseId);

    const records = [];
    await base(tableName)
      .select({ maxRecords: 20 })
      .eachPage((page, next) => {
        page.forEach((r) =>
          records.push({ id: r.id, fields: r.fields })
        );
        next();
      });

    return { records };
  }
);

// =======================
// MCP HTTP
// =======================
const transport = new HttpServerTransport();

app.post("/mcp", authenticate, async (req, res) => {
  await transport.handleRequest(req, res, mcp);
});

// =======================
// DISCOVERY (CLAUDE)
// =======================
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource: "airtable-mcp",
    authorization_servers: [OAUTH_ISSUER],
  });
});

// =======================
// HEALTH
// =======================
app.get("/", (req, res) => {
  res.send("MCP Airtable running");
});

// =======================
// START
// =======================
app.listen(PORT, () => {
  console.log(`MCP Airtable live on port ${PORT}`);
});
