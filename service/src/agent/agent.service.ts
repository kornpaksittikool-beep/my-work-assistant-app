import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { posix, win32 } from 'path';
import { McpClientService, SearchFilesArgs } from '../mcp/mcp-client.service';
import { OllamaChatMessage } from '../ollama/ollama.types';
import { OllamaService } from '../ollama/ollama.service';
import { PermissionsService } from '../permissions/permissions.service';
import { TaskEventsService } from '../tasks/task-events.service';
import { TasksRepository } from '../tasks/tasks.repository';

type ToolName = 'scan_directory' | 'search_files';

/** Display path shown in the permission prompt when search_files omits `root` and therefore spans every SCAN_ALLOWED_ROOTS entry at once. */
export const SEARCH_EVERYWHERE_LABEL =
  'ทุกตำแหน่งที่อนุญาตในเครื่องนี้ (ทุก root ที่ตั้งค่าไว้)';

/**
 * Discriminated on toolName so executeTool() can narrow toolArgs to the right
 * shape without a cast. Written as an explicit union rather than derived via
 * `Omit<..., keyof Base>` — Omit isn't distributive over a union type, so
 * deriving it that way would decouple toolName from toolArgs (e.g. allow
 * `{ toolName: 'scan_directory', toolArgs: SearchFilesArgs }`) instead of
 * preserving the pairing.
 */
type PendingToolRun =
  | {
      taskId: string;
      toolName: 'scan_directory';
      toolArgs: { path: string };
      displayPath: string;
      messages: OllamaChatMessage[];
      stepNumber: number;
    }
  | {
      taskId: string;
      toolName: 'search_files';
      toolArgs: SearchFilesArgs;
      displayPath: string;
      messages: OllamaChatMessage[];
      stepNumber: number;
    };

type ResolvedTarget =
  | {
      toolName: 'scan_directory';
      toolArgs: { path: string };
      displayPath: string;
      requiresPermission: boolean;
    }
  | {
      toolName: 'search_files';
      toolArgs: SearchFilesArgs;
      displayPath: string;
      requiresPermission: boolean;
    };

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
    void this.executeTool(pending).catch((error: unknown) =>
      this.fail(permission.taskId, error),
    );
  }

  private async run(taskId: string): Promise<void> {
    const task = this.tasks.findOne(taskId);
    const messages: OllamaChatMessage[] = [
      {
        role: 'system',
        content: `You are a local AI assistant. The active workspace is ${task.workspacePath}. Use scan_directory to list the contents of a folder you already know the path to. Use search_files instead when the user is looking for a file or folder but doesn't know exactly where it is — it recurses through subfolders, and omitting its "root" argument searches every allowed location on this machine at once rather than just the active workspace. Pass every alternative search word as a separate item in search_files.queries; the tool matches them with OR in one directory walk. Both tools also work on absolute paths outside the active workspace, including other drive letters (e.g. G:\\) — call them directly with that path/root instead of assuming it's a typo; the system will automatically ask the user for permission whenever a tool call reaches outside the active workspace, or whenever search_files searches everywhere. Never invent tool results. Respond in the user's language.`,
      },
      ...task.messages
        .filter((message) => message.role !== 'tool')
        .map((message) => ({
          role: message.role as 'user' | 'assistant',
          content: message.content,
        })),
    ];
    await this.step(taskId, messages, 1);
  }

  private async step(
    taskId: string,
    messages: OllamaChatMessage[],
    stepNumber: number,
  ): Promise<void> {
    const task = this.tasks.findOne(taskId);
    if (task.status === 'stopped') return;

    const result = await this.ollama.chat(messages, (delta) =>
      this.events.emit(taskId, 'message_delta', { delta }),
    );
    const call = result.toolCalls.find(
      (item) =>
        item.function.name === 'scan_directory' ||
        item.function.name === 'search_files',
    );

    if (!call) {
      this.complete(taskId, result.content || 'ดำเนินการเสร็จแล้ว', stepNumber);
      return;
    }

    if (stepNumber >= this.maxSteps) {
      this.complete(
        taskId,
        result.content ||
          'ถึงจำนวนขั้นตอนสูงสุดที่กำหนดไว้แล้ว ไม่สามารถดำเนินการต่อได้',
        stepNumber,
      );
      return;
    }

    const toolName = call.function.name as ToolName;
    const { requiresPermission, ...target } = this.resolveTarget(
      toolName,
      call.function.arguments,
      task.workspacePath,
    );
    const pending: PendingToolRun = {
      taskId,
      messages,
      stepNumber,
      ...target,
    };

    if (requiresPermission) {
      const permission = this.permissions.create(taskId, pending.displayPath);
      this.pendingRuns.set(permission.id, pending);
      this.tasks.setStatus(taskId, 'waiting_permission');
      this.events.emit(taskId, 'permission_required', { permission });
      return;
    }

    await this.executeTool(pending);
  }

  private resolveTarget(
    toolName: ToolName,
    rawArgs: Record<string, unknown>,
    workspacePath: string,
  ): ResolvedTarget {
    if (toolName === 'scan_directory') {
      const path =
        typeof rawArgs.path === 'string' ? rawArgs.path : workspacePath;
      return {
        toolName: 'scan_directory',
        toolArgs: { path },
        displayPath: path,
        requiresPermission: !this.isWithin(path, workspacePath),
      };
    }

    const root = typeof rawArgs.root === 'string' ? rawArgs.root : undefined;
    const toolArgs: SearchFilesArgs = {
      queries: Array.isArray(rawArgs.queries)
        ? rawArgs.queries.filter(
            (query): query is string =>
              typeof query === 'string' && query.length > 0,
          )
        : [],
      root,
      maxResults:
        typeof rawArgs.maxResults === 'number' ? rawArgs.maxResults : undefined,
      maxDepth:
        typeof rawArgs.maxDepth === 'number' ? rawArgs.maxDepth : undefined,
    };

    if (root === undefined) {
      return {
        toolName: 'search_files',
        toolArgs,
        displayPath: SEARCH_EVERYWHERE_LABEL,
        requiresPermission: true,
      };
    }
    return {
      toolName: 'search_files',
      toolArgs,
      displayPath: root,
      requiresPermission: !this.isWithin(root, workspacePath),
    };
  }

  private async executeTool(pending: PendingToolRun): Promise<void> {
    const task = this.tasks.findOne(pending.taskId);
    if (task.status === 'stopped') return;
    this.events.emit(task.id, 'tool_started', {
      tool: pending.toolName,
      path: pending.displayPath,
    });
    const result =
      pending.toolName === 'scan_directory'
        ? await this.mcp.scanDirectory(pending.toolArgs.path)
        : await this.mcp.searchFiles(pending.toolArgs);
    const toolContent = JSON.stringify(result);
    this.tasks.addMessage(task.id, 'tool', toolContent, pending.toolName);
    this.events.emit(task.id, 'tool_completed', {
      tool: pending.toolName,
      path: pending.displayPath,
      result,
    });
    const nextMessages: OllamaChatMessage[] = [
      ...pending.messages,
      { role: 'tool', tool_name: pending.toolName, content: toolContent },
    ];
    await this.step(task.id, nextMessages, pending.stepNumber + 1);
  }

  private complete(taskId: string, content: string, stepsUsed: number): void {
    const message = this.tasks.addMessage(taskId, 'assistant', content);
    this.tasks.setStatus(taskId, 'completed');
    this.events.emit(taskId, 'message', { message });
    this.events.emit(taskId, 'completed', {
      status: 'completed',
      stepsUsed,
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
