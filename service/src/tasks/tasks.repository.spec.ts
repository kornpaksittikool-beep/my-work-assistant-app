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

  it('names a default task from its first user message', () => {
    const repository = new TasksRepository(config);
    const task = repository.create('งานใหม่', 'D:\\my-work');

    repository.addMessage(
      task.id,
      'user',
      '  หาไฟล์ Markdown   ในโปรเจกต์นี้  ',
    );

    expect(repository.findOne(task.id).title).toBe(
      'หาไฟล์ Markdown ในโปรเจกต์นี้',
    );
  });

  it('keeps an explicit title and shortens a long automatic title', () => {
    const repository = new TasksRepository(config);
    const explicit = repository.create('ชื่อที่ตั้งเอง', 'D:\\my-work');
    repository.addMessage(explicit.id, 'user', 'ข้อความแรก');
    expect(repository.findOne(explicit.id).title).toBe('ชื่อที่ตั้งเอง');

    const automatic = repository.create('งานใหม่', 'D:\\my-work');
    repository.addMessage(automatic.id, 'user', 'ก'.repeat(80));
    expect(repository.findOne(automatic.id).title).toHaveLength(52);
    expect(repository.findOne(automatic.id).title.endsWith('…')).toBe(true);
  });

  it('throws for an unknown task', () => {
    expect(() => new TasksRepository(config).findOne('missing')).toThrow(
      NotFoundException,
    );
  });

  it('renames, archives and deletes tasks persistently', () => {
    const repository = new TasksRepository(config);
    const task = repository.create('Original', 'D:\\my-work');

    repository.update(task.id, { title: 'Renamed', archived: true });
    expect(repository.findOne(task.id)).toMatchObject({
      title: 'Renamed',
      archived: true,
    });
    expect(repository.findAll()).toEqual([]);

    const reloaded = new TasksRepository(config);
    expect(reloaded.findOne(task.id).title).toBe('Renamed');
    expect(reloaded.remove(task.id).id).toBe(task.id);
    expect(() => reloaded.findOne(task.id)).toThrow(NotFoundException);
    expect(new TasksRepository(config).findAll()).toEqual([]);
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

  it('recovers from the backup when the primary tasks file is corrupt', () => {
    const first = new TasksRepository(config);
    const task = first.create('Recover me', 'D:\\my-work');
    first.addMessage(task.id, 'assistant', 'saved');
    // Trigger another persist so the previous valid primary is copied to .bak.
    first.setStatus(task.id, 'completed');
    writeFileSync(dataFile, '{corrupt');

    const recovered = new TasksRepository(config);
    expect(recovered.findOne(task.id).title).toBe('Recover me');
  });

  it('marks non-resumable working and permission-waiting tasks as stopped after restart', () => {
    const makeTask = (id: string, status: AssistantTask['status']): AssistantTask => ({
      id,
      title: id,
      workspacePath: 'D:\\my-work',
      status,
      messages: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    writeFileSync(
      dataFile,
      JSON.stringify([
        makeTask('working', 'working'),
        makeTask('permission', 'waiting_permission'),
        makeTask('completed', 'completed'),
      ]),
    );

    const repository = new TasksRepository(config);

    expect(repository.findOne('working').status).toBe('stopped');
    expect(repository.findOne('permission').status).toBe('stopped');
    expect(repository.findOne('completed').status).toBe('completed');
    const persisted = JSON.parse(
      readFileSync(dataFile, 'utf8'),
    ) as AssistantTask[];
    expect(persisted.find((task) => task.id === 'permission')?.status).toBe(
      'stopped',
    );
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
