import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { toFetchResponse, toReqRes } from "fetch-to-node";

const app = new Hono();

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
app.post("/mcp", async (c) => {
  const { req, res } = toReqRes(c.req.raw);
  try {
    const body = await c.req.json();
    // セッション ID がヘッダーに存在するか確認
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    // セッション ID が存在する場合はその transport を再利用
    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (
      // セッション ID が存在しないかつ、初期化リクエストの場合は新しい transport を作成
      isInitializeRequest(body) &&
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
      await transport.handleRequest(req, res, body);

      // Node.jsのレスポンスをFetch APIのレスポンスに変換して返す
      return toFetchResponse(res);
    } else {
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        },
        { status: 400 }
      );
    }

    // すでにセッション ID が存在する場合は、その transport を使用してリクエストを処理
    await transport.handleRequest(req, res, body);

    // Node.jsのレスポンスをFetch APIのレスポンスに変換して返す
    return toFetchResponse(res);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        },
        { status: 500 }
      );
    }
  }
});

// GET リクエストは SSE エンドポイントとの互換性のために実装する必要がある
// SSE エンドポイントを実装しない場合は、405 Method Not Allowed を返す
app.get("/mcp", async (c) => {
  console.log("Received GET MCP request");
  return c.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    },
    { status: 405 }
  );
});

// DELETE リクエストを受け取った場合、セッションを閉じる
app.delete("/mcp", async (c) => {
  const { req, res } = toReqRes(c.req.raw);
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            "Invalid or missing session ID. Please provide a valid session ID.",
        },
        id: null,
      },
      { status: 400 }
    );
  }

  console.log(`Closing session for ID: ${sessionId}`);

  try {
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);

    // Node.jsのレスポンスをFetch APIのレスポンスに変換して返す
    return toFetchResponse(res);
  } catch (error) {
    console.error("Error closing transport:", error);
    if (!res.headersSent) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Error closing transport",
          },
          id: null,
        },
        { status: 500 }
      );
    }
  }
});

// シグナルを受け取ったらサーバーをシャットダウン
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

console.log("Stateful server is running on http://localhost:3000/mcp");

export default {
  port: 3000,
  fetch: app.fetch,
};
