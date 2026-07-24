import { Routes } from '@angular/router';
import { ChatWorkspace } from './features/chat/chat-workspace/chat-workspace';
import { SettingsPage } from './features/settings/settings-page/settings-page';

export const routes: Routes = [
  { path: '', component: ChatWorkspace },
  { path: 'settings', component: SettingsPage },
];
