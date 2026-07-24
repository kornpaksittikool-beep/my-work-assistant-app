import { BadGatewayException, HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ScanRoot, ScanRootBrowseResult } from '@assistant-app/contracts';

interface ErrorEnvelope {
  message?: string[];
  error?: string;
}

/**
 * Thin REST client to 1-scan-file's /api/roots endpoints. Deliberately
 * separate from McpClientService: MCP tools are for the LLM to call as part
 * of a chat/agent turn, this is a direct user settings action (add/remove/
 * list scan roots) that never goes through the model.
 */
@Injectable()
export class ScanConfigClientService {
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.baseUrl =
      config.get<string>('SCAN_REST_URL') ?? 'http://localhost:3201/api';
  }

  listRoots(): Promise<ScanRoot[]> {
    return this.request<{ roots: ScanRoot[] }>('GET', '/roots').then(
      (body) => body.roots,
    );
  }

  browse(path?: string): Promise<ScanRootBrowseResult> {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.request<ScanRootBrowseResult>('GET', `/roots/browse${query}`);
  }

  addRoot(path: string): Promise<ScanRoot> {
    return this.request<ScanRoot>('POST', '/roots', { path });
  }

  removeRoot(path: string): Promise<ScanRoot[]> {
    return this.request<{ roots: ScanRoot[] }>('DELETE', '/roots', {
      path,
    }).then((body) => body.roots);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new BadGatewayException(
        `Cannot connect to Scan service: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new BadGatewayException(
        'Scan service returned an invalid response',
      );
    }

    if (!response.ok) {
      const errorBody = parsed as ErrorEnvelope;
      throw new HttpException(
        errorBody.message?.join(', ') ??
          errorBody.error ??
          'Scan service request failed',
        response.status,
      );
    }

    return (parsed as { data: T }).data;
  }
}
