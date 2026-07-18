import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AssistantTask } from './task.types';
import { TasksRepository } from './tasks.repository';

describe('TasksRepository', () => {
  let tmpDir: string;
  let dataFile: string;
  let config: ConfigService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tasks-repo-'));
    dataFile = join(tmpDir, 'tasks.json');
    config = { get: () => dataFile } as unknown as ConfigService;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates, updates and lists tasks', () => {
    const repository = new TasksRepository(config);
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
    expect(() => new TasksRepository(config).findOne('missing')).toThrow(
      NotFoundException,
    );
  });

  it('sorts multiple tasks by most recently updated first', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      const repository = new TasksRepository(config);
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

  it('persists every mutation to the data file, overwriting it each time', () => {
    const repository = new TasksRepository(config);
    const task = repository.create('Test task', 'D:\\my-work');

    const readBack = (): AssistantTask[] =>
      JSON.parse(readFileSync(dataFile, 'utf8')) as AssistantTask[];
    expect(readBack()).toHaveLength(1);

    repository.addMessage(task.id, 'user', 'hello');
    expect(readBack()[0].messages).toHaveLength(1);

    repository.setStatus(task.id, 'working');
    expect(readBack()[0].status).toBe('working');
  });

  it('loads previously persisted tasks back on construction, instead of starting empty', () => {
    const first = new TasksRepository(config);
    const task = first.create('Test task', 'D:\\my-work');
    first.addMessage(task.id, 'assistant', 'hi there');

    const second = new TasksRepository(config);
    expect(second.findOne(task.id)).toMatchObject({ title: 'Test task' });
    expect(second.findOne(task.id).messages[0].content).toBe('hi there');
  });

  it('starts empty rather than failing to boot when the data file is missing', () => {
    expect(() => new TasksRepository(config).findAll()).not.toThrow();
    expect(new TasksRepository(config).findAll()).toEqual([]);
  });

  it('starts empty rather than failing to boot when the data file has corrupt JSON', () => {
    writeFileSync(dataFile, '{not valid json');
    expect(() => new TasksRepository(config).findAll()).not.toThrow();
    expect(new TasksRepository(config).findAll()).toEqual([]);
  });
});
