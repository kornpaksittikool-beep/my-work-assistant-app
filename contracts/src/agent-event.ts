export interface AgentEvent<T = Record<string, unknown>> {
  id: string;
  taskId: string;
  type:
    | 'status'
    | 'message'
    | 'message_delta'
    | 'tool_started'
    | 'tool_completed'
    | 'permission_required'
    | 'completed'
    | 'error';
  createdAt: string;
  payload: T;
}
