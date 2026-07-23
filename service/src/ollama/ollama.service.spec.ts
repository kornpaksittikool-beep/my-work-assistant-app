import { BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OllamaService } from './ollama.service';

function mockStreamResponse(lines: unknown[]) {
  const encoder = new TextEncoder();
  const encoded = lines.map((line) =>
    encoder.encode(`${JSON.stringify(line)}\n`),
  );
  let index = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: () => {
          if (index < encoded.length) {
            return Promise.resolve({ done: false, value: encoded[index++] });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    },
  };
}

function parseFetchBody(call: unknown[]): Record<string, unknown> {
  const body = (call[1] as RequestInit | undefined)?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(body) as Record<string, unknown>;
}

describe('OllamaService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const createService = (config: Partial<Record<string, unknown>> = {}) => {
    const configService = {
      get: (key: string) => config[key],
    } as unknown as ConfigService;
    return new OllamaService(configService);
  };

  it('uses the configured base URL and model, falling back to defaults otherwise', () => {
    expect(createService().getModel()).toBe('qwen3:4b');
    expect(createService({ OLLAMA_MODEL: 'custom-model' }).getModel()).toBe(
      'custom-model',
    );
  });

  describe('isAvailable', () => {
    it('returns true when Ollama responds ok', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true });
      const service = createService();

      await expect(service.isAvailable()).resolves.toBe(true);
    });

    it('returns false when Ollama responds with a non-ok status', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false });
      const service = createService();

      await expect(service.isAvailable()).resolves.toBe(false);
    });

    it('returns false when the request throws', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
      const service = createService();

      await expect(service.isAvailable()).resolves.toBe(false);
    });
  });

  describe('planFileSearch', () => {
    it('returns a sanitized dynamic search plan from structured JSON', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            message: {
              content: JSON.stringify({
                queries: [' finance ', 'budget', 'finance', 123],
                fuzzy: true,
              }),
            },
          }),
      });
      global.fetch = fetchMock;

      await expect(
        createService().planFileSearch('find files related to finance'),
      ).resolves.toEqual({ queries: ['finance', 'budget'], fuzzy: true });

      const body = parseFetchBody((fetchMock.mock.calls as unknown[][])[0]) as {
        stream: boolean;
        format: { type: string };
        tools?: unknown;
      };
      expect(body.stream).toBe(false);
      expect(body.format.type).toBe('object');
      expect(body.tools).toBeUndefined();
    });

    it('returns null when planning is unavailable or malformed', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ message: { content: 'not-json' } }),
        });
      const service = createService();

      await expect(service.planFileSearch('first')).resolves.toBeNull();
      await expect(service.planFileSearch('second')).resolves.toBeNull();
    });

    it('drops Thai query fragments cut at an invalid word boundary, keeping real words', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            message: {
              content: JSON.stringify({
                queries: [
                  'เวลาทำงาน',
                  'เวลาท',
                  'ํางาน',
                  'ารลงเวลา',
                  'การลงเวลา',
                ],
                fuzzy: true,
              }),
            },
          }),
      });

      await expect(
        createService().planFileSearch('หาไฟล์เกี่ยวกับการลงเวลางาน'),
      ).resolves.toEqual({
        queries: ['เวลาทำงาน', 'เวลาท', 'การลงเวลา'],
        fuzzy: true,
      });
    });
  });

  describe('extractMemories', () => {
    it('rejects a memory written in English when the user wrote Thai', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            message: {
              content: JSON.stringify({
                memories: [
                  {
                    scope: 'global',
                    text: 'User prefers testing interactions to validate system responses',
                  },
                ],
              }),
            },
          }),
      });

      await expect(
        createService().extractMemories('ทดสอบสิ', 'ok', null),
      ).resolves.toEqual([]);
    });

    it('keeps a memory written in Thai when the user wrote Thai', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            message: {
              content: JSON.stringify({
                memories: [{ scope: 'global', text: 'ชอบคำตอบสั้นกระชับ' }],
              }),
            },
          }),
      });

      await expect(
        createService().extractMemories('ตอบสั้นๆหน่อยนะ', 'ok', null),
      ).resolves.toEqual([{ scope: 'global', text: 'ชอบคำตอบสั้นกระชับ' }]);
    });

    it('keeps an English memory when the user wrote in English', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            message: {
              content: JSON.stringify({
                memories: [
                  { scope: 'global', text: 'Prefers concise answers' },
                ],
              }),
            },
          }),
      });

      await expect(
        createService().extractMemories(
          'Keep answers short please',
          'ok',
          null,
        ),
      ).resolves.toEqual([
        { scope: 'global', text: 'Prefers concise answers' },
      ]);
    });
  });

  describe('chat', () => {
    it('returns content and tool calls from a successful response', async () => {
      global.fetch = jest.fn().mockResolvedValue(
        mockStreamResponse([
          { message: { content: 'Hel' } },
          {
            message: {
              content: 'lo',
              tool_calls: [
                { function: { name: 'scan_directory', arguments: {} } },
              ],
            },
          },
        ]),
      );
      const service = createService();
      const deltas: string[] = [];

      const result = await service.chat(
        [{ role: 'user', content: 'hi' }],
        (delta) => deltas.push(delta),
      );

      expect(result).toEqual({
        content: 'Hello',
        toolCalls: [{ function: { name: 'scan_directory', arguments: {} } }],
      });
      expect(deltas).toEqual(['Hel', 'lo']);
    });

    it('sends num_ctx 8192 by default, and the configured value when OLLAMA_NUM_CTX is set', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          mockStreamResponse([{ message: { content: 'ok' } }]),
        )
        .mockResolvedValueOnce(
          mockStreamResponse([{ message: { content: 'ok' } }]),
        );
      global.fetch = fetchMock;

      await createService().chat([{ role: 'user', content: 'hi' }]);
      const calls = fetchMock.mock.calls as unknown[][];
      let body = parseFetchBody(calls[0]) as {
        options: { num_ctx: number };
      };
      expect(body.options).toEqual({ num_ctx: 8192 });

      await createService({ OLLAMA_NUM_CTX: 16384 }).chat([
        { role: 'user', content: 'hi' },
      ]);
      body = parseFetchBody(calls[1]) as {
        options: { num_ctx: number };
      };
      expect(body.options).toEqual({ num_ctx: 16384 });
    });

    it('defaults content and toolCalls when the message omits them', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(mockStreamResponse([{ message: {} }]));
      const service = createService();

      const result = await service.chat([{ role: 'user', content: 'hi' }]);

      expect(result).toEqual({ content: '', toolCalls: [] });
    });

    it('throws BadGatewayException when the request itself fails', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const service = createService();

      await expect(service.chat([])).rejects.toThrow(BadGatewayException);
    });

    it('stringifies a non-Error thrown value in the connection failure message', async () => {
      global.fetch = jest.fn().mockRejectedValue('ECONNREFUSED');
      const service = createService();

      await expect(service.chat([])).rejects.toThrow(
        'Cannot connect to Ollama: ECONNREFUSED',
      );
    });

    it('throws BadGatewayException on a non-ok HTTP status, including the response body in the message', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('model not found'),
      });
      const service = createService();

      await expect(service.chat([])).rejects.toThrow(
        'Ollama returned HTTP 500: model not found',
      );
    });

    it('omits the trailing colon when the error response has no body', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve(''),
      });
      const service = createService();

      await expect(service.chat([])).rejects.toThrow(
        'Ollama returned HTTP 500',
      );
    });

    it('handles a failed attempt to read the HTTP error body', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: () => Promise.reject(new Error('body unavailable')),
      });
      const service = createService();

      await expect(service.chat([])).rejects.toThrow(
        'Ollama returned HTTP 502',
      );
    });

    it('throws BadGatewayException when the response body is missing', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, body: null });
      const service = createService();

      await expect(service.chat([])).rejects.toThrow(BadGatewayException);
    });

    it('throws BadGatewayException when the stream yields no chunks', async () => {
      global.fetch = jest.fn().mockResolvedValue(mockStreamResponse([]));
      const service = createService();

      await expect(service.chat([])).rejects.toThrow(BadGatewayException);
    });
  });
});
