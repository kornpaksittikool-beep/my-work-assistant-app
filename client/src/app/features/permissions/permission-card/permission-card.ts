import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AssistantStore } from '../../../core/state/assistant.store';

@Component({
  selector: 'app-permission-card',
  templateUrl: './permission-card.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PermissionCard {
  protected readonly store = inject(AssistantStore);
}
