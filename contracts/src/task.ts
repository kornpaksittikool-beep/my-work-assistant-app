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
