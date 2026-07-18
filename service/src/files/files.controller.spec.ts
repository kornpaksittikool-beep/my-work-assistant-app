import { FilesController } from './files.controller';
import { FilesService } from './files.service';

describe('FilesController', () => {
  it('opens the requested path and returns a success response', () => {
    const files = { open: jest.fn() } as unknown as FilesService;
    const controller = new FilesController(files);

    expect(controller.open({ path: 'C:\\report.txt' })).toEqual({
      opened: true,
    });
    expect(files.open).toHaveBeenCalledWith('C:\\report.txt');
  });
});
