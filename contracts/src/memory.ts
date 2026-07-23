export type MemoryScope = 'global' | 'workspace';

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  /** Set iff scope === 'workspace'. */
  workspacePath?: string;
  text: string;
  createdAt: string;
  sourceTaskId: string;
}
