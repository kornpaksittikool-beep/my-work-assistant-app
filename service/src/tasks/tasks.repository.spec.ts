import { NotFoundException } from '@nestjs/common';
import { TasksRepository } from './tasks.repository';

describe('TasksRepository', () => {
  it('creates, updates and lists tasks', () => {
    const repository = new TasksRepository();
    const task = repository.create('Test task', 'D:\\my-work');
    repository.addMessage(task.id, 'user', 'hello');
    repository.setStatus(task.id, 'working');
    expect(repository.findOne(task.id)).toMatchObject({
      title: 'Test task',
      status: 'working',
    });
    expect(repository.findAll()).toHaveLength(1);
    expect(repository.findOne(task.id).messages[0].content).toBe('hello');
  });

  it('throws for an unknown task', () => {
    expect(() => new TasksRepository().findOne('missing')).toThrow(
      NotFoundException,
    );
  });

  it('sorts multiple tasks by most recently updated first', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const repository = new TasksRepository();
      const first = repository.create('First', 'D:\\my-work');

      jest.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
      const second = repository.create('Second', 'D:\\my-work');

      expect(repository.findAll().map((t) => t.id)).toEqual([
        second.id,
        first.id,
      ]);
    } finally {
      jest.useRealTimers();
    }
  });
});
