import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AssistantStore } from '../../../core/state/assistant.store';

@Component({
  selector: 'app-composer',
  imports: [FormsModule],
  templateUrl: './composer.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Composer {
  protected readonly store = inject(AssistantStore);
  protected draft = '';

  protected send(): void {
    if (!this.draft.trim() || this.store.isWorking()) return;
    this.store.sendMessage(this.draft);
    this.draft = '';
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.send();
    }
  }
}
