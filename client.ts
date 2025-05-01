import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  type CallToolRequest,
  type ListToolsRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { createInterface } from "readline/promises";

// Streamable HTTP トランスポートを使用して MCP サーバーに接続
const transport = new StreamableHTTPClientTransport(
  new URL("http://localhost:3000/mcp"),
  {
    sessionId: undefined,
  }
);

const client = new Client({
  name: "example-client",
  version: "0.0.1",
});

client.onerror = (error) => {
  console.error("Client error:", error);
};

// 標準入力を受け取るインターフェイス
const readline = createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function main() {
  try {
    // サーバーに接続するリクエストを送信
    await client.connect(transport);

    while (true) {
      console.log("avaible commands:");
      console.log("1. list-tools");
      console.log("2. call-tool");
      console.log("3. exit");
      console.log("------------------------------");

      const answer = await readline.question("Enter your input: ");

      switch (answer) {
        case "list-tools":
          await listTools();
          break;
        case "call-tool":
          await callTool();
          break;
        case "exit":
          await disconnect();
          console.log("Disconnected from server.");
          return;

        default:
          console.log("You entered:", answer);
          break;
      }
    }
  } catch (error) {
    console.error("Error:", error);
    disconnect();
  }
}

async function disconnect() {
  await transport.close();
  await client.close();
  readline.close();
  console.log("Disconnected from server.");
  process.exit(0);
}

main().catch((error) => {
  console.error("Error:", error);
  disconnect();
});

async function listTools() {
  const req: ListToolsRequest = {
    method: "tools/list",
    params: {},
  };

  const res = await client.request(req, ListToolsResultSchema);

  if (res.tools.length === 0) {
    console.log("No tools available.");
  } else {
    for (const tool of res.tools) {
      console.log(`Tool Name: ${tool.name}`);
      console.log(`Tool Description: ${tool.description}`);
      console.log("------------------------------");
    }
  }
}

async function callTool() {
  const sides = await readline.question(
    "Enter the number of sides on the dice: "
  );
  const sidesNumber = Number(sides);
  if (isNaN(sidesNumber) || sidesNumber <= 0) {
    console.error("Invalid input. Please enter a positive number.");
    return;
  }
  const req: CallToolRequest = {
    method: "tools/call",
    params: {
      name: "dice",
      arguments: { sides: sidesNumber },
    },
  };

  try {
    const res = await client.request(req, CallToolResultSchema);
    console.log("Tool response:");

    res.content.forEach((item) => {
      if (item.type === "text") {
        console.log(item.text);
      } else {
        console.log(item.type + "content", item);
      }
    });
    console.log("------------------------------");
  } catch (error) {
    console.error("Error calling tool:", error);
  }
}
