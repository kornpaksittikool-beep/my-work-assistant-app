import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { posix, win32 } from 'path';
import { McpClientService, SearchFilesArgs } from '../mcp/mcp-client.service';
import { OllamaChatMessage } from '../ollama/ollama.types';
import { OllamaService } from '../ollama/ollama.service';
import { PermissionsService } from '../permissions/permissions.service';
import { TaskEventsService } from '../tasks/task-events.service';
import { TasksRepository } from '../tasks/tasks.repository';
import { ToolActivityEntry } from '../tasks/task.types';

type ToolName = 'scan_directory' | 'search_files';

/** Display path shown in the permission prompt when search_files omits `root` and therefore spans every SCAN_ALLOWED_ROOTS entry at once. */
export const SEARCH_EVERYWHERE_LABEL =
  'ทุกตำแหน่งที่อนุญาตในเครื่องนี้ (ทุก root ที่ตั้งค่าไว้)';

/**
 * Windows special folders are always named in English on disk regardless of
 * OS display language, but users naturally ask for them by their Thai name.
 * search_files only does literal substring matching (see McpClientService),
 * so a Thai-only query can never match "Downloads" etc. The system prompt
 * also asks the model to add the English name itself, but a small local
 * model doesn't reliably follow that every time - this table guarantees it
 * regardless of what the model actually sent.
 */
const SPECIAL_FOLDER_TRANSLATIONS: Record<string, string> = {
  ดาวน์โหลด: 'Downloads',
  ดาวโหลด: 'Downloads',
  เอกสาร: 'Documents',
  รูปภาพ: 'Pictures',
  รูป: 'Pictures',
  เดสก์ท็อป: 'Desktop',
  หน้าจอ: 'Desktop',
  เพลง: 'Music',
  วิดีโอ: 'Videos',
  คลิป: 'Videos',
};

/**
 * Rolling-window buckets exposed to the model as search_files.modifiedRange
 * (see OllamaService.searchFilesTool). A small local model is bad at doing
 * date arithmetic itself, so it only ever has to pick the closest-fitting
 * category — the exact ISO boundary is always computed here in code from the
 * real current time, never trusted from the model.
 */
const MODIFIED_RANGE_DAYS: Record<string, number> = {
  today: 1,
  yesterday: 2,
  last_7_days: 7,
  last_30_days: 30,
  last_90_days: 90,
};

/** Every recognized name/nickname (Thai or English) for a special folder, used to detect a match regardless of whether expansion actually needed to add anything. */
const SPECIAL_FOLDER_NAMES = new Set([
  ...Object.keys(SPECIAL_FOLDER_TRANSLATIONS),
  ...Object.values(SPECIAL_FOLDER_TRANSLATIONS),
]);

/**
 * Absolute path for each special folder on this machine, computed from the
 * real home directory (not a hardcoded username) so the prompt can just tell
 * the model exactly where to scan_directory rather than have it fall back to
 * search_files - a name search never returns the folder itself as a result
 * (only things found inside it), so it can't answer "what's in Downloads"
 * even once the query/root fixes above make it search the right place.
 */
const SPECIAL_FOLDER_PATHS: Record<string, string> = {
  Downloads: `${homedir()}\\Downloads`,
  Documents: `${homedir()}\\Documents`,
  Pictures: `${homedir()}\\Pictures`,
  Desktop: `${homedir()}\\Desktop`,
  Music: `${homedir()}\\Music`,
  Videos: `${homedir()}\\Videos`,
};

/** "ดาวน์โหลด/ดาวโหลด (Downloads) = C:\Users\me\Downloads, ..." - spelled out for the system prompt so the model can call scan_directory with the exact path instead of guessing or falling back to search_files (which can't return the folder itself, only things found inside it). */
const SPECIAL_FOLDER_PROMPT_SEGMENT = [
  ['ดาวน์โหลด/ดาวโหลด', 'Downloads'],
  ['เอกสาร', 'Documents'],
  ['รูปภาพ/รูป', 'Pictures'],
  ['เดสก์ท็อป/หน้าจอ', 'Desktop'],
  ['เพลง', 'Music'],
  ['วิดีโอ/คลิป', 'Videos'],
]
  .map(([thai, en]) => `${thai} (${en}) = ${SPECIAL_FOLDER_PATHS[en]}`)
  .join(', ');

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
  /** Tool calls/permission decisions for the run currently in progress on a
   * task, keyed by taskId. Collected here (rather than read back off SSE
   * events) so complete() can attach the full log to the final assistant
   * message for the history to keep showing after the run ends. */
  private readonly toolActivity = new Map<string, ToolActivityEntry[]>();
  private readonly maxSteps: number;
  private readonly filesApiBaseUrl: string;

  constructor(
    private readonly tasks: TasksRepository,
    private readonly events: TaskEventsService,
    private readonly ollama: OllamaService,
    private readonly mcp: McpClientService,
    private readonly permissions: PermissionsService,
    config: ConfigService,
  ) {
    this.maxSteps = config.get<number>('AGENT_MAX_STEPS') ?? 5;
    const port = config.get<number>('PORT') ?? 3200;
    this.filesApiBaseUrl = `http://localhost:${port}/api/files`;
  }

  start(taskId: string, content: string): void {
    this.tasks.addMessage(taskId, 'user', content);
    this.tasks.setStatus(taskId, 'working');
    this.toolActivity.set(taskId, []);
    this.events.emit(taskId, 'status', {
      status: 'working',
      text: 'กำลังวิเคราะห์คำขอ',
    });
    void this.run(taskId).catch((error: unknown) => this.fail(taskId, error));
  }

  stop(taskId: string): void {
    this.toolActivity.delete(taskId);
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
      this.recordActivity(permission.taskId, 'ปฏิเสธการเข้าถึง', 'เสร็จสิ้น');
      this.tasks.setStatus(permission.taskId, 'stopped');
      this.events.emit(permission.taskId, 'status', {
        status: 'stopped',
        text: 'ผู้ใช้ไม่อนุญาตการเข้าถึง',
      });
      return;
    }
    this.recordActivity(permission.taskId, 'อนุญาตการอ่านแล้ว', 'เสร็จสิ้น');
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
        content: `You are a local AI assistant. The active workspace is ${task.workspacePath}. Use scan_directory to list the contents of a folder you already know the path to. Use search_files instead when the user is looking for a file or folder but doesn't know exactly where it is — it recurses through subfolders, and omitting its "root" argument searches every allowed location on this machine at once rather than just the active workspace. Pass every alternative search word as a separate item in search_files.queries; the tool matches them with OR in one directory walk, and each query is matched as a literal substring of the file/folder name — it does not read file contents and does not stem or segment words. For Thai queries especially, don't only pass the exact compound phrase the user typed (e.g. "หนี้สิน"): also include its shorter root words and common synonyms as separate items (e.g. "หนี้", "สิน", "เงินกู้", "สินเชื่อ") since real filenames may combine the root with a different word (e.g. "หนี้บ้าน") rather than using the user's exact phrase. When the user asks about files by time (e.g. "อาทิตย์ที่แล้ว"/last week, "เดือนที่แล้ว"/last month, "เมื่อวาน"/yesterday, "วันนี้"/today), set search_files.modifiedRange to the closest bucket (today, yesterday, last_7_days, last_30_days, or last_90_days) instead of trying to compute exact dates yourself — you don't reliably know today's date or do date arithmetic, the bucket boundaries are computed for you. Combine modifiedRange with queries to filter a name search by time, or give modifiedRange alone (omitting queries) to list everything changed in that window regardless of name. This machine's Windows special folders are at these exact fixed paths, listed as Thai name(s) (English name) = path: ${SPECIAL_FOLDER_PROMPT_SEGMENT}. When the user wants to see what is inside one of these (e.g. "ดูในดาวน์โหลดมีอะไรบ้าง"), call scan_directory directly with that exact path — never guess a different path for it (e.g. assuming it sits inside the active workspace), and don't use search_files for this, since search_files only returns items found *inside* the folders it walks and can never return one of the walked folders itself, so it can't answer "what's in Downloads" even when scoped correctly. Only use search_files with one of these folders when the user is looking for a specific file that might be inside it by name; in that case still pass both the Thai term and the real English folder name as separate query items (e.g. queries: ["ดาวโหลด", "Downloads"]) and omit "root" so it searches every allowed location — the folder on disk is always named in English regardless of the OS display language, so a Thai-only query would never match it since matching is a literal substring, not a translation. Both tools also work on absolute paths outside the active workspace, including other drive letters (e.g. G:\\) — call them directly with that path/root instead of assuming it's a typo; the system will automatically ask the user for permission whenever a tool call reaches outside the active workspace, or whenever search_files searches everywhere. Never invent tool results — call search_files or scan_directory again for every new file/folder topic the user asks about, even within the same conversation, rather than answering from a previous search's result. When the user asks about a different file or topic than their last search, start a fresh search_files call with new queries and omit "root" again (search everywhere) — do not reuse or narrow to the folder where the previous search found something unless the user explicitly says to look in that same folder. Keep replies short and to the point — a sentence or two, not a bulleted list of options. If you're missing information, ask one focused question instead of several. Respond in the user's language.`,
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
      const content = this.linkifyFilePaths(
        result.content || 'ดำเนินการเสร็จแล้ว',
        messages,
      );
      this.complete(taskId, content, stepNumber);
      return;
    }

    if (stepNumber >= this.maxSteps) {
      const content = this.linkifyFilePaths(
        result.content ||
          'ถึงจำนวนขั้นตอนสูงสุดที่กำหนดไว้แล้ว ไม่สามารถดำเนินการต่อได้',
        messages,
      );
      this.complete(taskId, content, stepNumber);
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

    const rawQueries = Array.isArray(rawArgs.queries)
      ? rawArgs.queries.filter(
          (query): query is string =>
            typeof query === 'string' && query.length > 0,
        )
      : [];
    const modifiedAfter = this.resolveModifiedAfter(rawArgs.modifiedRange);
    // The model occasionally puts a special folder's name in `queries`
    // itself (e.g. queries: ["ดาวโหลด"]) rather than using it to say WHERE
    // to look. Once other real search terms remain, or a date filter is
    // given, that's really "look inside this specific folder" - scope root
    // to its real path and drop the folder name from queries so it isn't
    // also treated as a filename substring to match (which can't ever
    // return the folder's own contents, only oddly-named things elsewhere).
    const remainingQueries = rawQueries.filter(
      (query) => !SPECIAL_FOLDER_NAMES.has(query.trim()),
    );
    const matchedFolderPath = rawQueries
      .map((query) => this.resolveSpecialFolderPath(query))
      .find((path): path is string => path !== undefined);
    const scopeIntoSpecialFolder =
      matchedFolderPath !== undefined &&
      (remainingQueries.length > 0 || modifiedAfter !== undefined);

    let queries: string[];
    let root: string | undefined;
    if (scopeIntoSpecialFolder) {
      queries = remainingQueries;
      root = matchedFolderPath;
    } else {
      // No usable scope from a special folder (either none was mentioned,
      // or it was the *only* thing given with no date filter either, in
      // which case it's a genuine "find something named this" search) - so
      // expand any special-folder name for the plain OR-substring search
      // and, if one was matched, ignore whatever root the model gave (a
      // special folder is never inside the active workspace, and the model
      // frequently guesses wrong, e.g. the workspace itself) and search
      // every allowed root instead of leaving that choice to the model.
      queries = this.expandSpecialFolderQueries(rawQueries);
      const matchedSpecialFolder = rawQueries.some((query) =>
        SPECIAL_FOLDER_NAMES.has(query.trim()),
      );
      // The model also occasionally passes a bare word (e.g. "Downloads")
      // as root instead of omitting it, meaning "search everywhere for
      // this name" - that isn't a real path and would just hard-fail
      // search_files downstream, so treat anything that isn't actually
      // absolute as if root were omitted rather than passing it through.
      const rawRoot =
        typeof rawArgs.root === 'string' ? rawArgs.root : undefined;
      root = matchedSpecialFolder
        ? undefined
        : rawRoot && (win32.isAbsolute(rawRoot) || posix.isAbsolute(rawRoot))
          ? rawRoot
          : undefined;
    }
    const rawMaxResults =
      typeof rawArgs.maxResults === 'number' ? rawArgs.maxResults : undefined;
    // A name-less "list everything changed recently" search can easily hit
    // the (much larger) default maxResults from the search tool itself,
    // handing the model a wall of JSON it then has to summarize - a small
    // model reliably garbles that (e.g. claims nothing was found even when
    // the tool result clearly lists matches). Keep the default list short
    // enough to actually summarize correctly, unless the model asked for a
    // specific size itself.
    const maxResults =
      rawMaxResults ??
      (queries.length === 0 && modifiedAfter ? 20 : undefined);
    const toolArgs: SearchFilesArgs = {
      queries,
      root,
      maxResults,
      maxDepth:
        typeof rawArgs.maxDepth === 'number' ? rawArgs.maxDepth : undefined,
      modifiedAfter,
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
    this.recordActivity(task.id, `${pending.toolName} เสร็จแล้ว`, 'เสร็จสิ้น');
    const nextMessages: OllamaChatMessage[] = [
      ...pending.messages,
      { role: 'tool', tool_name: pending.toolName, content: toolContent },
    ];
    await this.step(task.id, nextMessages, pending.stepNumber + 1);
  }

  private complete(taskId: string, content: string, stepsUsed: number): void {
    const toolCalls = this.toolActivity.get(taskId);
    this.toolActivity.delete(taskId);
    const message = this.tasks.addMessage(
      taskId,
      'assistant',
      content,
      undefined,
      toolCalls?.length ? toolCalls : undefined,
    );
    this.tasks.setStatus(taskId, 'completed');
    this.events.emit(taskId, 'message', { message });
    this.events.emit(taskId, 'completed', {
      status: 'completed',
      stepsUsed,
    });
  }

  private fail(taskId: string, error: unknown): void {
    this.toolActivity.delete(taskId);
    this.tasks.setStatus(taskId, 'failed');
    this.events.emit(taskId, 'error', {
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private recordActivity(taskId: string, label: string, detail: string): void {
    const list = this.toolActivity.get(taskId) ?? [];
    list.push({ id: randomUUID(), label, detail, state: 'done' });
    this.toolActivity.set(taskId, list);
  }

  /**
   * Rewrites every occurrence of a path found in this run's tool results into
   * a Markdown link that opens it via FilesController, so the model doesn't
   * need to produce correct link/URI syntax itself for arbitrary Windows
   * paths (including Thai filenames) - only mention the same path text the
   * tool already returned.
   */
  private linkifyFilePaths(
    content: string,
    messages: OllamaChatMessage[],
  ): string {
    const files = new Map<string, string>();
    for (const message of messages) {
      if (message.role !== 'tool') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.content);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const record = parsed as Record<string, unknown>;
      const list = Array.isArray(record.entries)
        ? record.entries
        : Array.isArray(record.matches)
          ? record.matches
          : [];
      for (const item of list) {
        if (
          item &&
          typeof item === 'object' &&
          typeof (item as Record<string, unknown>).name === 'string' &&
          typeof (item as Record<string, unknown>).path === 'string'
        ) {
          const entry = item as { name: string; path: string };
          files.set(entry.path, entry.name);
        }
      }
    }

    let result = content;
    const paths = [...files.keys()].sort((a, b) => b.length - a.length);
    for (const path of paths) {
      const name = files.get(path)!.replace(/([[\]])/g, '\\$1');
      const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp('`?' + escapedPath + '`?', 'g');
      const url = `${this.filesApiBaseUrl}/open?path=${encodeURIComponent(path)}`;
      result = result.replace(pattern, `[${name}](${url})`);
    }
    return result;
  }

  private resolveModifiedAfter(modifiedRange: unknown): string | undefined {
    if (typeof modifiedRange !== 'string') return undefined;
    const days = MODIFIED_RANGE_DAYS[modifiedRange];
    if (!days) return undefined;
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }

  /** Resolves a raw query term to a special folder's real absolute path if it names one (Thai nickname or the English name itself), else undefined. */
  private resolveSpecialFolderPath(query: string): string | undefined {
    const trimmed = query.trim();
    const englishName = SPECIAL_FOLDER_TRANSLATIONS[trimmed] ?? trimmed;
    return SPECIAL_FOLDER_PATHS[englishName];
  }

  private expandSpecialFolderQueries(queries: string[]): string[] {
    const additions = queries
      .map((query) => SPECIAL_FOLDER_TRANSLATIONS[query.trim()])
      .filter(
        (translated): translated is string =>
          !!translated && !queries.includes(translated),
      );
    return additions.length
      ? [...queries, ...new Set(additions)]
      : queries;
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
