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
