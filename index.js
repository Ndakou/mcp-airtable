import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BASE_URL = "https://mcp-airtable-wdjk.onrender.com";

/**
 * MCP root
 */
app.get("/mcp", (req, res) => {
  res.json({
    name: "Airtable MCP",
    version: "1.0.0"
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
 * SSE endpoint (Claude s’y connecte automatiquement)
 */
app.get("/sse", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.write(`event: ready\ndata: connected\n\n`);

  req.on("close", () => {
    res.end();
  });
});

/**
 * Messages endpoint (Claude envoie ses requêtes ici)
 */
app.post("/message", (req, res) => {
  res.json({
    type: "message",
    content: [
      {
        type: "text",
        text: "MCP Airtable server is running."
      }
    ]
  });
});

/**
 * Healthcheck (Render)
 */
app.get("/", (req, res) => {
  res.send("MCP Airtable server up");
});

app.listen(PORT, () => {
  console.log(`MCP running on ${PORT}`);
});
