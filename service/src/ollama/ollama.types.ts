export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_name?: string;
}

export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface OllamaChatResult {
  content: string;
  toolCalls: OllamaToolCall[];
}

export interface FileSearchPlan {
  /** Short filename substrings generated dynamically from the user's intent. */
  queries: string[];
  /** Whether approximate filename matching is useful for this request. */
  fuzzy: boolean;
}

export interface ExtractedMemory {
  scope: 'global' | 'workspace';
  text: string;
}
