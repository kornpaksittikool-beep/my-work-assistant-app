import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { posix, win32 } from 'path';
import { McpClientService } from '../mcp/mcp-client.service';
import { OllamaChatMessage } from '../ollama/ollama.types';
import { OllamaService } from '../ollama/ollama.service';
import { PermissionsService } from '../permissions/permissions.service';
import { TaskEventsService } from '../tasks/task-events.service';
import { TasksRepository } from '../tasks/tasks.repository';

interface PendingToolRun {
  taskId: string;
  path: string;
  messages: OllamaChatMessage[];
}

@Injectable()
export class AgentService {
  private readonly pendingRuns = new Map<string, PendingToolRun>();
  private readonly maxSteps: number;

  constructor(
    private readonly tasks: TasksRepository,
    private readonly events: TaskEventsService,
    private readonly ollama: OllamaService,
    private readonly mcp: McpClientService,
    private readonly permissions: PermissionsService,
    config: ConfigService,
  ) {
    this.maxSteps = config.get<number>('AGENT_MAX_STEPS') ?? 5;
  }

  start(taskId: string, content: string): void {
    this.tasks.addMessage(taskId, 'user', content);
    this.tasks.setStatus(taskId, 'working');
    this.events.emit(taskId, 'status', {
      status: 'working',
      text: 'กำลังวิเคราะห์คำขอ',
    });
    void this.run(taskId).catch((error: unknown) => this.fail(taskId, error));
  }

  stop(taskId: string): void {
    this.tasks.setStatus(taskId, 'stopped');
    this.events.emit(taskId, 'status', {
      status: 'stopped',
      text: 'หยุดงานแล้ว',
    });
  }

  resolvePermission(
    taskId: string,
    permissionId: string,
    allowed: boolean,
  ): void {
    const existingPermission = this.permissions.findOne(permissionId);
    if (existingPermission.taskId !== taskId) {
      throw new BadRequestException(
        'Permission request does not belong to this task',
      );
    }
    const permission = this.permissions.resolve(permissionId, allowed);
    const pending = this.pendingRuns.get(permissionId);
    this.pendingRuns.delete(permissionId);
    if (!pending) return;
    if (!allowed) {
      this.tasks.setStatus(permission.taskId, 'stopped');
      this.events.emit(permission.taskId, 'status', {
        status: 'stopped',
        text: 'ผู้ใช้ไม่อนุญาตการเข้าถึง',
      });
      return;
    }
    this.tasks.setStatus(permission.taskId, 'working');
    void this.executeScan(pending).catch((error: unknown) =>
      this.fail(permission.taskId, error),
    );
  }

  private async run(taskId: string): Promise<void> {
    const task = this.tasks.findOne(taskId);
    const messages: OllamaChatMessage[] = [
      {
        role: 'system',
        content: `You are a local AI assistant. The active workspace is ${task.workspacePath}. Use scan_directory when file listing is needed. Never invent tool results. Respond in the user's language.`,
      },
      ...task.messages
        .filter((message) => message.role !== 'tool')
        .map((message) => ({
          role: message.role as 'user' | 'assistant',
          content: message.content,
        })),
    ];
    const result = await this.ollama.chat(messages);
    const call = result.toolCalls.find(
      (item) => item.function.name === 'scan_directory',
    );
    if (!call) {
      this.complete(taskId, result.content);
      return;
    }
    const path = String(call.function.arguments.path ?? task.workspacePath);
    if (!this.isWithin(path, task.workspacePath)) {
      const permission = this.permissions.create(taskId, path);
      this.pendingRuns.set(permission.id, { taskId, path, messages });
      this.tasks.setStatus(taskId, 'waiting_permission');
      this.events.emit(taskId, 'permission_required', { permission });
      return;
    }
    await this.executeScan({ taskId, path, messages });
  }

  private async executeScan(pending: PendingToolRun): Promise<void> {
    const task = this.tasks.findOne(pending.taskId);
    if (task.status === 'stopped') return;
    this.events.emit(task.id, 'tool_started', {
      tool: 'scan_directory',
      path: pending.path,
    });
    const result = await this.mcp.scanDirectory(pending.path);
    const toolContent = JSON.stringify(result);
    this.tasks.addMessage(task.id, 'tool', toolContent, 'scan_directory');
    this.events.emit(task.id, 'tool_completed', {
      tool: 'scan_directory',
      path: pending.path,
      result,
    });
    const followUp = await this.ollama.chat([
      ...pending.messages,
      { role: 'tool', tool_name: 'scan_directory', content: toolContent },
    ]);
    this.complete(task.id, followUp.content || 'สแกนไฟล์เสร็จแล้ว');
  }

  private complete(taskId: string, content: string): void {
    const message = this.tasks.addMessage(taskId, 'assistant', content);
    this.tasks.setStatus(taskId, 'completed');
    this.events.emit(taskId, 'message', { message });
    this.events.emit(taskId, 'completed', {
      status: 'completed',
      stepsUsed: Math.min(2, this.maxSteps),
    });
  }

  private fail(taskId: string, error: unknown): void {
    this.tasks.setStatus(taskId, 'failed');
    this.events.emit(taskId, 'error', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private isWithin(candidate: string, root: string): boolean {
    const pathApi = /^[a-zA-Z]:[\\/]/.test(root) ? win32 : posix;
    const relative = pathApi.relative(
      pathApi.resolve(root),
      pathApi.resolve(candidate),
    );
    return (
      relative === '' ||
      (!relative.startsWith('..') && !pathApi.isAbsolute(relative))
    );
  }
}
