// server.ts - Data Steward MCP Server

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  Notification,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  LoggingMessageNotification,
  ToolListChangedNotification,
  JSONRPCNotification,
  JSONRPCError,
  InitializeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import { Request, Response } from "express";
import * as dotenv from "dotenv";
import { Client } from "pg";

dotenv.config();

const SESSION_ID_HEADER_NAME = "mcp-session-id";
const JSON_RPC = "2.0";

type DBConnectionInfo = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

export class MCPServer {
  server: Server;
  transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
  private toolInterval: NodeJS.Timeout | undefined;
  private getDDLToolName = "get_database_table_ddl";

  constructor(server: Server) {
    this.server = server;
    this.setupTools();
  }

  async handleGetRequest(req: Request, res: Response) {
    const sessionId = req.headers[SESSION_ID_HEADER_NAME] as string | undefined;
    if (!sessionId || !this.transports[sessionId]) {
      res.status(400).json(this.createErrorResponse("Bad Request: invalid session ID or method."));
      return;
    }
    const transport = this.transports[sessionId];
    await transport.handleRequest(req, res);
    await this.streamMessages(transport);
    return;
  }

  async handlePostRequest(req: Request, res: Response) {
    const sessionId = req.headers[SESSION_ID_HEADER_NAME] as string | undefined;
    let transport: StreamableHTTPServerTransport;
    try {
      if (sessionId && this.transports[sessionId]) {
        transport = this.transports[sessionId];
        await transport.handleRequest(req, res, req.body);
        return;
      }
      if (!sessionId && this.isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        await this.server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        const sessionId = transport.sessionId;
        if (sessionId) {
          this.transports[sessionId] = transport;
        }
        return;
      }
      res.status(400).json(this.createErrorResponse("Bad Request: invalid session ID or method."));
      return;
    } catch (error) {
      console.error("Error handling MCP request:", error);
      res.status(500).json(this.createErrorResponse("Internal server error."));
      return;
    }
  }

  async cleanup() {
    this.toolInterval?.close();
    await this.server.close();
  }

  private setupTools() {
    const setToolSchema = () =>
      this.server.setRequestHandler(ListToolsRequestSchema, async () => {
        const getDDLTool = {
          name: this.getDDLToolName,
          description: "Retrieves the DDL for a specified table and generates a human-readable data dictionary using AI reasoning.",
          inputSchema: {
            type: "object",
            properties: {
              database_type: { type: "string", description: "Type of database (e.g., PostgreSQL)" },
              connection_info: {
                type: "object",
                properties: {
                  host: { type: "string" },
                  port: { type: "number" },
                  user: { type: "string" },
                  password: { type: "string" },
                  database: { type: "string" }
                },
                required: ["host", "port", "user", "password", "database"]
              },
              table_name: { type: "string", description: "Name of the table" }
            },
            required: ["database_type", "connection_info", "table_name"]
          }
        };
        return { tools: [getDDLTool] };
      });

    setToolSchema();
    this.toolInterval = setInterval(async () => {
      setToolSchema();
      Object.values(this.transports).forEach((transport) => {
        const notification: ToolListChangedNotification = { method: "notifications/tools/list_changed" };
        this.sendNotification(transport, notification);
      });
    }, 5000);

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const args = request.params.arguments;
      const toolName = request.params.name;
      if (!args) throw new Error("arguments undefined");
      if (!toolName) throw new Error("tool name undefined");

      if (toolName === this.getDDLToolName) {
        return await this.handleGetDDLTool(args);
      }
      throw new Error("Tool not found");
    });
  }

  private async handleGetDDLTool(args: any) {
    const { database_type, connection_info, table_name } = args;
    if (!database_type || !connection_info || !table_name) {
      return {
        content: [
          { type: "text", text: "Missing required parameters: database_type, connection_info, or table_name." }
        ]
      };
    }
    if (database_type.toLowerCase() !== "postgresql" && database_type.toLowerCase() !== "postgres") {
      return {
        content: [
          { type: "text", text: `Unsupported database type: ${database_type}. Only PostgreSQL is supported.` }
        ]
      };
    }

    // Use .env as fallback if any connection_info field is missing
    const conn: DBConnectionInfo = {
      host: connection_info.host || process.env.PGHOST,
      port: connection_info.port || Number(process.env.PGPORT),
      user: connection_info.user || process.env.PGUSER,
      password: connection_info.password || process.env.PGPASSWORD,
      database: connection_info.database || process.env.PGDATABASE
    };

    if (!conn.host || !conn.port || !conn.user || !conn.password || !conn.database) {
      return {
        content: [
          { type: "text", text: "Database connection info is incomplete. Please provide all required fields or set them in .env." }
        ]
      };
    }

    let ddlRows: any[] = [];
    let ddlError: string | null = null;
    try {
      const client = new Client(conn);
      await client.connect();
      const ddlQuery = `
        SELECT column_name, data_type, character_maximum_length
        FROM information_schema.columns
        WHERE table_catalog = $1 AND table_name = $2
        ORDER BY ordinal_position ASC;
      `;
      const result = await client.query(ddlQuery, [conn.database, table_name]);
      ddlRows = result.rows;
      await client.end();
    } catch (err: any) {
      ddlError = err.message || String(err);
    }

    if (ddlError) {
      return {
        content: [
          { type: "text", text: `Failed to retrieve DDL: ${ddlError}` }
        ]
      };
    }

    // Generate a simple data dictionary (AI reasoning placeholder)
    let dataDictionary = `Table "${table_name}" columns:\n`;
    if (ddlRows.length === 0) {
      dataDictionary += "No columns found.";
    } else {
      for (const row of ddlRows) {
        dataDictionary += `- ${row.column_name}: ${row.data_type}`;
        if (row.character_maximum_length) {
          dataDictionary += `(${row.character_maximum_length})`;
        }
        dataDictionary += "\n";
      }
    }

    return {
      content: [
        { type: "text", text: `DDL (columns):\n${JSON.stringify(ddlRows, null, 2)}` },
        { type: "text", text: `Data Dictionary:\n${dataDictionary}` }
      ]
    };
  }

  private async streamMessages(transport: StreamableHTTPServerTransport) {
    try {
      const message: LoggingMessageNotification = {
        method: "notifications/message",
        params: { level: "info", data: "SSE Connection established" }
      };
      this.sendNotification(transport, message);
      let messageCount = 0;
      const interval = setInterval(async () => {
        messageCount++;
        const data = `Message ${messageCount} at ${new Date().toISOString()}`;
        const message: LoggingMessageNotification = {
          method: "notifications/message",
          params: { level: "info", data: data }
        };
        try {
          this.sendNotification(transport, message);
          if (messageCount === 2) {
            clearInterval(interval);
            const message: LoggingMessageNotification = {
              method: "notifications/message",
              params: { level: "info", data: "Streaming complete!" }
            };
            this.sendNotification(transport, message);
          }
        } catch (error) {
          console.error("Error sending message:", error);
          clearInterval(interval);
        }
      }, 1000);
    } catch (error) {
      console.error("Error sending message:", error);
    }
  }

  private async sendNotification(
    transport: StreamableHTTPServerTransport,
    notification: Notification
  ) {
    const rpcNotification: JSONRPCNotification = {
      ...notification,
      jsonrpc: JSON_RPC,
    };
    await transport.send(rpcNotification);
  }

  private createErrorResponse(message: string): JSONRPCError {
    return {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: message,
      },
      id: randomUUID(),
    };
  }

  private isInitializeRequest(body: any): boolean {
    const isInitial = (data: any) => {
      const result = InitializeRequestSchema.safeParse(data);
      return result.success;
    };
    if (Array.isArray(body)) {
      return body.some((request) => isInitial(request));
    }
    return isInitial(body);
  }
}
