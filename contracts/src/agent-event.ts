export type AgentEventType =
  | 'status'
  | 'message'
  | 'message_delta'
  | 'tool_started'
  | 'tool_completed'
  | 'permission_required'
  | 'completed'
  | 'error';

export interface AgentEvent<T = Record<string, unknown>> {
  id: string;
  taskId: string;
  type: AgentEventType;
  createdAt: string;
  payload: T;
}
