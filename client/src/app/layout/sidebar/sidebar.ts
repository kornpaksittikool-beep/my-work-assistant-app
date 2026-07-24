import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AssistantStore } from '../../core/state/assistant.store';
import { formatLocalTime } from '../../core/utils/date-time';

@Component({
  selector: 'app-sidebar',
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './sidebar.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Sidebar {
  protected readonly store = inject(AssistantStore);
  protected readonly formatLocalTime = formatLocalTime;
  protected readonly searchText = signal('');
  protected readonly filteredTasks = computed(() => {
    const query = this.searchText().trim().toLowerCase();
    return query
      ? this.store.tasks().filter((task) => task.title.toLowerCase().includes(query))
      : this.store.tasks();
  });

  protected renameTask(event: Event, id: string, title: string): void {
    event.stopPropagation();
    const next = window.prompt('เปลี่ยนชื่องาน', title);
    if (next !== null) this.store.renameTask(id, next);
  }

  protected archiveTask(event: Event, id: string): void {
    event.stopPropagation();
    this.store.archiveTask(id);
  }

  protected deleteTask(event: Event, id: string, title: string): void {
    event.stopPropagation();
    if (window.confirm(`ลบงาน “${title}” และประวัติทั้งหมดหรือไม่?`)) {
      this.store.deleteTask(id);
    }
  }

  protected clearAllHistory(): void {
    if (window.confirm('เคลียร์ประวัติแชททั้งหมดหรือไม่? การทำรายการนี้ย้อนกลับไม่ได้')) {
      this.store.deleteAllTasks();
    }
  }
}
