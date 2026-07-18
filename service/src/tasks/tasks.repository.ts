import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  AssistantTask,
  ChatMessage,
  MessageRole,
  TaskStatus,
  ToolActivityEntry,
} from './task.types';

@Injectable()
export class TasksRepository {
  private readonly tasks = new Map<string, AssistantTask>();
  private readonly dataFile: string;

  constructor(config: ConfigService) {
    this.dataFile =
      config.get<string>('TASKS_DATA_FILE') ??
      join(process.cwd(), 'data', 'tasks.json');
    // Tasks previously lived in memory only, so every restart (hot-reload
    // during dev included) wiped every conversation - load whatever was
    // last persisted instead of always starting empty. A missing or
    // corrupt file just means "nothing to load yet", not a boot failure.
    try {
      const raw = readFileSync(this.dataFile, 'utf8');
      const tasks = JSON.parse(raw) as AssistantTask[];
      for (const task of tasks) this.tasks.set(task.id, task);
    } catch {
      // no persisted data yet (first run, or file missing/corrupt)
    }
  }

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
    this.persist();
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
    toolCalls?: ToolActivityEntry[],
  ): ChatMessage {
    const task = this.findOne(taskId);
    const message: ChatMessage = {
      id: randomUUID(),
      role,
      content,
      toolName,
      toolCalls,
      createdAt: new Date().toISOString(),
    };
    task.messages.push(message);
    task.updatedAt = message.createdAt;
    this.persist();
    return message;
  }

  setStatus(taskId: string, status: TaskStatus): AssistantTask {
    const task = this.findOne(taskId);
    task.status = status;
    task.updatedAt = new Date().toISOString();
    this.persist();
    return task;
  }

  /** Synchronous write is fine at this scale (single user, low write
   * frequency) - same tradeoff the project already makes elsewhere (see
   * `to do list/server.js`) rather than pulling in a real database for
   * what is still just "don't lose the conversation on restart". */
  private persist(): void {
    mkdirSync(dirname(this.dataFile), { recursive: true });
    writeFileSync(this.dataFile, JSON.stringify([...this.tasks.values()]));
  }
}
