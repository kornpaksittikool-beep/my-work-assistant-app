import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { MemoryRecord } from './memory.types';

@Injectable()
export class MemoryRepository {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly dataFile: string;

  constructor(config: ConfigService) {
    this.dataFile =
      config.get<string>('MEMORY_DATA_FILE') ??
      join(process.cwd(), 'data', 'memory.json');
    try {
      let raw: string;
      try {
        raw = readFileSync(this.dataFile, 'utf8');
        JSON.parse(raw);
      } catch {
        raw = readFileSync(`${this.dataFile}.bak`, 'utf8');
      }
      const records = JSON.parse(raw) as MemoryRecord[];
      for (const record of records) this.records.set(record.id, record);
    } catch {
      // no persisted data yet (first run, or file missing/corrupt)
    }
  }

  findGlobal(): MemoryRecord[] {
    return [...this.records.values()].filter(
      (record) => record.scope === 'global',
    );
  }

  findForWorkspace(workspacePath: string): MemoryRecord[] {
    return [...this.records.values()].filter(
      (record) =>
        record.scope === 'workspace' && record.workspacePath === workspacePath,
    );
  }

  add(record: MemoryRecord): void {
    this.records.set(record.id, record);
    this.persist();
  }

  remove(id: string): void {
    this.records.delete(id);
    this.persist();
  }

  /** Same synchronous atomic-write-with-backup tradeoff as TasksRepository -
   * single user, low write frequency, no need for a real database. */
  private persist(): void {
    mkdirSync(dirname(this.dataFile), { recursive: true });
    const temporaryFile = `${this.dataFile}.tmp`;
    const backupFile = `${this.dataFile}.bak`;
    writeFileSync(temporaryFile, JSON.stringify([...this.records.values()]));
    if (existsSync(this.dataFile)) copyFileSync(this.dataFile, backupFile);
    try {
      renameSync(temporaryFile, this.dataFile);
    } catch {
      rmSync(this.dataFile, { force: true });
      renameSync(temporaryFile, this.dataFile);
    }
  }
}
