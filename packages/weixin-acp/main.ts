#!/usr/bin/env node

/**
 * WeChat + ACP (Agent Client Protocol) adapter.
 *
 * Usage:
 *   npx weixin-acp login                          # QR-code login
 *   npx weixin-acp claude-code                     # Start with Claude Code
 *   npx weixin-acp codex                           # Start with Codex
 *   npx weixin-acp start -- <command> [args...]    # Start with custom agent
 *
 * HTTP Server Options:
 *   --message-server-port <port>                   # Enable HTTP server on specified port
 *   --message-server-key <key>                     # Authentication key for HTTP server
 *
 * HTTP Server Endpoints:
 *   POST /sendmessage                              # Send plain text message
 *   POST /sendmessage/json                         # Send JSON message (with text and/or media)
 *
 * Examples:
 *   npx weixin-acp start -- node ./my-agent.js
 *   npx weixin-acp claude-code --message-server-port 3000 --message-server-key mysecret
 *
 *   # Send text message:
 *   curl -X POST http://localhost:3000/sendmessage -H "Authorization: Bearer mysecret" -d "Hello!"
 *
 *   # Send JSON message with media:
 *   curl -X POST http://localhost:3000/sendmessage/json \
 *     -H "Authorization: Bearer mysecret" \
 *     -H "Content-Type: application/json" \
 *     -d '{"text":"Check this","media":{"type":"image","url":"/path/to/img.png"}}'
 */

import { isLoggedIn, login, logout, start } from "weixin-agent-sdk";
import http from "node:http";

import { AcpAgent } from "./src/acp-agent.js";

/** Built-in agent shortcuts */
const BUILTIN_AGENTS: Record<string, { command: string }> = {
  "claude-code": { command: "claude-agent-acp" },
  codex: { command: "codex-acp" },
};

const command = process.argv[2];

function parseArgs(): {
  messageServerPort?: number;
  messageServerKey?: string;
} {
  const args = process.argv.slice(2);
  const result: { messageServerPort?: number; messageServerKey?: string } = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--message-server-port" && i + 1 < args.length) {
      result.messageServerPort = Number.parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--message-server-key" && i + 1 < args.length) {
      result.messageServerKey = args[i + 1];
      i++;
    }
  }

  return result;
}

function startMessageServer(
  port: number,
  key: string | undefined,
  bot: Awaited<ReturnType<typeof start>>,
) {
  const server = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    // Parse URL to get path without query string
    const urlObj = new URL(req.url || "", `http://${req.headers.host}`);
    const path = urlObj.pathname;

    // Only accept /sendmessage or /sendmessage/json
    if (path !== "/sendmessage" && path !== "/sendmessage/json") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Check authentication if key is provided
    if (key) {
      const authHeader = req.headers.authorization;
      const queryKey = urlObj.searchParams.get("key");

      let authenticated = false;

      // Check HTTP Authorization header (Bearer or Basic)
      if (authHeader) {
        if (authHeader.startsWith("Bearer ")) {
          authenticated = authHeader.slice(7) === key;
        } else if (authHeader.startsWith("Basic ")) {
          // For Basic auth, just check if the key matches the password
          const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
          const [, password] = decoded.split(":");
          authenticated = password === key;
        }
      }

      // Check query parameter
      if (!authenticated && queryKey === key) {
        authenticated = true;
      }

      if (!authenticated) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    // Read request body
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on("end", async () => {
      try {
        let message: string | object;

        if (path === "/sendmessage/json") {
          // JSON endpoint: parse body as JSON
          message = JSON.parse(body);
        } else {
          // Default endpoint: treat body as plain text
          message = body;
        }

        await bot.sendMessage(message);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        );
      }
    });
  });

  server.listen(port, () => {
    console.log(`[message-server] HTTP server listening on port ${port}`);
    if (key) {
      console.log(`[message-server] Authentication enabled`);
    } else {
      console.log(`[message-server] WARNING: No authentication key set`);
    }
    console.log(`[message-server] POST to /sendmessage for text messages`);
    console.log(`[message-server] POST to /sendmessage/json for JSON messages`);
  });

  return server;
}

async function ensureLoggedIn() {
  if (!isLoggedIn()) {
    console.log("未检测到登录信息，请先扫码登录微信\n");
    await login();
  }
}

async function startAgent(acpCommand: string, acpArgs: string[] = []) {
  await ensureLoggedIn();

  const agent = new AcpAgent({ command: acpCommand, args: acpArgs });

  const ac = new AbortController();
  let httpServer: http.Server | undefined;

  process.on("SIGINT", () => {
    console.log("\n正在停止...");
    agent.dispose();
    httpServer?.close();
    ac.abort();
  });
  process.on("SIGTERM", () => {
    agent.dispose();
    httpServer?.close();
    ac.abort();
  });

  const bot = await start(agent, { abortSignal: ac.signal });

  // Start HTTP server if parameters are provided
  const { messageServerPort, messageServerKey } = parseArgs();
  if (messageServerPort) {
    httpServer = startMessageServer(messageServerPort, messageServerKey, bot);
  }

  return bot;
}

async function main() {
  if (command === "login") {
    await login();
    return;
  }

  if (command === "logout") {
    logout();
    return;
  }

  if (command === "start") {
    const ddIndex = process.argv.indexOf("--");
    if (ddIndex === -1 || ddIndex + 1 >= process.argv.length) {
      console.error("错误: 请在 -- 后指定 ACP agent 启动命令");
      console.error("示例: npx weixin-acp start -- codex-acp");
      process.exit(1);
    }

    const [acpCommand, ...acpArgs] = process.argv.slice(ddIndex + 1);
    await startAgent(acpCommand, acpArgs);
    return;
  }

  if (command && command in BUILTIN_AGENTS) {
    const { command: acpCommand } = BUILTIN_AGENTS[command];
    await startAgent(acpCommand);
    return;
  }

  console.log(`weixin-acp — 微信 + ACP 适配器

用法:
  npx weixin-acp login                          扫码登录微信
  npx weixin-acp logout                         退出登录
  npx weixin-acp claude-code                     使用 Claude Code
  npx weixin-acp codex                           使用 Codex
  npx weixin-acp start -- <command> [args...]    使用自定义 agent

HTTP 服务器选项:
  --message-server-port <port>                   启用 HTTP 服务器，监听指定端口
  --message-server-key <key>                     HTTP 服务器认证密钥

示例:
  npx weixin-acp start -- node ./my-agent.js
  npx weixin-acp claude-code --message-server-port 3000 --message-server-key mysecret`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
