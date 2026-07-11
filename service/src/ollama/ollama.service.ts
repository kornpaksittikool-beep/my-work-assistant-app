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

  async chat(messages: OllamaChatMessage[]): Promise<OllamaChatResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages,
          tools: [this.scanDirectoryTool()],
        }),
      });
    } catch (error) {
      throw new BadGatewayException(
        `Cannot connect to Ollama: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok)
      throw new BadGatewayException(`Ollama returned HTTP ${response.status}`);
    const body = (await response.json()) as OllamaResponse;
    if (!body.message)
      throw new BadGatewayException('Ollama returned an invalid chat response');
    return {
      content: body.message.content ?? '',
      toolCalls: body.message.tool_calls ?? [],
    };
  }

  private scanDirectoryTool(): Record<string, unknown> {
    return {
      type: 'function',
      function: {
        name: 'scan_directory',
        description:
          'List files and folders at the top level of an allowed local directory.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string' } },
        },
      },
    };
  }
}
