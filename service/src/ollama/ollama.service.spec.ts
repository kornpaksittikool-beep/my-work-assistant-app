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
      let body = JSON.parse(fetchMock.mock.calls[0][1].body) as {
        options: { num_ctx: number };
      };
      expect(body.options).toEqual({ num_ctx: 8192 });

      await createService({ OLLAMA_NUM_CTX: 16384 }).chat([
        { role: 'user', content: 'hi' },
      ]);
      body = JSON.parse(fetchMock.mock.calls[1][1].body) as {
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

      await expect(service.chat([])).rejects.toThrow('Ollama returned HTTP 500');
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
