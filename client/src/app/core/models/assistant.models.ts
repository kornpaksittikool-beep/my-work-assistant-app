export interface HealthStatus {
  status: 'ok';
  service: string;
  ollama: { available: boolean; model: string };
  timestamp: string;
}

export interface ActivityItem {
  id: string;
  label: string;
  detail: string;
  state: 'done' | 'working' | 'queued' | 'failed';
  /** Distinguishes an actual scan_directory/search_files call from a
   * permission allow/deny decision, so "used N tools" on a persisted message
   * can count real tool invocations only. Optional because it's only set on
   * server-provided/permission entries - not required for local UI-only uses
   * of ActivityItem. */
  kind?: 'tool' | 'permission';
}
