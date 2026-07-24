import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ExtractedMemory,
  FileSearchPlan,
  OllamaChatMessage,
  OllamaChatResult,
  OllamaToolCall,
} from './ollama.types';

interface OllamaResponse {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
}

const MAX_PLANNED_QUERIES = 12;
const MAX_EXTRACTED_MEMORIES = 3;

/**
 * Thai dependent vowel signs and tone marks (U+0E31 MAI HAN-AKAT, U+0E32
 * SARA AA, U+0E34-U+0E3A SARA I..PHINTHU, U+0E46-U+0E4E MAIYAMOK..YAMAKKAN)
 * that must attach to a preceding consonant and can never legitimately
 * start a word on their own. A small model asked to split a Thai compound
 * word into "roots" sometimes just slices it at an arbitrary character
 * offset instead of a real word boundary (e.g. "เวลาทำงาน" -> "เวลาท" +
 * "ำงาน"/"ํางาน") - a fragment starting with one of these is a reliable
 * sign of that kind of cut, even though the fragment happens to still be a
 * literal substring of the word.
 */
// eslint-disable-next-line no-misleading-character-class -- each escape is an intentional standalone Thai combining mark/tone mark, not an accidental combined grapheme.
const INVALID_THAI_FRAGMENT_START = /^[\u0E31\u0E32\u0E34-\u0E3A\u0E46-\u0E4E]/;

function startsWithInvalidThaiFragment(query: string): boolean {
  return INVALID_THAI_FRAGMENT_START.test(query);
}

function containsThai(text: string): boolean {
  return /[฀-๿]/.test(text);
}

@Injectable()
export class OllamaService {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly numCtx: number;

  constructor(config: ConfigService) {
    this.baseUrl =
      config.get<string>('OLLAMA_BASE_URL') ?? 'http://localhost:11434';
    this.model = config.get<string>('OLLAMA_MODEL') ?? 'qwen3:4b';
    // Ollama's own model default is 4096 tokens, which the system prompt
    // (tool instructions + conversation history) can now exceed on its own,
    // causing a hard 400 rather than just running slower - raise it rather
    // than trim every prompt addition down to fit.
    this.numCtx = config.get<number>('OLLAMA_NUM_CTX') ?? 8192;
  }

  getModel(): string {
    return this.model;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async chat(
    messages: OllamaChatMessage[],
    onDelta?: (text: string) => void,
  ): Promise<OllamaChatResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
          model: this.model,
          stream: true,
          messages,
          tools: [
            this.scanDirectoryTool(),
            this.searchFilesTool(),
            this.readFileTool(),
            this.listScanRootsTool(),
          ],
          options: { num_ctx: this.numCtx },
        }),
      });
    } catch (error) {
      throw new BadGatewayException(
        `Cannot connect to Ollama: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new BadGatewayException(
        `Ollama returned HTTP ${response.status}${errorBody ? `: ${errorBody}` : ''}`,
      );
    }
    if (!response.body)
      throw new BadGatewayException('Ollama returned an empty stream');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let toolCalls: OllamaToolCall[] = [];
    let receivedChunk = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as OllamaResponse;
        receivedChunk = true;
        if (chunk.message?.content) {
          content += chunk.message.content;
          onDelta?.(chunk.message.content);
        }
        if (chunk.message?.tool_calls?.length) {
          toolCalls = chunk.message.tool_calls;
        }
      }
    }
    if (!receivedChunk)
      throw new BadGatewayException('Ollama returned an invalid chat response');
    return { content, toolCalls };
  }

  /**
   * Turns a natural-language file topic into a small, language-agnostic set
   * of filename queries. This is intentionally a separate constrained call:
   * the normal chat model no longer has to choose a tool and invent useful
   * synonyms in the same step. Returning null is a safe soft failure; the
   * regular tool-calling flow remains available as a fallback.
   */
  async planFileSearch(userText: string): Promise<FileSearchPlan | null> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: {
            type: 'object',
            required: ['queries', 'fuzzy'],
            properties: {
              queries: {
                type: 'array',
                minItems: 1,
                maxItems: MAX_PLANNED_QUERIES,
                items: { type: 'string' },
              },
              fuzzy: { type: 'boolean' },
            },
          },
          messages: [
            {
              role: 'system',
              content:
                'Create a filename-search plan from the user request. Return JSON only. Generate short literal substrings that could realistically occur in filenames. Include the important original term plus useful roots, synonyms, common translations, abbreviations, and likely spelling corrections inferred from context. For Thai compound words, only split at a boundary that is itself a real, independently meaningful Thai word (e.g. เวลา + ทำงาน) - never cut at an arbitrary syllable or character boundary that is not a real word on its own (e.g. never produce a fragment like "เวลาท" or "ํางาน" from "เวลาทำงาน"). Preserve exact identifiers, codes, and quoted filenames. Do not invent paths. Do not include conversational filler. Keep at most 12 unique queries. Set fuzzy=true when spelling may be uncertain or the request is topic-based.',
            },
            { role: 'user', content: userText },
          ],
          options: { num_ctx: Math.min(this.numCtx, 4096), temperature: 0 },
        }),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;

    try {
      const body = (await response.json()) as OllamaResponse;
      const parsed = JSON.parse(body.message?.content ?? '') as {
        queries?: unknown;
        fuzzy?: unknown;
      };
      if (!Array.isArray(parsed.queries)) return null;
      const queries = [
        ...new Set(
          parsed.queries
            .filter((query): query is string => typeof query === 'string')
            .map((query) => query.trim())
            .filter(
              (query) =>
                query.length > 0 &&
                query.length <= 100 &&
                !startsWithInvalidThaiFragment(query),
            ),
        ),
      ].slice(0, MAX_PLANNED_QUERIES);
      if (queries.length === 0) return null;
      return { queries, fuzzy: parsed.fuzzy === true };
    } catch {
      return null;
    }
  }

  /**
   * Decides whether anything from this turn is worth remembering across
   * sessions. A separate constrained call, same shape as planFileSearch, so
   * the normal chat model never has to juggle "should I remember this" on
   * top of answering the user. Returning null/empty is the common case and a
   * safe soft failure - the turn already completed regardless of this call.
   */
  async extractMemories(
    userText: string,
    assistantText: string,
    existingContext: string | null,
  ): Promise<ExtractedMemory[] | null> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: {
            type: 'object',
            required: ['memories'],
            properties: {
              memories: {
                type: 'array',
                maxItems: MAX_EXTRACTED_MEMORIES,
                items: {
                  type: 'object',
                  required: ['scope', 'text'],
                  properties: {
                    scope: { type: 'string', enum: ['global', 'workspace'] },
                    text: { type: 'string' },
                  },
                },
              },
            },
          },
          messages: [
            {
              role: 'system',
              content:
                'Decide if this exchange contains anything genuinely new and durable worth remembering across future sessions. Return JSON only. Write each text in the same language the user wrote their message in - never translate it to English or any other language. Use scope="global" for stable facts/preferences about the user (name, language, habits) that apply regardless of project. Use scope="workspace" for facts specific to the current project/workspace. Each text must be a short, self-contained, concrete fact - never meta-commentary about this conversation or about testing/validating the system itself (e.g. never write something like "user is testing the system" or "user wants a response"). Do not repeat anything already listed in the existing-memories context. Most turns have nothing worth remembering - return an empty memories array in that case. Never record secrets, credentials, or file contents.',
            },
            {
              role: 'user',
              content: `${existingContext ? `${existingContext}\n\n` : ''}User: ${userText}\nAssistant: ${assistantText}`,
            },
          ],
          options: { num_ctx: Math.min(this.numCtx, 4096), temperature: 0 },
        }),
      });
    } catch {
      return null;
    }
    if (!response.ok) return null;

    try {
      const body = (await response.json()) as OllamaResponse;
      const parsed = JSON.parse(body.message?.content ?? '') as {
        memories?: unknown;
      };
      if (!Array.isArray(parsed.memories)) return null;
      return parsed.memories
        .filter(
          (memory): memory is ExtractedMemory =>
            !!memory &&
            typeof memory === 'object' &&
            (memory as ExtractedMemory).scope !== undefined &&
            typeof (memory as ExtractedMemory).text === 'string',
        )
        .map((memory): ExtractedMemory => ({
          scope: memory.scope === 'global' ? 'global' : 'workspace',
          text: memory.text.trim(),
        }))
        .filter(
          (memory) =>
            memory.text.length > 0 &&
            memory.text.length <= 500 &&
            // A model asked to write in the user's language sometimes still
            // answers in English regardless - reject rather than silently
            // store a memory in the wrong language for a Thai-speaking user.
            (!containsThai(userText) || containsThai(memory.text)),
        )
        .slice(0, MAX_EXTRACTED_MEMORIES);
    } catch {
      return null;
    }
  }

  private scanDirectoryTool(): Record<string, unknown> {
    return {
      type: 'function',
      function: {
        name: 'scan_directory',
        description:
          'List files and folders at the top level of an allowed local directory. Use this to browse a folder you already know the path to.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string' } },
        },
      },
    };
  }

  private searchFilesTool(): Record<string, unknown> {
    return {
      type: 'function',
      function: {
        name: 'search_files',
        description:
          "Recursively search for a file or folder by name when you don't know exactly where it is. Omit `root` to search every allowed location on the machine at once; pass `root` to restrict the search to one location. `queries` may be omitted only when `modifiedRange` is given instead, to list everything changed in that time window regardless of name.",
        parameters: {
          type: 'object',
          properties: {
            queries: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 20,
              description:
                'One or more substrings to match against file/folder names (case-insensitive). A name matches when it contains ANY query (OR). Put alternative words in separate array items. May be omitted if modifiedRange is given.',
            },
            root: {
              type: 'string',
              description:
                'Optional absolute path to restrict the search to. Omit to search every allowed root.',
            },
            fuzzy: {
              type: 'boolean',
              description:
                'Enable conservative typo-tolerant filename matching. Useful when the user is unsure of the spelling.',
            },
            extensions: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 20,
              description:
                'Optional file-extension filter, for example [".pdf"] or [".doc", ".docx"]. Use this instead of treating an extension as a filename query.',
            },
            maxResults: {
              type: 'integer',
              minimum: 1,
              maximum: 500,
              description: 'Maximum number of matches to return.',
            },
            modifiedRange: {
              type: 'string',
              enum: [
                'today',
                'yesterday',
                'last_7_days',
                'last_30_days',
                'last_90_days',
              ],
              description:
                'Only include files/folders last modified within this rolling window up to now. Pick the closest bucket for whatever the user said (e.g. "last week"/"a few days ago" → last_7_days, "last month" → last_30_days, "this quarter"/"few months ago" → last_90_days).',
            },
          },
        },
      },
    };
  }

  private readFileTool(): Record<string, unknown> {
    return {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          'Read or extract actual content from an exact .txt, .md, .json, .pdf, .docx, .xlsx or .pptx path. Use this before making any claim about what a file says or contains.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string', description: 'Exact absolute file path.' },
            maxBytes: {
              type: 'integer',
              minimum: 1,
              maximum: 262144,
              description:
                'Maximum extracted-content bytes to return; default 65536.',
            },
          },
        },
      },
    };
  }

  private listScanRootsTool(): Record<string, unknown> {
    return {
      type: 'function',
      function: {
        name: 'list_scan_roots',
        description:
          'List the folders/drives the user currently allows this assistant to scan, search, and read files from. Use this whenever the user asks which folders, drives, or locations you can access or scan - never guess or invent an answer to that question. Takes no arguments.',
        parameters: { type: 'object', properties: {} },
      },
    };
  }
}
