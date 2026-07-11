// Mirrors ../../../contracts/src/task.ts and agent-event.ts — keep in sync until cross-package imports are wired up.
export type TaskStatus =
  | 'idle'
  | 'working'
  | 'waiting_permission'
  | 'completed'
  | 'stopped'
  | 'failed';
export type MessageRole = 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  toolName?: string;
}

export interface AssistantTask {
  id: string;
  title: string;
  workspacePath: string;
  status: TaskStatus;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentEventData {
  id: string;
  taskId: string;
  type:
    | 'status'
    | 'message'
    | 'tool_started'
    | 'tool_completed'
    | 'permission_required'
    | 'completed'
    | 'error';
  createdAt: string;
  payload: Record<string, unknown>;
}
