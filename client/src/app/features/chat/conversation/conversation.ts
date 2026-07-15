import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AssistantStore } from '../../../core/state/assistant.store';
import { MarkdownPipe } from '../../../core/pipes/markdown.pipe';
import { PermissionCard } from '../../permissions/permission-card/permission-card';
import { ActivityList } from '../activity-list/activity-list';

@Component({
  selector: 'app-conversation',
  imports: [ActivityList, PermissionCard, MarkdownPipe],
  templateUrl: './conversation.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Conversation {
  protected readonly store = inject(AssistantStore);
  private readonly http = inject(HttpClient);

  /**
   * Message content is rendered via [innerHTML], so links to the file-open
   * endpoint are plain <a> tags. Intercept them here instead of letting the
   * browser navigate away from the SPA to a bare JSON response.
   */
  protected onContentClick(event: MouseEvent): void {
    const anchor = (event.target as HTMLElement).closest('a');
    const href = anchor?.getAttribute('href');
    if (!href || !href.includes('/api/files/open')) return;
    event.preventDefault();
    this.http.get(href).subscribe({ error: () => undefined });
  }
}
