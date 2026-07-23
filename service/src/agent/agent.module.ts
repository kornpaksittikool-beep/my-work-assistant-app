import { Module } from '@nestjs/common';
import { McpModule } from '../mcp/mcp.module';
import { MemoryModule } from '../memory/memory.module';
import { OllamaModule } from '../ollama/ollama.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { AgentService } from './agent.service';
import { TaskEventsService } from '../tasks/task-events.service';
import { TasksRepository } from '../tasks/tasks.repository';

@Module({
  imports: [OllamaModule, McpModule, PermissionsModule, MemoryModule],
  providers: [AgentService, TasksRepository, TaskEventsService],
  exports: [AgentService, TasksRepository, TaskEventsService],
})
export class AgentModule {}
