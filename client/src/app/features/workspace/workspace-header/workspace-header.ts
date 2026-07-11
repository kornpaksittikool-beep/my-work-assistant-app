import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AssistantStore } from '../../../core/state/assistant.store';

@Component({
  selector: 'app-workspace-header',
  templateUrl: './workspace-header.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceHeader {
  protected readonly store = inject(AssistantStore);
}
