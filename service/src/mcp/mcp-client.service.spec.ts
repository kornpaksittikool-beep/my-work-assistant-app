import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpClientService } from './mcp-client.service';

describe('McpClientService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const createService = (url?: string) => {
    const configService = {
      get: () => url,
    } as unknown as ConfigService;
    return new McpClientService(configService);
  };

  const mockFetchText = (text: string, ok = true) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      text: () => Promise.resolve(text),
    });
  };

  it('returns parsed JSON content from a plain JSON response', async () => {
    mockFetchText(
      JSON.stringify({
        result: {
          content: [{ type: 'text', text: JSON.stringify({ files: [] }) }],
        },
      }),
    );
    const service = createService();

    await expect(service.scanDirectory('D:\\my-work')).resolves.toEqual({
      files: [],
    });
  });

  it('returns raw text content when it is not valid JSON', async () => {
    mockFetchText(
      JSON.stringify({
        result: { content: [{ type: 'text', text: 'not-json' }] },
      }),
    );
    const service = createService();

    await expect(service.scanDirectory('D:\\my-work')).resolves.toBe(
      'not-json',
    );
  });

  it('parses an SSE-style "data:" line response', async () => {
    const payload = JSON.stringify({
      result: { content: [{ type: 'text', text: 'plain' }] },
    });
    mockFetchText(`event: message\ndata: ${payload}\n\n`);
    const service = createService();

    await expect(service.scanDirectory('D:\\my-work')).resolves.toBe('plain');
  });

  it('uses the configured SCAN_MCP_URL when provided', async () => {
    mockFetchText(
      JSON.stringify({ result: { content: [{ type: 'text', text: 'ok' }] } }),
    );
    const service = createService('http://scan-host:3100/mcp');

    await service.scanDirectory('D:\\my-work');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://scan-host:3100/mcp',
      expect.any(Object),
    );
  });

  it('throws BadGatewayException when the request itself fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const service = createService();

    await expect(service.scanDirectory('D:\\my-work')).rejects.toThrow(
      BadGatewayException,
    );
  });

  it('stringifies a non-Error thrown value in the connection failure message', async () => {
    global.fetch = jest.fn().mockRejectedValue('ECONNREFUSED');
    const service = createService();

    await expect(service.scanDirectory('D:\\my-work')).rejects.toThrow(
      'Cannot connect to Scan MCP: ECONNREFUSED',
    );
  });

  it('throws BadGatewayException on a non-ok HTTP status', async () => {
    mockFetchText('', false);
    const service = createService();

    await expect(service.scanDirectory('D:\\my-work')).rejects.toThrow(
      BadGatewayException,
    );
  });

  it('throws BadGatewayException when the body is not valid JSON', async () => {
    mockFetchText('not json at all');
    const service = createService();

    await expect(service.scanDirectory('D:\\my-work')).rejects.toThrow(
      BadGatewayException,
    );
  });

  it('throws BadGatewayException using the error message from the MCP response', async () => {
    mockFetchText(JSON.stringify({ error: { message: 'path not allowed' } }));
    const service = createService();

    await expect(service.scanDirectory('D:\\my-work')).rejects.toThrow(
      'path not allowed',
    );
  });

  it('throws BadGatewayException using the tool error text when isError is set', async () => {
    mockFetchText(
      JSON.stringify({
        result: { isError: true, content: [{ type: 'text', text: 'boom' }] },
      }),
    );
    const service = createService();

    await expect(service.scanDirectory('D:\\my-work')).rejects.toThrow('boom');
  });

  it('falls back to a generic message when isError is set with no content text', async () => {
    mockFetchText(JSON.stringify({ result: { isError: true, content: [] } }));
    const service = createService();

    await expect(service.scanDirectory('D:\\my-work')).rejects.toThrow(
      'Scan MCP tool failed',
    );
  });

  it('throws BadGatewayException when no text content is returned', async () => {
    mockFetchText(JSON.stringify({ result: { content: [] } }));
    const service = createService();

    await expect(service.scanDirectory('D:\\my-work')).rejects.toThrow(
      'Scan MCP returned no text content',
    );
  });
});
