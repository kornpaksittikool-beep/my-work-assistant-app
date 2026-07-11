import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  AssistantTask,
  ChatMessage,
  MessageRole,
  TaskStatus,
} from './task.types';

@Injectable()
export class TasksRepository {
  private readonly tasks = new Map<string, AssistantTask>();

  create(title: string, workspacePath: string): AssistantTask {
    const now = new Date().toISOString();
    const task: AssistantTask = {
      id: randomUUID(),
      title,
      workspacePath,
      status: 'idle',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  findAll(): AssistantTask[] {
    return [...this.tasks.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  findOne(id: string): AssistantTask {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundException(`Task not found: ${id}`);
    return task;
  }

  addMessage(
    taskId: string,
    role: MessageRole,
    content: string,
    toolName?: string,
  ): ChatMessage {
    const task = this.findOne(taskId);
    const message: ChatMessage = {
      id: randomUUID(),
      role,
      content,
      toolName,
      createdAt: new Date().toISOString(),
    };
    task.messages.push(message);
    task.updatedAt = message.createdAt;
    return message;
  }

  setStatus(taskId: string, status: TaskStatus): AssistantTask {
    const task = this.findOne(taskId);
    task.status = status;
    task.updatedAt = new Date().toISOString();
    return task;
  }
}
