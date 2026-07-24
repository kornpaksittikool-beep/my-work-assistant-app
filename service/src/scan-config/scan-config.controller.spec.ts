import { Test, TestingModule } from '@nestjs/testing';
import { ScanConfigClientService } from './scan-config-client.service';
import { ScanConfigController } from './scan-config.controller';

describe('ScanConfigController', () => {
  let controller: ScanConfigController;
  let client: {
    listRoots: jest.Mock;
    browse: jest.Mock;
    addRoot: jest.Mock;
    removeRoot: jest.Mock;
  };

  beforeEach(async () => {
    client = {
      listRoots: jest.fn(),
      browse: jest.fn(),
      addRoot: jest.fn(),
      removeRoot: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ScanConfigController],
      providers: [{ provide: ScanConfigClientService, useValue: client }],
    }).compile();

    controller = module.get<ScanConfigController>(ScanConfigController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('list() delegates to ScanConfigClientService.listRoots', async () => {
    const roots = [{ path: 'D:\\', accessible: true }];
    client.listRoots.mockResolvedValue(roots);

    await expect(controller.list()).resolves.toBe(roots);
  });

  it('browse() delegates to ScanConfigClientService.browse with the query path', async () => {
    const result = { path: null, parent: null, entries: [] };
    client.browse.mockResolvedValue(result);

    await expect(controller.browse({ path: 'D:\\' })).resolves.toBe(result);
    expect(client.browse).toHaveBeenCalledWith('D:\\');
  });

  it('add() delegates to ScanConfigClientService.addRoot with the DTO path', async () => {
    const entry = { path: 'D:\\', accessible: true };
    client.addRoot.mockResolvedValue(entry);

    await expect(controller.add({ path: 'D:\\' })).resolves.toBe(entry);
    expect(client.addRoot).toHaveBeenCalledWith('D:\\');
  });

  it('remove() delegates to ScanConfigClientService.removeRoot with the DTO path', async () => {
    const roots = [{ path: 'C:\\', accessible: true }];
    client.removeRoot.mockResolvedValue(roots);

    await expect(controller.remove({ path: 'D:\\' })).resolves.toBe(roots);
    expect(client.removeRoot).toHaveBeenCalledWith('D:\\');
  });
});
