import { ConfigService } from '@nestjs/config';
import { MemoryRepository } from './memory.repository';
import { MemoryService } from './memory.service';
import { MemoryRecord } from './memory.types';

describe('MemoryService', () => {
  const createService = (
    options: { maxPerScope?: number; contextMaxChars?: number } = {},
  ) => {
    const records: MemoryRecord[] = [];
    const repository = {
      findGlobal: jest.fn(() => records.filter((r) => r.scope === 'global')),
      findForWorkspace: jest.fn((workspacePath: string) =>
        records.filter(
          (r) => r.scope === 'workspace' && r.workspacePath === workspacePath,
        ),
      ),
      add: jest.fn((record: MemoryRecord) => records.push(record)),
      remove: jest.fn((id: string) => {
        const index = records.findIndex((r) => r.id === id);
        if (index !== -1) records.splice(index, 1);
      }),
    } as unknown as MemoryRepository;
    const config = {
      get: (key: string) =>
        key === 'MEMORY_MAX_RECORDS_PER_SCOPE'
          ? options.maxPerScope
          : key === 'MEMORY_CONTEXT_MAX_CHARS'
            ? options.contextMaxChars
            : undefined,
    } as unknown as ConfigService;
    const service = new MemoryService(repository, config);
    return { service, repository, records };
  };

  it('mixes global memories with only the matching workspace ones', () => {
    const { service } = createService();
    service.applyExtracted(
      [{ scope: 'global', text: 'ชอบภาษาไทย' }],
      'D:\\my-work',
      'task-1',
    );
    service.applyExtracted(
      [{ scope: 'workspace', text: 'ใช้ Angular + NestJS' }],
      'D:\\my-work',
      'task-1',
    );
    service.applyExtracted(
      [{ scope: 'workspace', text: 'โปรเจกต์อื่น' }],
      'D:\\other',
      'task-2',
    );

    const context = service.getContextFor('D:\\my-work');
    expect(context.map((r) => r.text).sort()).toEqual(
      ['ชอบภาษาไทย', 'ใช้ Angular + NestJS'].sort(),
    );
  });

  it('skips a case-insensitive duplicate of an existing memory in the same scope', () => {
    const { service, repository } = createService();
    service.applyExtracted(
      [{ scope: 'global', text: 'ชอบคำตอบสั้น' }],
      'D:\\my-work',
      'task-1',
    );
    service.applyExtracted(
      [{ scope: 'global', text: '  ชอบคำตอบสั้น  ' }],
      'D:\\my-work',
      'task-2',
    );

    expect(repository.add).toHaveBeenCalledTimes(1);
  });

  it('skips a reworded paraphrase of an existing memory in the same scope', () => {
    const { service, repository } = createService();
    service.applyExtracted(
      [
        {
          scope: 'workspace',
          text: "User has expressed interest in non-PDF files related to 'timeSheet' or 'working hours', specifically Google Sheets with names like 'หางาน.gsheet'",
        },
      ],
      'D:\\my-work',
      'task-1',
    );

    service.applyExtracted(
      [
        {
          scope: 'workspace',
          text: "User has shown consistent interest in non-PDF files related to 'timeSheet' or 'working hours', with a specific preference for Google Sheets files named 'หางาน.gsheet'",
        },
      ],
      'D:\\my-work',
      'task-2',
    );

    expect(repository.add).toHaveBeenCalledTimes(1);
  });

  it('keeps two genuinely different memories in the same scope', () => {
    const { service, repository } = createService();
    service.applyExtracted(
      [{ scope: 'global', text: 'ชอบคำตอบสั้นกระชับ' }],
      'D:\\my-work',
      'task-1',
    );
    service.applyExtracted(
      [{ scope: 'global', text: 'ทำงานเป็น data engineer' }],
      'D:\\my-work',
      'task-2',
    );

    expect(repository.add).toHaveBeenCalledTimes(2);
  });

  it('prunes the oldest record in a scope once the cap is exceeded', () => {
    const { service } = createService({ maxPerScope: 2 });
    service.applyExtracted(
      [{ scope: 'global', text: 'fact one' }],
      'D:\\my-work',
      'task-1',
    );
    service.applyExtracted(
      [{ scope: 'global', text: 'fact two' }],
      'D:\\my-work',
      'task-1',
    );
    service.applyExtracted(
      [{ scope: 'global', text: 'fact three' }],
      'D:\\my-work',
      'task-1',
    );

    const remaining = service.getContextFor('D:\\my-work').map((r) => r.text);
    expect(remaining).toHaveLength(2);
    expect(remaining).not.toContain('fact one');
  });

  it('returns null from buildContextPrompt when there is nothing to say', () => {
    const { service } = createService();
    expect(service.buildContextPrompt([])).toBeNull();
  });

  it('truncates the context prompt to the configured character budget, in the given record order', () => {
    const { service } = createService({ contextMaxChars: 40 });
    const records: MemoryRecord[] = [
      {
        id: '1',
        scope: 'global',
        text: 'a'.repeat(30),
        createdAt: '2026-01-02T00:00:00.000Z',
        sourceTaskId: 'task-1',
      },
      {
        id: '2',
        scope: 'global',
        text: 'b'.repeat(30),
        createdAt: '2026-01-01T00:00:00.000Z',
        sourceTaskId: 'task-1',
      },
    ];

    const prompt = service.buildContextPrompt(records);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain('a'.repeat(30));
    expect(prompt).not.toContain('b'.repeat(30));
  });
});
