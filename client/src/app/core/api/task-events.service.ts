import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { API_BASE_URL } from '../config/api.config';
import type { AgentEvent } from '@assistant-app/contracts';

@Injectable({ providedIn: 'root' })
export class TaskEventsService {
  connect(taskId: string): Observable<AgentEvent> {
    return new Observable<AgentEvent>((subscriber) => {
      const source = new EventSource(`${API_BASE_URL}/tasks/${taskId}/events`);
      const eventNames: AgentEvent['type'][] = ['status', 'message', 'message_delta', 'tool_started', 'tool_completed', 'permission_required', 'completed', 'error'];
      const listeners = eventNames.map((name) => {
        const listener = (event: Event) => {
          try { subscriber.next(JSON.parse((event as MessageEvent<string>).data) as AgentEvent); }
          catch (error) { subscriber.error(error); }
        };
        source.addEventListener(name, listener);
        return { name, listener };
      });
      source.onerror = () => {
        // EventSource reconnects automatically. Keep the observable alive.
      };
      return () => {
        listeners.forEach(({ name, listener }) => source.removeEventListener(name, listener));
        source.close();
      };
    });
  }
}
