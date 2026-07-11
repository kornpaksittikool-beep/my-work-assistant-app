import { Test } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppModule } from './app.module';
import { AppService } from './app.service';
import { OllamaService } from './ollama/ollama.service';
import { TasksController } from './tasks/tasks.controller';
import { AgentService } from './agent/agent.service';
import { TasksRepository } from './tasks/tasks.repository';
import { TaskEventsService } from './tasks/task-events.service';
import { McpClientService } from './mcp/mcp-client.service';
import { PermissionsService } from './permissions/permissions.service';

describe('AppModule', () => {
  it('wires the full dependency graph together', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef.get(AppController)).toBeInstanceOf(AppController);
    expect(moduleRef.get(AppService)).toBeInstanceOf(AppService);
    expect(moduleRef.get(OllamaService)).toBeInstanceOf(OllamaService);
    expect(moduleRef.get(TasksController)).toBeInstanceOf(TasksController);
    expect(moduleRef.get(AgentService)).toBeInstanceOf(AgentService);
    expect(moduleRef.get(TasksRepository)).toBeInstanceOf(TasksRepository);
    expect(moduleRef.get(TaskEventsService)).toBeInstanceOf(TaskEventsService);
    expect(moduleRef.get(McpClientService)).toBeInstanceOf(McpClientService);
    expect(moduleRef.get(PermissionsService)).toBeInstanceOf(
      PermissionsService,
    );

    await moduleRef.close();
  });
});
