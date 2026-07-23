import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AssistantStore } from './core/state/assistant.store';
import { ChatWorkspace } from './features/chat/chat-workspace/chat-workspace';
import { Sidebar } from './layout/sidebar/sidebar';

@Component({
  selector: 'app-root',
  imports: [Sidebar, ChatWorkspace],
  templateUrl: './app.html',
  host: { class: 'block min-h-dvh' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly store = inject(AssistantStore);
}
