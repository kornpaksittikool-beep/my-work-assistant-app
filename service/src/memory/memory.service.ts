import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { MemoryRepository } from './memory.repository';
import { ExtractedMemoryCandidate, MemoryRecord } from './memory.types';

const NEAR_DUPLICATE_WORD_OVERLAP = 0.6;

function wordsOf(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 0),
  );
}

/**
 * A small model asked to write a "new" fact sometimes just paraphrases a
 * memory already given to it as existing context instead of recognizing
 * nothing new happened this turn (observed: two records about the same
 * timesheet-file interest, worded differently, both got stored). Exact
 * string matching alone doesn't catch that - compare word overlap instead.
 */
function isNearDuplicateText(a: string, b: string): boolean {
  const wordsA = wordsOf(a);
  const wordsB = wordsOf(b);
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  let shared = 0;
  for (const word of wordsA) if (wordsB.has(word)) shared++;
  return (
    shared / Math.min(wordsA.size, wordsB.size) >= NEAR_DUPLICATE_WORD_OVERLAP
  );
}

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
      if (existing.some((record) => isNearDuplicateText(record.text, text))) {
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
