import { Injectable } from '@nestjs/common';
import { OllamaService } from './ollama/ollama.service';

export interface HealthStatus {
  status: 'ok';
  service: string;
  ollama: { available: boolean; model: string };
  timestamp: string;
}

@Injectable()
export class AppService {
  constructor(private readonly ollama: OllamaService) {}

  async getHealth(): Promise<HealthStatus> {
    return {
      status: 'ok',
      service: 'assistant-service',
      ollama: {
        available: await this.ollama.isAvailable(),
        model: this.ollama.getModel(),
      },
      timestamp: new Date().toISOString(),
    };
  }
}
