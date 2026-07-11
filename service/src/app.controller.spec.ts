import { Test } from '@nestjs/testing';
import { OllamaService } from './ollama/ollama.service';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  it('returns service and Ollama health', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: OllamaService,
          useValue: {
            isAvailable: () => Promise.resolve(true),
            getModel: () => 'qwen3:4b',
          },
        },
      ],
    }).compile();
    const result = await moduleRef.get(AppController).getHealth();
    expect(result).toMatchObject({
      status: 'ok',
      service: 'assistant-service',
      ollama: { available: true, model: 'qwen3:4b' },
    });
  });
});
