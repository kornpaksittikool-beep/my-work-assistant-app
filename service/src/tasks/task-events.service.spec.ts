import { TaskEventsService } from './task-events.service';

describe('TaskEventsService', () => {
  it('emits an event and delivers it to a stream subscribed beforehand', (done) => {
    const service = new TaskEventsService();

    service.stream('task-1').subscribe((event) => {
      expect(event.type).toBe('status');
      done();
    });

    service.emit('task-1', 'status', { status: 'working' });
  });

  it('replays buffered events to a stream subscribed after emit, reusing the same stream', () => {
    const service = new TaskEventsService();

    const emitted = service.emit('task-2', 'status', { status: 'working' });
    expect(emitted.taskId).toBe('task-2');
    expect(emitted.type).toBe('status');
    expect(typeof emitted.id).toBe('string');

    const received: unknown[] = [];
    service.stream('task-2').subscribe((event) => received.push(event));

    expect(received).toHaveLength(1);
  });
});
