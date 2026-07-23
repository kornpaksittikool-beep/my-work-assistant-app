import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { MemoryRepository } from './memory.repository';
import { ExtractedMemoryCandidate, MemoryRecord } from './memory.types';

@Injectable()
export class MemoryService {
  private readonly maxRecordsPerScope: number;
  private readonly contextMaxChars: number;

  constructor(
    private readonly repository: MemoryRepository,
    config: ConfigService,
  ) {
    this.maxRecordsPerScope =
      config.get<number>('MEMORY_MAX_RECORDS_PER_SCOPE') ?? 40;
    this.contextMaxChars =
      config.get<number>('MEMORY_CONTEXT_MAX_CHARS') ?? 1200;
  }

  getContextFor(workspacePath: string): MemoryRecord[] {
    return [
      ...this.repository.findGlobal(),
      ...this.repository.findForWorkspace(workspacePath),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  buildContextPrompt(records: MemoryRecord[]): string | null {
    if (records.length === 0) return null;
    const lines: string[] = [];
    let usedChars = 0;
    for (const record of records) {
      const line = `- ${record.text}`;
      if (usedChars + line.length > this.contextMaxChars) break;
      lines.push(line);
      usedChars += line.length;
    }
    if (lines.length === 0) return null;
    return `Remembered context from previous sessions (do not repeat this list back to the user verbatim, just use it):\n${lines.join('\n')}`;
  }

  applyExtracted(
    candidates: ExtractedMemoryCandidate[],
    workspacePath: string,
    sourceTaskId: string,
  ): void {
    for (const candidate of candidates) {
      const text = candidate.text?.trim();
      if (!text) continue;
      const scope = candidate.scope === 'global' ? 'global' : 'workspace';
      const existing =
        scope === 'global'
          ? this.repository.findGlobal()
          : this.repository.findForWorkspace(workspacePath);
      const normalized = text.toLowerCase();
      if (
        existing.some(
          (record) => record.text.trim().toLowerCase() === normalized,
        )
      ) {
        continue;
      }
      this.repository.add({
        id: randomUUID(),
        scope,
        workspacePath: scope === 'workspace' ? workspacePath : undefined,
        text,
        createdAt: new Date().toISOString(),
        sourceTaskId,
      });
      this.pruneScope(scope, workspacePath);
    }
  }

  private pruneScope(
    scope: 'global' | 'workspace',
    workspacePath: string,
  ): void {
    const records = (
      scope === 'global'
        ? this.repository.findGlobal()
        : this.repository.findForWorkspace(workspacePath)
    ).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const excess = records.length - this.maxRecordsPerScope;
    if (excess <= 0) return;
    for (const record of records.slice(0, excess)) {
      this.repository.remove(record.id);
    }
  }
}
