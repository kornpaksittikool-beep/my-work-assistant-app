// Mirrors ../../../contracts/src/permission.ts — keep in sync until cross-package imports are wired up.
export interface PermissionRequest {
  id: string;
  taskId: string;
  action: 'read_directory';
  path: string;
  access: 'read';
  status: 'pending' | 'allowed' | 'denied';
  createdAt: string;
  resolvedAt?: string;
}
