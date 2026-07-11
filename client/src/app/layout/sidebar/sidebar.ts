import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AssistantStore } from '../../core/state/assistant.store';

@Component({
  selector: 'app-sidebar',
  templateUrl: './sidebar.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Sidebar {
  protected readonly store = inject(AssistantStore);
}
