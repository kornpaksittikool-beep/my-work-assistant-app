import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { AssistantStore } from '../../../core/state/assistant.store';

@Component({
  selector: 'app-workspace-header',
  templateUrl: './workspace-header.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceHeader {
  protected readonly store = inject(AssistantStore);
  protected readonly isDeleteConfirmationOpen = signal(false);

  protected requestDeleteChat(): void {
    if (this.store.canDeleteChat()) {
      this.isDeleteConfirmationOpen.set(true);
    }
  }

  protected cancelDeleteChat(): void {
    this.isDeleteConfirmationOpen.set(false);
  }

  protected confirmDeleteChat(): void {
    const task = this.store.activeTask();
    if (!task || !this.store.canDeleteChat()) {
      this.cancelDeleteChat();
      return;
    }

    this.isDeleteConfirmationOpen.set(false);
    this.store.deleteTask(task.id);
  }
}
