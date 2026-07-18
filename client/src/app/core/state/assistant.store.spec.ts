import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { AssistantApiService } from '../api/assistant-api.service';
import { TaskEventsService } from '../api/task-events.service';
import { AgentEvent, AssistantTask, HealthStatus } from '../models/assistant.models';
import { AssistantStore } from './assistant.store';

describe('AssistantStore', () => {
  it('clears a replayed pending permission when a newer terminal status arrives', () => {
    const events = new Subject<AgentEvent>();
    const task: AssistantTask = {
      id: 'task-1',
      title: 'Test',
      workspacePath: 'D:\\my-work',
      status: 'stopped',
      messages: [],
      createdAt: 'now',
      updatedAt: 'now',
    };
    const health: HealthStatus = {
      status: 'ok',
      service: 'assistant-service',
      ollama: { available: true, model: 'test-model' },
      timestamp: 'now',
    };
    const envelope = <T>(data: T) => ({ data });
    const api = {
      getHealth: () => of(envelope(health)),
      listTasks: () => of(envelope([task])),
      getTask: () => of(envelope(task)),
    };
    const taskEvents = { connect: () => events.asObservable() };

    TestBed.configureTestingModule({
      providers: [
        AssistantStore,
        { provide: AssistantApiService, useValue: api },
        { provide: TaskEventsService, useValue: taskEvents },
      ],
    });
    const store = TestBed.inject(AssistantStore);

    events.next({
      id: 'event-permission',
      taskId: task.id,
      type: 'permission_required',
      createdAt: 'now',
      payload: {
        permission: {
          id: 'permission-1',
          taskId: task.id,
          action: 'read_directory',
          path: 'C:\\Users\\test\\Downloads',
          access: 'read',
          status: 'pending',
          createdAt: 'now',
        },
      },
    });
    expect(store.pendingPermission()?.id).toBe('permission-1');

    events.next({
      id: 'event-stopped',
      taskId: task.id,
      type: 'status',
      createdAt: 'now',
      payload: { status: 'stopped' },
    });

    expect(store.pendingPermission()).toBeNull();
  });
});
