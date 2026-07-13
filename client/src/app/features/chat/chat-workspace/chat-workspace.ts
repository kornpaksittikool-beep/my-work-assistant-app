import { ChangeDetectionStrategy, Component } from '@angular/core';
import { WorkspaceHeader } from '../../workspace/workspace-header/workspace-header';
import { Composer } from '../composer/composer';
import { Conversation } from '../conversation/conversation';

@Component({
  selector: 'app-chat-workspace',
  imports: [WorkspaceHeader, Conversation, Composer],
  template: '<main class="flex min-h-dvh min-w-0 flex-col"><app-workspace-header /><app-conversation /><app-composer /></main>',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatWorkspace {}
