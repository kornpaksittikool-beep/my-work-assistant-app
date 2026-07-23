import type { MemoryRecord } from '@assistant-app/contracts';
import { MemoryController } from './memory.controller';
import { MemoryService } from './memory.service';

describe('MemoryController', () => {
  const record: MemoryRecord = {
    id: 'mem-1',
    scope: 'global',
    text: 'ชอบคำตอบสั้นกระชับ',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceTaskId: 'task-1',
  };

  const createController = () => {
    const memory = {
      listAll: jest.fn().mockReturnValue([record]),
      remove: jest.fn(),
    } as unknown as MemoryService;
    return { controller: new MemoryController(memory), memory };
  };

  it('lists all memories', () => {
    const { controller } = createController();

    expect(controller.findAll()).toEqual([record]);
  });

  it('deletes a memory and returns the remaining list', () => {
    const { controller, memory } = createController();

    expect(controller.remove('mem-1')).toEqual([record]);
    expect(memory.remove).toHaveBeenCalledWith('mem-1');
  });
});
