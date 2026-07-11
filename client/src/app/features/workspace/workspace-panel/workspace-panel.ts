import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AssistantStore } from '../../../core/state/assistant.store';

@Component({
  selector: 'app-workspace-panel',
  templateUrl: './workspace-panel.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspacePanel {
  protected readonly store = inject(AssistantStore);
}
