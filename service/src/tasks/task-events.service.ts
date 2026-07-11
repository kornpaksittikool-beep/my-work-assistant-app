import { Injectable, MessageEvent } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable, ReplaySubject } from 'rxjs';
import { AgentEventData } from './task.types';

@Injectable()
export class TaskEventsService {
  private readonly streams = new Map<string, ReplaySubject<MessageEvent>>();

  stream(taskId: string): Observable<MessageEvent> {
    return this.getStream(taskId).asObservable();
  }

  emit(
    taskId: string,
    type: AgentEventData['type'],
    payload: Record<string, unknown>,
  ): AgentEventData {
    const event: AgentEventData = {
      id: randomUUID(),
      taskId,
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
    this.getStream(taskId).next({ type, id: event.id, data: event });
    return event;
  }

  private getStream(taskId: string): ReplaySubject<MessageEvent> {
    let stream = this.streams.get(taskId);
    if (!stream) {
      stream = new ReplaySubject<MessageEvent>(20);
      this.streams.set(taskId, stream);
    }
    return stream;
  }
}
