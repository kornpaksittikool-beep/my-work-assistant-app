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

    it('throws BadGatewayException on a non-ok HTTP status', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
      const service = createService();

      await expect(service.chat([])).rejects.toThrow(BadGatewayException);
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
