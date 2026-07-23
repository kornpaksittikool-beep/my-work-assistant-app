import { ConfigService } from '@nestjs/config';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MemoryRecord } from '@assistant-app/contracts';
import { MemoryRepository } from './memory.repository';

describe('MemoryRepository', () => {
  let tmpDir: string;
  let dataFile: string;
  let config: ConfigService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memory-repo-'));
    dataFile = join(tmpDir, 'memory.json');
    config = { get: () => dataFile } as unknown as ConfigService;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const record = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
    id: overrides.id ?? 'mem-1',
    scope: overrides.scope ?? 'global',
    workspacePath: overrides.workspacePath,
    text: overrides.text ?? 'ชอบคำตอบสั้นกระชับ',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    sourceTaskId: overrides.sourceTaskId ?? 'task-1',
  });

  it('adds a record and finds it back by scope', () => {
    const repository = new MemoryRepository(config);
    repository.add(record());
    repository.add(
      record({
        id: 'mem-2',
        scope: 'workspace',
        workspacePath: 'D:\\my-work',
      }),
    );

    expect(repository.findGlobal()).toHaveLength(1);
    expect(repository.findForWorkspace('D:\\my-work')).toHaveLength(1);
    expect(repository.findForWorkspace('D:\\other')).toHaveLength(0);
  });

  it('finds every record regardless of scope', () => {
    const repository = new MemoryRepository(config);
    repository.add(record());
    repository.add(
      record({ id: 'mem-2', scope: 'workspace', workspacePath: 'D:\\my-work' }),
    );

    expect(
      repository
        .findAll()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['mem-1', 'mem-2']);
  });

  it('persists every mutation to the data file', () => {
    const repository = new MemoryRepository(config);
    repository.add(record());

    const readBack = (): MemoryRecord[] =>
      JSON.parse(readFileSync(dataFile, 'utf8')) as MemoryRecord[];
    expect(readBack()).toHaveLength(1);

    repository.remove('mem-1');
    expect(readBack()).toHaveLength(0);
  });

  it('loads previously persisted records back on construction, instead of starting empty', () => {
    const first = new MemoryRepository(config);
    first.add(record());

    const second = new MemoryRepository(config);
    expect(second.findGlobal()).toHaveLength(1);
  });

  it('recovers from the backup when the primary file is corrupt', () => {
    const first = new MemoryRepository(config);
    first.add(record());
    // Trigger another persist so the previous valid primary is copied to .bak.
    first.add(record({ id: 'mem-2', text: 'อีกเรื่องหนึ่ง' }));
    writeFileSync(dataFile, '{corrupt');

    const recovered = new MemoryRepository(config);
    expect(recovered.findGlobal().map((r) => r.id)).toEqual(['mem-1']);
  });

  it('starts empty rather than failing to boot when the data file is missing or corrupt', () => {
    expect(() => new MemoryRepository(config).findGlobal()).not.toThrow();
    expect(new MemoryRepository(config).findGlobal()).toEqual([]);

    writeFileSync(dataFile, '{not valid json');
    expect(new MemoryRepository(config).findGlobal()).toEqual([]);
  });
});
