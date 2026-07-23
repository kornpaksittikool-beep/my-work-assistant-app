import type { MemoryScope } from '@assistant-app/contracts';

export interface ExtractedMemoryCandidate {
  scope: MemoryScope;
  text: string;
}
