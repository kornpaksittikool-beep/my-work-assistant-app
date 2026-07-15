import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class FilesService {
  open(path: string): void {
    if (!existsSync(path)) {
      throw new NotFoundException('ไม่พบไฟล์หรือโฟลเดอร์ที่ระบุ');
    }
    // /select, opens Explorer at the file's parent folder with the file
    // highlighted, rather than launching the file with its default app.
    // explorer.exe only accepts this when the path (not the /select, prefix)
    // is quoted - Node's default argument quoting wraps the whole
    // "/select,<path>" string instead, which explorer.exe doesn't recognize
    // (it silently falls back to opening the default Home/Documents view).
    // windowsVerbatimArguments passes our own quoting through untouched.
    // explorer.exe's exit code is unreliable even on success, so fire-and-forget
    // rather than await/inspect it.
    spawn('explorer.exe', [`/select,"${path}"`], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    }).unref();
  }
}
