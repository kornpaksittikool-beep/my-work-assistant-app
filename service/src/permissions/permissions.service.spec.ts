import { NotFoundException } from '@nestjs/common';
import { PermissionsService } from './permissions.service';

describe('PermissionsService', () => {
  it('creates and resolves a permission request as allowed', () => {
    const service = new PermissionsService();
    const request = service.create('task-1', 'D:\\shared');
    expect(request.status).toBe('pending');
    expect(service.resolve(request.id, true).status).toBe('allowed');
  });

  it('resolves a permission request as denied', () => {
    const service = new PermissionsService();
    const request = service.create('task-1', 'D:\\shared');
    expect(service.resolve(request.id, false).status).toBe('denied');
  });

  it('throws when finding an unknown permission request', () => {
    const service = new PermissionsService();
    expect(() => service.findOne('missing')).toThrow(NotFoundException);
  });
});
