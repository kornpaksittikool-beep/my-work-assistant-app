import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { PermissionRequest } from '@assistant-app/contracts';

@Injectable()
export class PermissionsService {
  private readonly requests = new Map<string, PermissionRequest>();

  create(taskId: string, path: string): PermissionRequest {
    const request: PermissionRequest = {
      id: randomUUID(),
      taskId,
      path,
      action: 'read_directory',
      access: 'read',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.requests.set(request.id, request);
    return request;
  }

  findOne(id: string): PermissionRequest {
    const request = this.requests.get(id);
    if (!request)
      throw new NotFoundException(`Permission request not found: ${id}`);
    return request;
  }

  resolve(id: string, allowed: boolean): PermissionRequest {
    const request = this.findOne(id);
    request.status = allowed ? 'allowed' : 'denied';
    request.resolvedAt = new Date().toISOString();
    return request;
  }
}
