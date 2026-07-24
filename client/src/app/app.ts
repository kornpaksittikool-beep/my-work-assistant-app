import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AssistantStore } from './core/state/assistant.store';
import { Sidebar } from './layout/sidebar/sidebar';

@Component({
  selector: 'app-root',
  imports: [Sidebar, RouterOutlet],
  templateUrl: './app.html',
  host: { class: 'block min-h-dvh' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly store = inject(AssistantStore);
}
