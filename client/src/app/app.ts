import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AssistantStore } from './core/state/assistant.store';
import { ChatWorkspace } from './features/chat/chat-workspace/chat-workspace';
import { WorkspacePanel } from './features/workspace/workspace-panel/workspace-panel';
import { Sidebar } from './layout/sidebar/sidebar';

@Component({
  selector: 'app-root',
  imports: [Sidebar, ChatWorkspace, WorkspacePanel],
  templateUrl: './app.html',
  host: { class: 'block min-h-dvh' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly store = inject(AssistantStore);
}
