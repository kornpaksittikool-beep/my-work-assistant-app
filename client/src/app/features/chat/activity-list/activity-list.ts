import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { ActivityItem } from '../../../core/models/assistant.models';

@Component({
  selector: 'app-activity-list',
  templateUrl: './activity-list.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActivityList {
  readonly activities = input.required<ActivityItem[]>();
}
