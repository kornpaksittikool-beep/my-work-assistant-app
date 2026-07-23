export type TaskStatus =
  | 'idle'
  | 'working'
  | 'waiting_permission'
  | 'completed'
  | 'stopped'
  | 'failed';

export type MessageRole = 'user' | 'assistant' | 'tool';

export interface ToolActivityEntry {
  id: string;
  label: string;
  detail: string;
  state: 'done' | 'failed';
  /** Distinguishes an actual scan_directory/search_files call from a
   * permission allow/deny decision, so the client can count "N tools used"
   * against real tool invocations only. */
  kind: 'tool' | 'permission';
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  toolName?: string;
  /** Tool calls/permission decisions made while generating this message
   * (assistant messages only), persisted so history keeps showing them. */
  toolCalls?: ToolActivityEntry[];
}

export interface AssistantTask {
  id: string;
  title: string;
  workspacePath: string;
  status: TaskStatus;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
}
