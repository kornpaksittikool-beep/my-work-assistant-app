import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Dirent, readdirSync } from 'fs';
import { homedir } from 'os';
import { posix, win32 } from 'path';
import { McpClientService, SearchFilesArgs } from '../mcp/mcp-client.service';
import { OllamaChatMessage } from '../ollama/ollama.types';
import { OllamaService } from '../ollama/ollama.service';
import { PermissionsService } from '../permissions/permissions.service';
import { TaskEventsService } from '../tasks/task-events.service';
import { TasksRepository } from '../tasks/tasks.repository';
import { ToolActivityEntry } from '../tasks/task.types';
import {
  DIRECTORY_LIST_INTENT,
  evaluateToolPolicy,
  FILE_CONTENT_UNAVAILABLE_RESPONSE,
  FILE_METADATA_POLICY_PROMPT,
  FILE_MUTATION_UNAVAILABLE_RESPONSE,
  UNVERIFIED_FILE_RESPONSE,
} from './tool-policy';
import { formatToolResultForModel } from './file-metadata-format';

type ToolName = 'scan_directory' | 'search_files' | 'read_file';

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
  yesterday: 1,
  last_7_days: 7,
  last_30_days: 30,
  last_90_days: 90,
};

/** Matches the user's own words plausibly asking about a modification-time
 * window - gates whether the model's search_files.modifiedRange choice gets
 * honored at all (see resolveTarget()), since a small model sometimes
 * attaches it to a plain name search that never mentioned time. */
const DATE_TIME_INTENT_PATTERN =
  /วันนี้|เมื่อวาน|วันที่|สัปดาห์|อาทิตย์|เดือน|(?<!\S)ปี(?!\S)|ย้อนหลัง|ล่าสุด|ช่วง(?:เวลา|นี้)|\btoday\b|\byesterday\b|\bthis week\b|\blast week\b|\bthis month\b|\blast month\b|\brecent(?:ly)?\b|\b\d+\s*(?:days?|weeks?|months?|years?)\b|\bdate\b/i;

/**
 * Default search_files maxResults on the model-facing path only, when the
 * model didn't specify one itself - the underlying SearchService default
 * (100, see 1-scan-file) is fine for a direct API caller but too large to
 * safely hand back into the model's own context window (observed directly:
 * 100 long absolute paths from one broad search blew a request out to
 * 11683 tokens against an 8192-token context, failing the turn outright).
 */
const DEFAULT_MODEL_FACING_MAX_RESULTS = 25;

/**
 * Default read_file maxBytes on the model-facing path only, when the model
 * didn't specify one itself - the underlying ReadService default (64 KB, see
 * 1-scan-file) is sized for the tool's own byte cap, not for what safely
 * fits in a small local model's context window alongside the rest of the
 * conversation (observed directly: 42 KB of extracted text alone came to
 * 20661 tokens against the 8192-token num_ctx and made Ollama reject the
 * request outright, failing the whole task; even a first attempt at 12 KB
 * still came to 8577 tokens once the ~2900-token system prompt was added,
 * still over budget). Numeric-heavy extracted content (e.g. a spreadsheet
 * dump of dates/times as raw decimals) tokenizes far more densely than
 * plain prose - roughly 0.4 tokens/byte was observed here - so this is
 * sized for that worst case rather than assuming English-prose density.
 * Still an imperfect proxy for token count, but it's the same defensive
 * lever the tool already exposes, matching the DEFAULT_MODEL_FACING_MAX_RESULTS
 * precedent for search_files below.
 */
const DEFAULT_MODEL_FACING_MAX_BYTES = 6 * 1024;

/** Stable substring embedded in the empty-Thai-search retry nudge (see
 * emptyThaiNameSearchQueries()) so a second empty result in the same turn is
 * accepted normally instead of nudging the model forever. */
const THAI_EMPTY_SEARCH_NUDGE_MARKER = '(ระบบแนะนำให้ลองแยกคำ)';

/** Every recognized name/nickname (Thai or English) for a special folder, used to detect a match regardless of whether expansion actually needed to add anything. */
const SPECIAL_FOLDER_NAMES = new Set([
  ...Object.keys(SPECIAL_FOLDER_TRANSLATIONS),
  ...Object.values(SPECIAL_FOLDER_TRANSLATIONS),
]);

/**
 * Guards against a small model answering "not found"/"no access" without
 * ever calling scan_directory or search_files (observed directly: a
 * relative folder name like "assistant-app" got refused outright with zero
 * tool calls, and a lookup for a nonexistent file got "not found" also with
 * zero tool calls - the second one happened to be right, but only by luck,
 * since it never actually checked). step() retries once with an explicit
 * nudge when the latest user message looks like a file/folder lookup
 * (matches LOOKUP_INTENT_PATTERN) and doesn't also look like a mutation
 * request (matches MUTATION_INTENT_PATTERN) that no tool supports anyway -
 * e.g. "delete this file" should still get refused outright rather than
 * forced into a pointless retry.
 */

/** Matches the user referring to the active workspace itself by a generic
 * phrase rather than naming one of its subfolders - see
 * resolveNamedWorkspaceScope(). */
const WORKSPACE_SELF_REFERENCE_PATTERN =
  /โปรเจกต์นี้|โฟลเดอร์นี้|ในนี้|this project|this folder|this workspace/i;

/** A direct request to list/scan a known folder can be recovered
 * deterministically if the local model ignores the tool nudge twice. */

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
    }
  | {
      taskId: string;
      toolName: 'read_file';
      toolArgs: { path: string; maxBytes?: number };
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
    }
  | {
      toolName: 'read_file';
      toolArgs: { path: string; maxBytes?: number };
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
      this.recordActivity(
        permission.taskId,
        'ปฏิเสธการเข้าถึง',
        'เสร็จสิ้น',
        'permission',
      );
      // A denial used to just stop the run with no chat reply at all - from
      // the user's side that looked identical to the app hanging, with
      // nothing confirming their "no" was actually understood.
      const toolCalls = this.toolActivity.get(permission.taskId);
      this.toolActivity.delete(permission.taskId);
      const message = this.tasks.addMessage(
        permission.taskId,
        'assistant',
        `ได้ครับ ไม่เข้าถึง "${permission.path}" ตามที่แจ้ง หากต้องการให้ลองค้นในที่อื่นหรือระบุตำแหน่งที่แน่นอนกว่านี้ แจ้งได้เลยครับ`,
        undefined,
        toolCalls?.length ? toolCalls : undefined,
      );
      this.tasks.setStatus(permission.taskId, 'stopped');
      this.events.emit(permission.taskId, 'message', { message });
      this.events.emit(permission.taskId, 'status', {
        status: 'stopped',
        text: 'ผู้ใช้ไม่อนุญาตการเข้าถึง',
      });
      return;
    }
    this.recordActivity(
      permission.taskId,
      'อนุญาตการอ่านแล้ว',
      'เสร็จสิ้น',
      'permission',
    );
    this.tasks.setStatus(permission.taskId, 'working');
    void this.executeTool(pending).catch((error: unknown) =>
      this.fail(permission.taskId, error),
    );
  }

  private async run(taskId: string): Promise<void> {
    const task = this.tasks.findOne(taskId);
    const latestUserMessage = [...task.messages]
      .reverse()
      .find((message) => message.role === 'user')?.content;
    if (latestUserMessage && evaluateToolPolicy(latestUserMessage).isMutation) {
      this.complete(taskId, FILE_MUTATION_UNAVAILABLE_RESPONSE, 0);
      return;
    }
    const currentLocalDate = this.currentLocalDate();
    const messages: OllamaChatMessage[] = [
      {
        role: 'system',
        content: `The server's current local date is ${currentLocalDate}. Never claim that this date is in the future. If the user writes this exact date in a file modification-time lookup, treat it as today and use search_files.modifiedRange="today".`,
      },
      { role: 'system', content: FILE_METADATA_POLICY_PROMPT },
      {
        role: 'system',
        content: `You are a local AI assistant. The active workspace is ${task.workspacePath}. Use scan_directory to list the contents of a folder you already know the path to. Use search_files instead when the user is looking for a file or folder but doesn't know exactly where it is — it recurses through subfolders, and omitting its "root" argument searches every allowed location on this machine at once rather than just the active workspace. Pass every alternative search word as a separate item in search_files.queries; the tool matches them with OR in one directory walk, and each query is matched as a literal substring of the file/folder name — it does not read file contents and does not stem or segment words. For Thai queries especially, don't only pass the exact compound phrase the user typed (e.g. "หนี้สิน"): also include its shorter root words and common synonyms as separate items (e.g. "หนี้", "สิน", "เงินกู้", "สินเชื่อ") since real filenames may combine the root with a different word (e.g. "หนี้บ้าน") rather than using the user's exact phrase. When the user asks about files by time (e.g. "อาทิตย์ที่แล้ว"/last week, "เดือนที่แล้ว"/last month, "เมื่อวาน"/yesterday, "วันนี้"/today), set search_files.modifiedRange to the closest bucket (today, yesterday, last_7_days, last_30_days, or last_90_days) instead of trying to compute exact dates yourself — you don't reliably know today's date or do date arithmetic, the bucket boundaries are computed for you. Combine modifiedRange with queries to filter a name search by time, or give modifiedRange alone (omitting queries) to list everything changed in that window regardless of name. This machine's Windows special folders are at these exact fixed paths, listed as Thai name(s) (English name) = path: ${SPECIAL_FOLDER_PROMPT_SEGMENT}. When the user wants to see what is inside one of these (e.g. "ดูในดาวน์โหลดมีอะไรบ้าง"), call scan_directory directly with that exact path — never guess a different path for it (e.g. assuming it sits inside the active workspace), and don't use search_files for this, since search_files only returns items found *inside* the folders it walks and can never return one of the walked folders itself, so it can't answer "what's in Downloads" even when scoped correctly. Only use search_files with one of these folders when the user is looking for a specific file that might be inside it by name; in that case still pass both the Thai term and the real English folder name as separate query items (e.g. queries: ["ดาวโหลด", "Downloads"]) and omit "root" so it searches every allowed location — the folder on disk is always named in English regardless of the OS display language, so a Thai-only query would never match it since matching is a literal substring, not a translation. Both tools also work on absolute paths outside the active workspace, including other drive letters (e.g. G:\\) — call them directly with that path/root instead of assuming it's a typo; the system will automatically ask the user for permission whenever a tool call reaches outside the active workspace, or whenever search_files searches everywhere. The \`size\` field in every tool result is always in bytes (ไบต์) — never call it บิต (bits), and convert to KB/MB yourself using 1024 bytes per KB when that reads better. A tool result shaped as \`{"error": "..."}\` instead of the normal fields means that call failed — most often because the path/project you asked about doesn't actually exist on this machine. Never invent a path that pattern-matches an earlier real result (e.g. don't assume every project lives at "workspace\\<name>" just because one you already found did) — when a name doesn't match anything, say so plainly and suggest searching everywhere (omit root) instead of guessing another path. Never invent tool results — call search_files or scan_directory again for every new file/folder topic the user asks about, even within the same conversation, rather than answering from a previous search's result. When the user asks about a different file or topic than their last search, start a fresh search_files call with new queries and omit "root" again (search everywhere) — do not reuse or narrow to the folder where the previous search found something unless the user explicitly says to look in that same folder. Keep replies short and to the point — a sentence or two, not a bulleted list of options. If you're missing information, ask one focused question instead of several. Respond in the user's language.`,
      },
      ...task.messages
        .filter((message) => message.role !== 'tool')
        .map((message) => ({
          role: message.role as 'user' | 'assistant',
          content: message.content,
        })),
    ];

    const decision = evaluateToolPolicy(latestUserMessage ?? '');
    if (
      latestUserMessage &&
      decision.requiresFileEvidence &&
      !decision.isDirectoryListing &&
      !decision.requestsFileContent
    ) {
      const plan = await this.ollama.planFileSearch(latestUserMessage);
      if (plan) {
        const plannedQueries = this.expandPlannedQueries(plan.queries);
        const { requiresPermission, ...target } = this.resolveTarget(
          'search_files',
          { queries: plannedQueries, fuzzy: plan.fuzzy },
          task.workspacePath,
          latestUserMessage,
        );
        const pending: PendingToolRun = {
          taskId,
          messages: [
            ...messages,
            {
              role: 'system',
              content: `${THAI_EMPTY_SEARCH_NUDGE_MARKER} Dynamic search planning already expanded this request into multiple filename queries. Do not retry an empty result only to add more synonyms; summarize the verified result instead.`,
            },
          ],
          stepNumber: 1,
          ...target,
        };
        if (requiresPermission) {
          const permission = this.permissions.create(
            taskId,
            pending.displayPath,
          );
          this.pendingRuns.set(permission.id, pending);
          this.tasks.setStatus(taskId, 'waiting_permission');
          this.events.emit(taskId, 'permission_required', { permission });
          return;
        }
        await this.executeTool(pending);
        return;
      }
    }
    await this.step(taskId, messages, 1);
  }

  private async step(
    taskId: string,
    messages: OllamaChatMessage[],
    stepNumber: number,
    retriedNoTool = false,
  ): Promise<void> {
    const task = this.tasks.findOne(taskId);
    if (task.status === 'stopped') return;

    const result = await this.ollama.chat(messages, (delta) =>
      this.events.emit(taskId, 'message_delta', { delta }),
    );
    const call = result.toolCalls.find(
      (item) =>
        item.function.name === 'scan_directory' ||
        item.function.name === 'search_files' ||
        item.function.name === 'read_file',
    );

    if (!call) {
      if (!retriedNoTool && this.shouldForceToolRetry(taskId, messages)) {
        this.events.emit(taskId, 'status', {
          status: 'working',
          text: 'กำลังตรวจสอบอีกครั้ง',
        });
        const nudge: OllamaChatMessage = {
          role: 'system',
          content: `คุณตอบคำถามล่าสุดโดยไม่ได้เรียกเครื่องมือไฟล์เลย ต้องเรียก scan_directory, search_files หรือ read_file ที่เหมาะสมก่อนตอบเสมอ หากผู้ใช้ขออ่านหรือสรุปเนื้อหา ต้องใช้ read_file กับ exact path ก่อน ถ้าชื่อโฟลเดอร์ที่ผู้ใช้พูดถึงเป็นชื่อสั้น ๆ ให้ต่อกับ workspace path (${task.workspacePath}) เป็น absolute path ก่อนเรียกเครื่องมือ ตอนนี้เรียกเครื่องมือที่เหมาะสมแล้วตอบใหม่`,
        };
        await this.step(taskId, [...messages, nudge], stepNumber, true);
        return;
      }
      // A small local model can ignore even the explicit retry nudge and
      // fabricate a directory listing. For known Windows folders, recover
      // the real path from the user's words and enter the normal permission
      // flow instead of accepting an unverified answer.
      if (retriedNoTool) {
        const directScanPath =
          this.resolveDirectSpecialFolderScan(
            this.lastUserMessageText(messages),
          ) ??
          this.resolveDirectAbsolutePathScan(
            this.lastUserMessageText(messages),
          );
        if (directScanPath) {
          const pending: PendingToolRun = {
            taskId,
            messages,
            stepNumber,
            toolName: 'scan_directory',
            toolArgs: { path: directScanPath },
            displayPath: directScanPath,
          };
          if (!this.isWithin(directScanPath, task.workspacePath)) {
            const permission = this.permissions.create(taskId, directScanPath);
            this.pendingRuns.set(permission.id, pending);
            this.tasks.setStatus(taskId, 'waiting_permission');
            this.events.emit(taskId, 'permission_required', { permission });
            return;
          }
          await this.executeTool(pending);
          return;
        }
        if (
          evaluateToolPolicy(this.lastUserMessageText(messages) ?? '')
            .requiresFileEvidence
        ) {
          const decision = evaluateToolPolicy(
            this.lastUserMessageText(messages) ?? '',
          );
          this.complete(
            taskId,
            decision.requestsFileContent
              ? FILE_CONTENT_UNAVAILABLE_RESPONSE
              : UNVERIFIED_FILE_RESPONSE,
            stepNumber,
          );
          return;
        }
      }
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
      this.lastUserMessageText(messages),
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

  private shouldForceToolRetry(
    taskId: string,
    messages: OllamaChatMessage[],
  ): boolean {
    const usedRealTool = (this.toolActivity.get(taskId) ?? []).some(
      (entry) => entry.kind === 'tool',
    );
    if (usedRealTool) return false;
    const lastUserMessage = this.lastUserMessageText(messages);
    if (!lastUserMessage) return false;
    return evaluateToolPolicy(lastUserMessage).requiresFileEvidence;
  }

  private lastUserMessageText(
    messages: OllamaChatMessage[],
  ): string | undefined {
    return [...messages].reverse().find((message) => message.role === 'user')
      ?.content;
  }

  private resolveTarget(
    toolName: ToolName,
    rawArgs: Record<string, unknown>,
    workspacePath: string,
    lastUserMessage: string | undefined,
  ): ResolvedTarget {
    if (toolName === 'read_file') {
      const path =
        typeof rawArgs.path === 'string' ? rawArgs.path : workspacePath;
      // read_file's own default (64 KB, see 1-scan-file's ReadService) is
      // sized for the tool's own byte cap, not for what fits in the model's
      // context window - observed directly: a real 127 KB .xlsx extracted to
      // 42 KB of mostly-numeric text, which alone came to 20661 tokens and
      // made Ollama reject the whole request outright (context window
      // exceeded), failing the task with a raw HTTP error instead of a
      // graceful response. Only fall back to this smaller model-facing
      // default when the model didn't ask for a specific size itself.
      const maxBytes =
        typeof rawArgs.maxBytes === 'number'
          ? rawArgs.maxBytes
          : DEFAULT_MODEL_FACING_MAX_BYTES;
      return {
        toolName: 'read_file',
        toolArgs: { path, maxBytes },
        displayPath: path,
        requiresPermission: !this.isWithin(path, workspacePath),
      };
    }
    if (toolName === 'scan_directory') {
      const path =
        typeof rawArgs.path === 'string' ? rawArgs.path : workspacePath;
      // scan_directory only ever lists what's directly under `path` - the
      // model sometimes calls it anyway when the user actually asked for
      // files of a specific type somewhere inside a folder it already knows
      // (e.g. "หาไฟล์ .pdf ใน G:\My Drive"), silently missing every match in
      // a subfolder and then confidently reporting none exist (observed
      // directly). Extension intent detected from the user's own words means
      // a recursive search_files scoped to that same path is what's actually
      // needed, not a shallow listing.
      const impliedExtensions = this.resolveExtensions(
        undefined,
        lastUserMessage,
      );
      if (impliedExtensions.length > 0) {
        return {
          toolName: 'search_files',
          toolArgs: {
            queries: [],
            root: path,
            extensions: impliedExtensions,
            maxResults: DEFAULT_MODEL_FACING_MAX_RESULTS,
          },
          displayPath: path,
          requiresPermission: !this.isWithin(path, workspacePath),
        };
      }
      return {
        toolName: 'scan_directory',
        toolArgs: { path },
        displayPath: path,
        requiresPermission: !this.isWithin(path, workspacePath),
      };
    }

    const extensions = this.resolveExtensions(
      rawArgs.extensions,
      lastUserMessage,
    );
    const rawQueries = Array.isArray(rawArgs.queries)
      ? rawArgs.queries.filter(
          (query): query is string =>
            typeof query === 'string' &&
            query.length > 0 &&
            !this.isExtensionOnlyQuery(query, extensions),
        )
      : [];
    // The model sometimes attaches modifiedRange (e.g. "today") to a plain
    // name search even when the user's own message never mentioned time at
    // all (observed directly: "หาไฟล์ หนี้ ของฉันให้หน่อย ฉันจำไม่ได้ว่าเก็บ
    // ไว้ไหนอะ" got modifiedRange: 'today' attached, silently excluding a
    // real match last modified weeks earlier - the model still confidently
    // reported "not found" with no hint a date filter was ever involved).
    // Only honor it when the user's own words plausibly reference a
    // date/time window; otherwise the model's choice is very likely spurious
    // and would silently narrow the search in a way nobody asked for.
    const { modifiedAfter, modifiedBefore } = DATE_TIME_INTENT_PATTERN.test(
      lastUserMessage ?? '',
    )
      ? this.resolveModifiedRange(rawArgs.modifiedRange)
      : {};
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
    let forcedEverywhereBySpecialFolder = false;
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
      forcedEverywhereBySpecialFolder = matchedSpecialFolder;
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
    // The model frequently leaves root omitted (which always needs a
    // permission prompt to search everywhere) even when the user already
    // named a specific project/subfolder that exists right under the
    // workspace - e.g. "ในโปรเจกต์ 1-scan-file" or "ในโปรเจกต์นี้" (observed
    // directly: both defaulted to search-everywhere despite the explicit
    // scope). Infer that scope from the user's own words instead of forcing
    // an unnecessary permission prompt and an unnecessarily broad search.
    if (root === undefined && !forcedEverywhereBySpecialFolder) {
      const explicitRoot = this.resolveExplicitWindowsPath(lastUserMessage);
      const scope = explicitRoot
        ? { path: explicitRoot }
        : this.resolveNamedWorkspaceScope(lastUserMessage, workspacePath);
      if (scope) {
        root = scope.path;
        // The model sometimes puts the *folder name itself* in queries
        // (mirroring the special-folder pattern above) rather than using it
        // to say where to look - e.g. queries: ["dockers"] after already
        // being scoped into .../dockers. That's self-defeating: search_files
        // can never return the very folder it's walking, only things found
        // inside it (observed directly: this produced an empty "not found"
        // result for a folder that plainly exists and has content). Drop
        // that token from queries like the special-folder case already
        // does - or, if it was the *only* query with no date filter either,
        // the user just wanted a directory listing, which is exactly what
        // scan_directory is for.
        if (scope.matchedFolderName) {
          const withoutFolderName = queries.filter(
            (query) =>
              query.trim().toLowerCase() !==
              scope.matchedFolderName!.toLowerCase(),
          );
          if (withoutFolderName.length < queries.length) {
            if (withoutFolderName.length > 0 || modifiedAfter !== undefined) {
              queries = withoutFolderName;
            } else {
              return {
                toolName: 'scan_directory',
                toolArgs: { path: root },
                displayPath: root,
                requiresPermission: !this.isWithin(root, workspacePath),
              };
            }
          }
        }
      }
    }
    const rawMaxResults =
      typeof rawArgs.maxResults === 'number' ? rawArgs.maxResults : undefined;
    // Any search_files call without an explicit maxResults can hit the
    // (much larger) default from the search tool itself, handing the model
    // a wall of JSON - observed directly: a single broad word ("test")
    // searched across every allowed root returned enough long absolute
    // paths to blow a request out to 11683 tokens against an 8192-token
    // context window, failing the whole turn outright (not just garbling
    // the summary, as the name-less date-search case below already knew
    // about). truncated:true still tells the model more exist, so it can
    // ask to narrow the search rather than the request just failing.
    const maxResults = rawMaxResults ?? DEFAULT_MODEL_FACING_MAX_RESULTS;
    const toolArgs: SearchFilesArgs = {
      queries,
      root,
      ...(rawArgs.fuzzy === true ? { fuzzy: true } : {}),
      ...(extensions.length > 0 ? { extensions } : {}),
      maxResults,
      maxDepth:
        typeof rawArgs.maxDepth === 'number' ? rawArgs.maxDepth : undefined,
      ...(modifiedAfter !== undefined ? { modifiedAfter } : {}),
      ...(modifiedBefore !== undefined ? { modifiedBefore } : {}),
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
    // The model can hallucinate a plausible-looking absolute root that
    // doesn't actually exist (observed directly: after two real results
    // under D:\my-work\<project>, it pattern-matched that shape for a
    // project name that was never real, e.g. D:\my-work\notification-service)
    // - PathGuardService in 1-scan-file then throws for a nonexistent path.
    // Previously that exception propagated all the way up to fail() and
    // killed the whole task with a raw technical error and no chat reply at
    // all. Feed it back as a tool result instead, same as a real one, so the
    // model gets a turn to explain it to the user (or try again some other
    // way) instead of the conversation just dying.
    let result: unknown;
    let toolFailed = false;
    try {
      if (pending.toolName === 'scan_directory') {
        result = await this.mcp.scanDirectory(pending.toolArgs.path);
      } else if (pending.toolName === 'search_files') {
        result = await this.mcp.searchFiles(pending.toolArgs);
      } else {
        result = await this.mcp.readFile(
          pending.toolArgs.path,
          pending.toolArgs.maxBytes,
        );
      }
    } catch (error) {
      toolFailed = true;
      result = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const toolContent = JSON.stringify(result);
    this.tasks.addMessage(task.id, 'tool', toolContent, pending.toolName);
    this.events.emit(task.id, 'tool_completed', {
      tool: pending.toolName,
      path: pending.displayPath,
      result,
    });
    this.recordActivity(
      task.id,
      `${pending.toolName} ${toolFailed ? 'ไม่สำเร็จ' : 'เสร็จแล้ว'}`,
      toolFailed ? 'ไม่สำเร็จ' : 'เสร็จสิ้น',
      'tool',
      toolFailed ? 'failed' : 'done',
    );
    const modelToolContent = JSON.stringify(formatToolResultForModel(result));
    const nextMessages: OllamaChatMessage[] = [
      ...pending.messages,
      {
        role: 'tool',
        tool_name: pending.toolName,
        content: modelToolContent,
      },
    ];
    if (!toolFailed && pending.toolName === 'search_files') {
      const matches = (result as { matches?: unknown[] } | null)?.matches;
      if (Array.isArray(matches)) {
        nextMessages.push({
          role: 'system',
          content:
            matches.length > 0
              ? `SEARCH EVIDENCE: search_files returned ${matches.length} real filename match(es). Do not say that no files were found. Present them as files whose names may be relevant, and do not claim their contents are relevant unless read_file was used.`
              : 'SEARCH EVIDENCE: search_files returned zero filename matches for the queries and scope shown in the tool result. You may say no matching filenames were found in that verified scope, but do not claim the files do not exist outside it.',
        });
      }
    }
    // A literal-substring search_files query for a Thai compound word (e.g.
    // "หนี้สิน") finds nothing when the real filename only contains one root
    // of it (e.g. "เก็บเงินเครียหนี้.gsheet" has "หนี้" but not "หนี้สิน") -
    // observed directly: the system prompt already tells the model to split
    // compounds into shorter root words/synonyms, but a small local model
    // doesn't reliably do that on the first try and just reports "not found"
    // once it sees an empty match list. Nudge it once to retry with the
    // compound split apart before it settles on that answer; the marker
    // string lets a second empty result still get accepted normally instead
    // of nudging forever.
    const emptyThaiQueries = this.emptyThaiNameSearchQueries(
      pending,
      result,
      toolFailed,
    );
    if (
      emptyThaiQueries &&
      !pending.messages.some(
        (message) =>
          message.role === 'system' &&
          message.content.includes(THAI_EMPTY_SEARCH_NUDGE_MARKER),
      )
    ) {
      nextMessages.push({
        role: 'system',
        content: `การค้นหา ${emptyThaiQueries.map((query) => `"${query}"`).join(', ')} ด้วย search_files ไม่พบผลลัพธ์เลย ${THAI_EMPTY_SEARCH_NUDGE_MARKER} - คำนี้อาจเป็นคำผสมที่ไม่ได้ปรากฏในชื่อไฟล์จริงแบบคำเดียวกันเป๊ะๆ เพราะ search_files จับคู่แบบตัวอักษรตรงตัวเท่านั้น ไม่มีการตัดคำ ลองแยกเป็นคำย่อยหรือคำพ้องความหมายที่สั้นลงเป็น query แยกกันหลายคำ (เช่น คำหลักแต่ละคำ) แล้วเรียก search_files อีกครั้งในรอบนี้ ก่อนสรุปว่าไม่พบไฟล์`,
      });
    }
    await this.step(task.id, nextMessages, pending.stepNumber + 1);
  }

  /**
   * Returns the Thai-script queries responsible for a zero-match
   * search_files result (a plain name search, not a date/extension-only
   * lookup), or null when the nudge above doesn't apply.
   */
  private emptyThaiNameSearchQueries(
    pending: PendingToolRun,
    result: unknown,
    toolFailed: boolean,
  ): string[] | null {
    if (toolFailed || pending.toolName !== 'search_files') return null;
    const matches = (result as { matches?: unknown[] } | null)?.matches;
    if (!Array.isArray(matches) || matches.length > 0) return null;
    const thaiQueries = pending.toolArgs.queries.filter((query) =>
      /[฀-๿]/.test(query),
    );
    return thaiQueries.length > 0 ? thaiQueries : null;
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

  private recordActivity(
    taskId: string,
    label: string,
    detail: string,
    kind: 'tool' | 'permission',
    state: 'done' | 'failed' = 'done',
  ): void {
    const list = this.toolActivity.get(taskId) ?? [];
    list.push({ id: randomUUID(), label, detail, state, kind });
    this.toolActivity.set(taskId, list);
  }

  /**
   * Rewrites every occurrence of a path found in this run's tool results into
   * a Markdown link that opens it via FilesController, so the model doesn't
   * need to produce correct link/URI syntax itself for arbitrary Windows
   * paths (including Thai filenames) - only mention the same path text the
   * tool already returned.
   *
   * Two passes, in order:
   * 1. The model occasionally repeats a result's full absolute path verbatim
   *    in its own prose - link that occurrence directly.
   * 2. Far more often it only writes the bare filename with no path at all
   *    (observed directly: scan_directory folder listings almost never got
   *    linked because of this) - link that instead, but only when the name
   *    is unique among this turn's results, so an ambiguous name shared by
   *    several entries (e.g. multiple "README.md" in different folders) is
   *    left as plain text rather than risk linking to the wrong one.
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
        if (item && typeof item === 'object') {
          const recordItem = item as Record<string, unknown>;
          const name =
            typeof recordItem.name === 'string'
              ? recordItem.name
              : recordItem['ชื่อ'];
          const path =
            typeof recordItem.path === 'string'
              ? recordItem.path
              : recordItem['ตำแหน่ง'];
          if (typeof name === 'string' && typeof path === 'string') {
            files.set(path, name);
          }
        }
      }
    }

    let result = content;
    const linkedPaths = new Set<string>();
    const pathsByLength = [...files.keys()].sort((a, b) => b.length - a.length);
    for (const path of pathsByLength) {
      const name = files.get(path)!.replace(/([[\]])/g, '\\$1');
      const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp('`?' + escapedPath + '`?', 'g');
      if (!pattern.test(result)) continue;
      result = result.replace(pattern, `[${name}](${this.fileOpenUrl(path)})`);
      linkedPaths.add(path);
    }

    // The model sometimes emits the correct application URL itself. Treat a
    // URL derived from this turn's trusted tool result as already linked so
    // the bare-name pass does not create a nested Markdown link.
    for (const path of pathsByLength) {
      if (result.includes(`](${this.fileOpenUrl(path)})`)) {
        linkedPaths.add(path);
      }
    }

    const nameCounts = new Map<string, number>();
    for (const name of files.values()) {
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    const remaining = [...files.entries()]
      .filter(
        ([path, name]) => !linkedPaths.has(path) && nameCounts.get(name) === 1,
      )
      .sort(([, a], [, b]) => b.length - a.length);
    for (const [path, name] of remaining) {
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Lookaround boundary rather than \b: filenames often contain `.`/`-`,
      // which \b treats as a break, so \b would happily match "README"
      // inside "README.md" as if the extension weren't there. The optional
      // surrounding backticks are consumed (not just tolerated) for the same
      // reason as pass 1 - the model often writes a bare name as `` `name` ``,
      // and a Markdown link *inside* a code span renders as literal text,
      // not a clickable link, so those backticks have to go.
      const pattern = new RegExp(
        `\`?(?<![\\w.\\\\/:-])(?<!\\[)${escapedName}(?!\\]\\()(?![\\w.\\\\/:-])\`?`,
        'g',
      );
      if (!pattern.test(result)) continue;
      result = result.replace(pattern, `[${name}](${this.fileOpenUrl(path)})`);
      linkedPaths.add(path);
    }

    return this.appendLinkedPathLines(result, linkedPaths);
  }

  private fileOpenUrl(path: string): string {
    return `${this.filesApiBaseUrl}/open?path=${encodeURIComponent(path)}`;
  }

  private appendLinkedPathLines(
    content: string,
    linkedPaths: Set<string>,
  ): string {
    const lines = content.split('\n');
    for (const path of linkedPaths) {
      const url = this.fileOpenUrl(path);
      const lineIndex = lines.findIndex((line) => line.includes(`](${url})`));
      if (lineIndex >= 0) {
        // If the model used the absolute path as the value of a location
        // field, linkification turns that value into the filename. Remove the
        // now-misleading location label before adding the real path below.
        // This keeps the UI as two unambiguous lines: filename, then path.
        lines[lineIndex] = lines[lineIndex].replace(
          /^(\s*(?:[-*+]\s+)?)(?:(?:\*\*|__)?(?:ตำแหน่ง|location|path)(?:\*\*|__)?\s*:\s*)(?=\[)/iu,
          '$1',
        );
        lines.splice(lineIndex + 1, 0, `ตำแหน่ง: \`${path}\``);
      }
    }
    return lines.join('\n');
  }

  private resolveModifiedRange(modifiedRange: unknown): {
    modifiedAfter?: string;
    modifiedBefore?: string;
  } {
    if (typeof modifiedRange !== 'string') return {};
    const days = MODIFIED_RANGE_DAYS[modifiedRange];
    if (!days) return {};
    const now = new Date();
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (modifiedRange === 'yesterday') {
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
    } else {
      start.setDate(start.getDate() - (days - 1));
    }
    return {
      modifiedAfter: start.toISOString(),
      modifiedBefore: end.toISOString(),
    };
  }

  private resolveExtensions(
    rawExtensions: unknown,
    userText: string | undefined,
  ): string[] {
    const values = Array.isArray(rawExtensions)
      ? rawExtensions.filter(
          (value): value is string =>
            typeof value === 'string' &&
            /^\.?[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value.trim()),
        )
      : [];
    const text = userText ?? '';
    for (const match of text.matchAll(/(?:^|[\s(])\.([a-z0-9]{1,10})\b/gi)) {
      values.push(match[1]);
    }
    const commonTypes: Array<[RegExp, string[]]> = [
      [/\bpdf\b/i, ['pdf']],
      [/\b(?:word|docx?)\b/i, ['doc', 'docx']],
      [/\b(?:excel|xlsx?)\b/i, ['xls', 'xlsx']],
      [/\b(?:powerpoint|pptx?)\b/i, ['ppt', 'pptx']],
      [/\btxt\b/i, ['txt']],
      [/\bmarkdown\b|\.md\b/i, ['md']],
    ];
    for (const [pattern, extensions] of commonTypes) {
      if (pattern.test(text)) values.push(...extensions);
    }
    return [
      ...new Set(
        values.map((value) => {
          const normalized = value.trim().toLowerCase();
          return normalized.startsWith('.') ? normalized : `.${normalized}`;
        }),
      ),
    ].slice(0, 20);
  }

  private isExtensionOnlyQuery(query: string, extensions: string[]): boolean {
    if (extensions.length === 0) return false;
    const cleaned = query
      .trim()
      .toLowerCase()
      .replace(/\\/g, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/^\^/, '')
      .replace(/^\*/, '')
      .replace(/\$$/, '');
    const normalized = cleaned.startsWith('.') ? cleaned : `.${cleaned}`;
    return extensions.includes(normalized);
  }

  private currentLocalDate(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /** Resolves a raw query term to a special folder's real absolute path if it names one (Thai nickname or the English name itself), else undefined. */
  private resolveSpecialFolderPath(query: string): string | undefined {
    const trimmed = query.trim();
    const englishName = SPECIAL_FOLDER_TRANSLATIONS[trimmed] ?? trimmed;
    return SPECIAL_FOLDER_PATHS[englishName];
  }

  private resolveDirectSpecialFolderScan(
    text: string | undefined,
  ): string | undefined {
    if (!text || !DIRECTORY_LIST_INTENT.test(text)) return undefined;
    const normalized = text.toLowerCase();
    for (const [englishName, path] of Object.entries(SPECIAL_FOLDER_PATHS)) {
      const aliases = [
        englishName,
        ...Object.entries(SPECIAL_FOLDER_TRANSLATIONS)
          .filter(([, translated]) => translated === englishName)
          .map(([alias]) => alias),
      ];
      if (aliases.some((alias) => normalized.includes(alias.toLowerCase()))) {
        return path;
      }
    }
    return undefined;
  }

  /**
   * Recovers an explicit Windows absolute path from a direct directory-list
   * request when the local model ignored the tool twice. This enters the same
   * permission flow as a model-produced tool call instead of misleadingly
   * asking the user to make an already-clear path more specific.
   */
  private resolveDirectAbsolutePathScan(
    text: string | undefined,
  ): string | undefined {
    if (!text || !DIRECTORY_LIST_INTENT.test(text)) return undefined;
    return this.resolveExplicitWindowsPath(text);
  }

  private resolveExplicitWindowsPath(
    text: string | undefined,
  ): string | undefined {
    if (!text) return undefined;
    const match = text.match(
      /[a-zA-Z]:\\[^\r\n"']*?(?=\s+(?:ช่วย|ให้|หน่อย|ที|โดย|พร้อม|please\b|and\b)|[,.!?]|$)/i,
    );
    const path = match?.[0].trim();
    if (!path) return undefined;
    return /^[a-zA-Z]:\\$/.test(path) ? path : path.replace(/[\\/]+$/, '');
  }

  private expandSpecialFolderQueries(queries: string[]): string[] {
    const additions = queries
      .map((query) => SPECIAL_FOLDER_TRANSLATIONS[query.trim()])
      .filter(
        (translated): translated is string =>
          !!translated && !queries.includes(translated),
      );
    return additions.length ? [...queries, ...new Set(additions)] : queries;
  }

  /**
   * Adds a small number of boundary fragments for continuous-script compound
   * words. This is vocabulary-free: it helps a plan containing a compound
   * match filenames that use only one constituent without maintaining a
   * finance/legal/medical synonym table. ASCII identifiers are deliberately
   * left intact, and the MCP tool's 20-query ceiling is enforced here.
   */
  private expandPlannedQueries(queries: string[]): string[] {
    const originals = [...new Set(queries.map((query) => query.trim()))]
      .filter(Boolean)
      .slice(0, 12);
    const fragments: string[] = [];
    for (const query of originals) {
      const hasNonAscii = Array.from(query).some(
        (character) => (character.codePointAt(0) ?? 0) > 127,
      );
      if (!hasNonAscii || !/^[\p{L}\p{M}]+$/u.test(query)) {
        continue;
      }
      const characters = Array.from(query.normalize('NFKC'));
      const fragmentLength = Math.max(4, Math.ceil(characters.length / 2));
      if (characters.length - fragmentLength < 2) continue;
      fragments.push(
        characters.slice(0, fragmentLength).join(''),
        characters.slice(-fragmentLength).join(''),
      );
    }
    return [...new Set([...originals, ...fragments])].slice(0, 20);
  }

  /**
   * Infers a search_files root directly from the user's own message when the
   * model left it unscoped: either the workspace itself (a generic "this
   * project" reference) or one of the workspace's own immediate subfolders
   * mentioned by name (e.g. "1-scan-file"). Reads the workspace's real
   * subfolder names fresh each time rather than a fixed table - unlike the
   * Windows special folders, project layout varies per workspace and isn't
   * known in advance. Only checks direct children (one level), matching how
   * people actually refer to "the X project" - not something inferred from
   * an unrelated substring collision several levels deep.
   */
  private resolveNamedWorkspaceScope(
    text: string | undefined,
    workspacePath: string,
  ): { path: string; matchedFolderName?: string } | undefined {
    if (!text) return undefined;
    if (WORKSPACE_SELF_REFERENCE_PATTERN.test(text)) {
      return { path: workspacePath };
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(workspacePath, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const normalizedText = text.toLowerCase();
    const match = entries.find(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        entry.name.toLowerCase() !== 'node_modules' &&
        normalizedText.includes(entry.name.toLowerCase()),
    );
    return match
      ? {
          path: win32.join(workspacePath, match.name),
          matchedFolderName: match.name,
        }
      : undefined;
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
