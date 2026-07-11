import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { TasksController } from './tasks.controller';

@Module({ imports: [AgentModule], controllers: [TasksController] })
export class TasksModule {}
