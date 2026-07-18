import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';

interface McpResponse {
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: { message?: string };
}

export interface SearchFilesArgs {
  queries: string[];
  root?: string;
  maxResults?: number;
  maxDepth?: number;
  modifiedAfter?: string;
  modifiedBefore?: string;
}

@Injectable()
export class McpClientService {
  private readonly scanMcpUrl: string;

  constructor(config: ConfigService) {
    this.scanMcpUrl =
      config.get<string>('SCAN_MCP_URL') ?? 'http://localhost:3100/mcp';
  }

  scanDirectory(path: string): Promise<unknown> {
    return this.callTool('scan_directory', { path });
  }

  searchFiles(args: SearchFilesArgs): Promise<unknown> {
    return this.callTool('search_files', { ...args });
  }

  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.scanMcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: randomUUID(),
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
    } catch (error) {
      throw new BadGatewayException(
        `Cannot connect to Scan MCP: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok)
      throw new BadGatewayException(
        `Scan MCP returned HTTP ${response.status}`,
      );
    const raw = await response.text();
    const body = this.parseResponse(raw);
    if (body.error?.message) throw new BadGatewayException(body.error.message);
    if (body.result?.isError)
      throw new BadGatewayException(
        body.result.content?.[0]?.text ?? 'Scan MCP tool failed',
      );
    const text = body.result?.content?.find(
      (item) => item.type === 'text',
    )?.text;
    if (!text)
      throw new BadGatewayException('Scan MCP returned no text content');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private parseResponse(raw: string): McpResponse {
    const dataLine = raw.split('\n').find((line) => line.startsWith('data:'));
    const json = dataLine ? dataLine.slice(5).trim() : raw;
    try {
      return JSON.parse(json) as McpResponse;
    } catch {
      throw new BadGatewayException('Scan MCP returned an invalid response');
    }
  }
}
