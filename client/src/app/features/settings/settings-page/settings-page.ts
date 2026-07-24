import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ScanRoot, ScanRootBrowseEntry } from '@assistant-app/contracts';
import { AssistantApiService } from '../../../core/api/assistant-api.service';

@Component({
  selector: 'app-settings-page',
  imports: [RouterLink],
  templateUrl: './settings-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  private readonly api = inject(AssistantApiService);

  protected readonly roots = signal<ScanRoot[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly pendingPath = signal<string | null>(null);

  protected readonly browserOpen = signal(false);
  protected readonly browsePath = signal<string | null>(null);
  protected readonly browseParent = signal<string | null>(null);
  protected readonly browseEntries = signal<ScanRootBrowseEntry[]>([]);
  protected readonly browseLoading = signal(false);
  protected readonly browseError = signal<string | null>(null);
  protected readonly addingCurrentFolder = signal(false);

  /** Bumped on every loadBrowse() call so a slow, superseded response can be
   * dropped instead of overwriting what a later click already requested. */
  private browseRequestSeq = 0;

  constructor() {
    this.refresh();
  }

  protected removeRoot(root: ScanRoot): void {
    if (this.pendingPath()) return;
    this.pendingPath.set(root.path);
    this.api.removeScanRoot(root.path).subscribe({
      next: () => {
        this.pendingPath.set(null);
        this.refresh();
      },
      error: () => {
        this.pendingPath.set(null);
        this.error.set(`นำ ${root.path} ออกไม่สำเร็จ`);
      },
    });
  }

  protected openBrowser(): void {
    this.browserOpen.set(true);
    this.browseError.set(null);
    this.loadBrowse(null);
  }

  protected closeBrowser(): void {
    this.browserOpen.set(false);
  }

  protected navigateInto(entry: ScanRootBrowseEntry): void {
    if (!entry.accessible) return;
    this.loadBrowse(entry.path);
  }

  protected navigateUp(): void {
    this.loadBrowse(this.browseParent());
  }

  protected navigateToDrives(): void {
    this.loadBrowse(null);
  }

  protected addCurrentFolder(): void {
    const path = this.browsePath();
    if (!path || this.addingCurrentFolder()) return;
    this.addingCurrentFolder.set(true);
    this.api.addScanRoot(path).subscribe({
      next: () => {
        this.addingCurrentFolder.set(false);
        this.browserOpen.set(false);
        this.refresh();
      },
      error: () => {
        this.addingCurrentFolder.set(false);
        this.browseError.set(`เพิ่มโฟลเดอร์นี้ไม่สำเร็จ`);
      },
    });
  }

  private loadBrowse(path: string | null): void {
    const requestId = ++this.browseRequestSeq;
    this.browseLoading.set(true);
    this.browseError.set(null);
    this.api.browseScanRoots(path ?? undefined).subscribe({
      next: (res) => {
        if (requestId !== this.browseRequestSeq) return;
        this.browsePath.set(res.data.path);
        this.browseParent.set(res.data.parent);
        this.browseEntries.set(res.data.entries);
        this.browseLoading.set(false);
      },
      error: () => {
        if (requestId !== this.browseRequestSeq) return;
        this.browseError.set('เปิดโฟลเดอร์นี้ไม่สำเร็จ');
        this.browseLoading.set(false);
      },
    });
  }

  private refresh(): void {
    this.loading.set(true);
    this.api.listScanRoots().subscribe({
      next: (res) => {
        this.roots.set(res.data);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('โหลดรายการโฟลเดอร์ที่อนุญาตไม่สำเร็จ');
        this.loading.set(false);
      },
    });
  }
}
