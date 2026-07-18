import { ChildProcess, spawn } from 'child_process';
import { existsSync } from 'fs';
import { NotFoundException } from '@nestjs/common';
import { FilesService } from './files.service';

jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  existsSync: jest.fn(),
}));

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

describe('FilesService', () => {
  const existsSyncMock = existsSync as jest.MockedFunction<typeof existsSync>;
  const spawnMock = spawn as jest.MockedFunction<typeof spawn>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws NotFoundException when the requested path does not exist', () => {
    existsSyncMock.mockReturnValue(false);

    expect(() => new FilesService().open('C:\\missing.txt')).toThrow(
      NotFoundException,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('opens Explorer with the existing path selected', () => {
    existsSyncMock.mockReturnValue(true);
    const child = { unref: jest.fn() } as unknown as ChildProcess;
    spawnMock.mockReturnValue(child);

    new FilesService().open('C:\\My Files\\report.txt');

    expect(spawnMock).toHaveBeenCalledWith(
      'explorer.exe',
      ['/select,"C:\\My Files\\report.txt"'],
      {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      },
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
  });
});
