// TaskStatus..AgentEvent mirror ../../../../contracts/src — keep in sync until cross-package imports are wired up.
export type TaskStatus = 'idle' | 'working' | 'waiting_permission' | 'completed' | 'stopped' | 'failed';
export type MessageRole = 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  toolName?: string;
  /** Tool calls/permission decisions made while generating this message
   * (assistant messages only) - persisted so the history keeps showing them,
   * unlike the transient `activities` feed which only tracks the live run. */
  toolCalls?: ActivityItem[];
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

export interface HealthStatus {
  status: 'ok';
  service: string;
  ollama: { available: boolean; model: string };
  timestamp: string;
}

export interface ActivityItem {
  id: string;
  label: string;
  detail: string;
  state: 'done' | 'working' | 'queued' | 'failed';
}

export interface PermissionRequest {
  id: string;
  taskId: string;
  action: 'read_directory';
  path: string;
  access: 'read';
  status: 'pending' | 'allowed' | 'denied';
  createdAt: string;
}

export interface AgentEvent<T = Record<string, unknown>> {
  id: string;
  taskId: string;
  type: 'status' | 'message' | 'message_delta' | 'tool_started' | 'tool_completed' | 'permission_required' | 'completed' | 'error';
  createdAt: string;
  payload: T;
}

export interface ApiEnvelope<T> { success: true; statusCode: number; data: T; timestamp: string; path: string; }
