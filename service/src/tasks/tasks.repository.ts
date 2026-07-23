import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import type {
  AssistantTask,
  ChatMessage,
  MessageRole,
  TaskStatus,
  ToolActivityEntry,
} from '@assistant-app/contracts';

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
      let raw: string;
      try {
        raw = readFileSync(this.dataFile, 'utf8');
        JSON.parse(raw);
      } catch {
        raw = readFileSync(`${this.dataFile}.bak`, 'utf8');
      }
      const tasks = JSON.parse(raw) as AssistantTask[];
      let recoveredTransientTask = false;
      for (const task of tasks) {
        // Agent runs and permission requests intentionally live in memory.
        // They cannot resume after a service restart, so do not leave their
        // persisted task shells stuck forever in a state with no live run.
        if (task.status === 'working' || task.status === 'waiting_permission') {
          task.status = 'stopped';
          task.updatedAt = new Date().toISOString();
          recoveredTransientTask = true;
        }
        this.tasks.set(task.id, task);
      }
      if (recoveredTransientTask) this.persist();
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
    return [...this.tasks.values()]
      .filter((task) => !task.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  update(
    id: string,
    changes: { title?: string; archived?: boolean },
  ): AssistantTask {
    const task = this.findOne(id);
    if (changes.title !== undefined) task.title = changes.title.trim();
    if (changes.archived !== undefined) task.archived = changes.archived;
    task.updatedAt = new Date().toISOString();
    this.persist();
    return task;
  }

  remove(id: string): AssistantTask {
    const task = this.findOne(id);
    this.tasks.delete(id);
    this.persist();
    return task;
  }

  removeAll(): void {
    this.tasks.clear();
    this.persist();
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
    if (
      role === 'user' &&
      task.messages.length === 0 &&
      task.title.trim() === 'งานใหม่'
    ) {
      task.title = this.titleFromFirstMessage(content);
    }
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

  private titleFromFirstMessage(content: string): string {
    const normalized = content.replace(/\s+/g, ' ').trim();
    const maxLength = 52;
    return normalized.length > maxLength
      ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
      : normalized || 'งานใหม่';
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
    const temporaryFile = `${this.dataFile}.tmp`;
    const backupFile = `${this.dataFile}.bak`;
    writeFileSync(temporaryFile, JSON.stringify([...this.tasks.values()]));
    if (existsSync(this.dataFile)) copyFileSync(this.dataFile, backupFile);
    try {
      renameSync(temporaryFile, this.dataFile);
    } catch {
      // Windows may refuse replacing an existing destination. The backup is
      // already durable, so use a short remove+rename fallback.
      rmSync(this.dataFile, { force: true });
      renameSync(temporaryFile, this.dataFile);
    }
  }
}
