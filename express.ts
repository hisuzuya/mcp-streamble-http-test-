import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
import { randomUUID } from "node:crypto";

const app = express();
app.use(express.json());

const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

const mcpServer = new McpServer({ name: "my-server", version: "0.0.1" });

// シンプルにサイコロを振った結果を返すツール
mcpServer.tool(
  // ツールの名前
  "dice",
  // ツールの説明
  "サイコロを振った結果を返します",
  // ツールの引数のスキーマ
  { sides: z.number().min(1).default(6).describe("サイコロの面の数") },
  // ツールが実行されたときの処理
  async (input) => {
    const sides = input.sides ?? 6;
    const result = Math.floor(Math.random() * sides) + 1;
    return {
      content: [
        {
          type: "text",
          text: result.toString(),
        },
      ],
    };
  }
);

// POST リクエストで受け付ける
app.post("/mcp", async (req, res) => {
  try {
    // セッション ID がヘッダーに存在するか確認
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    // セッション ID が存在する場合はその transport を再利用
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (
      // セッション ID が存在しないかつ、初期化リクエストの場合は新しい transport を作成
      isInitializeRequest(req.body) &&
      !sessionId
    ) {
      const eventStore = new InMemoryEventStore();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore,
        onsessioninitialized: (sessionId) => {
          console.log(`Session initialized with ID: ${sessionId}`);
          transports[sessionId] = transport;
        },
      });

      // トランスポートが閉じられたとき、transports から削除
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          console.log(`Transport closed for session ID: ${sid}`);
          delete transports[sid];
        }
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      });
      return;
    }

    // すでにセッション ID が存在する場合は、その transport を使用してリクエストを処理
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

// GET リクエストは SSE エンドポイントとの互換性のために実装する必要がある
// SSE エンドポイントを実装しない場合は、405 Method Not Allowed を返す
app.get("/mcp", async (req, res) => {
  console.log("Received GET MCP request");
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    })
  );
});

// DELETE リクエストを受け取った場合、セッションを閉じる
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res
      .status(400)
      .send(
        "Invalid or missing session ID. Please provide a valid session ID."
      );
    return;
  }

  console.log(`Closing session for ID: ${sessionId}`);

  try {
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("Error closing transport:", error);
    if (!res.headersSent) {
      res.status(500).send("Error closing transport");
    }
  }
});

app.listen(3000, () => {
  console.log("Stateful server is running on http://localhost:3000/mcp");
});

// graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down server...");
  try {
    // すべてのトランスポートを閉じる
    for (const sessionId in transports) {
      const transport = transports[sessionId];
      if (transport) {
        await transport.close();
        console.log(`Transport closed for session ID: ${sessionId}`);
      }
    }
  } catch (error) {
    console.error(`Error closing transport:`, error);
  }

  await mcpServer.close();
  console.log("Server shutdown complete");
  process.exit(0);
});
