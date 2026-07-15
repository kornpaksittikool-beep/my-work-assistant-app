import { ChangeDetectionStrategy, Component } from '@angular/core';
import { WorkspaceHeader } from '../../workspace/workspace-header/workspace-header';
import { Composer } from '../composer/composer';
import { Conversation } from '../conversation/conversation';

@Component({
  selector: 'app-chat-workspace',
  imports: [WorkspaceHeader, Conversation, Composer],
  template: '<main class="flex h-dvh min-w-0 flex-col overflow-hidden max-[620px]:h-[calc(100dvh-55px)]"><app-workspace-header class="shrink-0" /><app-conversation class="min-h-0 flex-1 overflow-hidden" /><app-composer class="shrink-0" /></main>',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatWorkspace {}
