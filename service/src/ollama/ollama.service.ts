import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OllamaChatMessage,
  OllamaChatResult,
  OllamaToolCall,
} from './ollama.types';

interface OllamaResponse {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
}

@Injectable()
export class OllamaService {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(config: ConfigService) {
    this.baseUrl =
      config.get<string>('OLLAMA_BASE_URL') ?? 'http://localhost:11434';
    this.model = config.get<string>('OLLAMA_MODEL') ?? 'qwen3:4b';
  }

  getModel(): string {
    return this.model;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async chat(
    messages: OllamaChatMessage[],
    onDelta?: (text: string) => void,
  ): Promise<OllamaChatResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model: this.model,
          stream: true,
          messages,
          tools: [this.scanDirectoryTool(), this.searchFilesTool()],
        }),
      });
    } catch (error) {
      throw new BadGatewayException(
        `Cannot connect to Ollama: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok)
      throw new BadGatewayException(`Ollama returned HTTP ${response.status}`);
    if (!response.body)
      throw new BadGatewayException('Ollama returned an empty stream');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let toolCalls: OllamaToolCall[] = [];
    let receivedChunk = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as OllamaResponse;
        receivedChunk = true;
        if (chunk.message?.content) {
          content += chunk.message.content;
          onDelta?.(chunk.message.content);
        }
        if (chunk.message?.tool_calls?.length) {
          toolCalls = chunk.message.tool_calls;
        }
      }
    }
    if (!receivedChunk)
      throw new BadGatewayException('Ollama returned an invalid chat response');
    return { content, toolCalls };
  }

  private scanDirectoryTool(): Record<string, unknown> {
    return {
      type: 'function',
      function: {
        name: 'scan_directory',
        description:
          'List files and folders at the top level of an allowed local directory. Use this to browse a folder you already know the path to.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string' } },
        },
      },
    };
  }

  private searchFilesTool(): Record<string, unknown> {
    return {
      type: 'function',
      function: {
        name: 'search_files',
        description:
          "Recursively search for a file or folder by name when you don't know exactly where it is. Omit `root` to search every allowed location on the machine at once; pass `root` to restrict the search to one location.",
        parameters: {
          type: 'object',
          required: ['queries'],
          properties: {
            queries: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 20,
              description:
                'One or more substrings to match against file/folder names (case-insensitive). A name matches when it contains ANY query (OR). Put alternative words in separate array items.',
            },
            root: {
              type: 'string',
              description:
                'Optional absolute path to restrict the search to. Omit to search every allowed root.',
            },
          },
        },
      },
    };
  }
}
