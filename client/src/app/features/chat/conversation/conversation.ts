import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, inject, viewChild } from '@angular/core';
import { AssistantStore } from '../../../core/state/assistant.store';
import { MarkdownPipe } from '../../../core/pipes/markdown.pipe';
import { PermissionCard } from '../../permissions/permission-card/permission-card';
import { ActivityList } from '../activity-list/activity-list';
import { ChatMessage } from '../../../core/models/assistant.models';
import { formatLocalTime } from '../../../core/utils/date-time';

/** How close to the bottom (px) still counts as "at the bottom" for
 * auto-scroll purposes - a little slack so a fraction-of-a-pixel rounding
 * difference doesn't stop the view from following new content. */
const STICK_TO_BOTTOM_THRESHOLD_PX = 80;

@Component({
  selector: 'app-conversation',
  imports: [ActivityList, PermissionCard, MarkdownPipe],
  templateUrl: './conversation.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Conversation {
  protected readonly store = inject(AssistantStore);
  protected readonly formatLocalTime = formatLocalTime;
  private readonly http = inject(HttpClient);
  private readonly scrollContainer = viewChild<ElementRef<HTMLElement>>('scrollContainer');

  /** Whether the user was already at (or near) the bottom before new content
   * rendered. New messages/activity/permission cards only auto-scroll into
   * view while this is true - not while the user has scrolled up to read
   * earlier history, so a background reply can't yank their scroll
   * position away mid-read. */
  private stickToBottom = true;

  constructor() {
    // afterRenderEffect (not a plain effect) so the scroll happens once the
    // DOM has actually been updated with the new content - a plain effect's
    // callback can run before change detection has painted the @for/@if
    // additions, which would scroll to the *previous* scrollHeight.
    afterRenderEffect(() => {
      this.store.messages().length;
      this.store.streamingText();
      this.store.activities().length;
      // A pending permission blocks the whole agent run on the user's
      // decision, so it always scrolls into view - unlike an ordinary new
      // message, there's no reasonable case for leaving it hidden while the
      // user reads older history, since nothing proceeds until they act on
      // it either way.
      const awaitingDecision = this.store.pendingPermission() !== null;
      if (this.stickToBottom || awaitingDecision) this.scrollToBottom();
    });
  }

  protected onScroll(event: Event): void {
    const el = event.target as HTMLElement;
    this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_THRESHOLD_PX;
  }

  /** "used N tools" should count actual scan_directory/search_files calls
   * only, not the permission allow/deny decision that's logged alongside
   * them in the same list. */
  protected toolCallCount(message: ChatMessage): number {
    return (message.toolCalls ?? []).filter((call) => call.kind !== 'permission').length;
  }

  protected hasVerifiedFileMetadata(message: ChatMessage): boolean {
    return (message.toolCalls ?? []).some(
      (call) => call.kind === 'tool' && call.state === 'done',
    );
  }

  protected hasReadFileEvidence(message: ChatMessage): boolean {
    return (message.toolCalls ?? []).some(
      (call) =>
        call.kind === 'tool' &&
        call.state === 'done' &&
        call.label.includes('read_file'),
    );
  }

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
    this.http.get(href).subscribe({
      error: () =>
        this.store.error.set(
          'เปิดไฟล์ไม่สำเร็จ ไฟล์อาจถูกย้าย ลบ หรือไม่สามารถเข้าถึงได้แล้ว',
        ),
    });
  }

  private scrollToBottom(): void {
    const el = this.scrollContainer()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }
}
