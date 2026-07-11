import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AssistantStore } from '../../../core/state/assistant.store';
import { PermissionCard } from '../../permissions/permission-card/permission-card';
import { ActivityList } from '../activity-list/activity-list';

@Component({
  selector: 'app-conversation',
  imports: [ActivityList, PermissionCard],
  templateUrl: './conversation.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Conversation {
  protected readonly store = inject(AssistantStore);
}
