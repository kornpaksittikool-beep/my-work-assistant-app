import { computed, inject, Injectable, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { AssistantApiService } from '../api/assistant-api.service';
import { TaskEventsService } from '../api/task-events.service';
import { DEFAULT_WORKSPACE_PATH } from '../config/api.config';
import { ActivityItem } from '../models/assistant.models';
import type { AgentEvent, AssistantTask, ChatMessage, PermissionRequest, TaskStatus } from '@assistant-app/contracts';

@Injectable({ providedIn: 'root' })
export class AssistantStore {
  private readonly api = inject(AssistantApiService);
  private readonly taskEvents = inject(TaskEventsService);
  private eventsSubscription?: Subscription;
  private pendingStreamText = '';
  private streamFrame?: number;
  private workTimer?: ReturnType<typeof setInterval>;
  private workStartedAt = 0;

  readonly sidebarCollapsed = signal(false);
  readonly workspacePanelOpen = signal(false);
  readonly tasks = signal<AssistantTask[]>([]);
  readonly activeTaskId = signal<string | null>(null);
  readonly activities = signal<ActivityItem[]>([]);
  readonly streamingText = signal('');
  readonly pendingPermission = signal<PermissionRequest | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly activeModel = signal('กำลังโหลด...');
  readonly modelAvailable = signal<boolean | null>(null);
  readonly workingSeconds = signal(0);

  readonly activeTask = computed(() => this.tasks().find((task) => task.id === this.activeTaskId()) ?? null);
  readonly activeTaskTitle = computed(() => this.activeTask()?.title ?? 'งานใหม่');
  readonly messages = computed(() => this.activeTask()?.messages.filter((message) => message.role !== 'tool') ?? []);
  readonly isWorking = computed(() => this.activeTask()?.status === 'working');
  readonly canDeleteChat = computed(() => {
    const task = this.activeTask();
    return (
      !!task &&
      task.status !== 'working' &&
      task.status !== 'waiting_permission'
    );
  });
  readonly currentWork = computed(() => {
    if (this.pendingPermission()) return { label: 'กำลังรอการอนุญาต', detail: 'เลือกอนุญาตหรือปฏิเสธเพื่อทำงานต่อ' };
    if (this.streamingText()) return { label: 'กำลังสร้างคำตอบ', detail: 'กำลังรับข้อความจากโมเดล' };
    const activities = this.activities();
    const activity = [...activities].reverse().find((item) => item.state === 'working') ?? activities[activities.length - 1];
    if (activity) return { label: activity.label, detail: activity.detail };
    return { label: 'กำลังคิดและวางแผน', detail: 'ส่งคำขอไปยังโมเดลแล้ว' };
  });

  constructor() {
    this.refreshModel();
    this.loadTasks();
  }

  toggleSidebar(): void { this.sidebarCollapsed.update((value) => !value); }
  toggleWorkspacePanel(): void { this.workspacePanelOpen.update((value) => !value); }

  refreshModel(): void {
    this.modelAvailable.set(null);
    this.api.getHealth().subscribe({
      next: ({ data }) => {
        this.activeModel.set(data.ollama.model);
        this.modelAvailable.set(data.ollama.available);
      },
      error: () => {
        this.activeModel.set('ไม่ทราบโมเดล');
        this.modelAvailable.set(false);
      },
    });
  }

  loadTasks(): void {
    this.loading.set(true);
    this.api.listTasks().subscribe({
      next: ({ data }) => {
        this.tasks.set(data);
        this.loading.set(false);
        if (data.length > 0) this.selectTask(data[0].id);
        else this.newTask();
      },
      error: () => this.handleError('เชื่อมต่อ Assistant Service ไม่ได้'),
    });
  }

  selectTask(id: string): void {
    this.stopWorkTimer();
    this.workingSeconds.set(0);
    this.activeTaskId.set(id);
    this.activities.set([]);
    this.clearStreamingText();
    this.pendingPermission.set(null);
    this.subscribeToEvents(id);
    this.api.getTask(id).subscribe({ next: ({ data }) => this.upsertTask(data), error: () => this.handleError('โหลด task ไม่สำเร็จ') });
  }

  newTask(): void {
    this.api.createTask('งานใหม่', DEFAULT_WORKSPACE_PATH).subscribe({
      next: ({ data }) => {
        this.upsertTask(data, true);
        this.selectTask(data.id);
      },
      error: () => this.handleError('สร้าง task ไม่สำเร็จ'),
    });
  }

  sendMessage(content: string): void {
    const task = this.activeTask();
    const normalized = content.trim();
    if (!task || !normalized) return;
    const optimistic: ChatMessage = { id: `local-${Date.now()}`, role: 'user', content: normalized, createdAt: new Date().toISOString() };
    this.patchActiveTask({ ...task, status: 'working', messages: [...task.messages, optimistic] });
    this.startWorkTimer();
    this.activities.set([]);
    this.clearStreamingText();
    this.pendingPermission.set(null);
    this.error.set(null);
    this.api.sendMessage(task.id, normalized).subscribe({
      next: ({ data }) => this.upsertTask(data),
      error: () => {
        this.stopWorkTimer();
        this.removeMessage(optimistic.id);
        this.handleError('ส่งข้อความไม่สำเร็จ');
      },
    });
  }

  resolvePermission(allowed: boolean): void {
    const task = this.activeTask();
    const permission = this.pendingPermission();
    if (!task || !permission) return;
    this.api.resolvePermission(task.id, permission.id, allowed ? 'allow' : 'deny').subscribe({
      next: ({ data }) => {
        this.pendingPermission.set(null);
        this.upsertTask(data);
        this.addActivity('permission', allowed ? 'อนุญาตการอ่านแล้ว' : 'ปฏิเสธการเข้าถึง', 'เสร็จสิ้น', 'done');
      },
      error: () => this.handleError('บันทึก permission ไม่สำเร็จ'),
    });
  }

  stopWorking(): void {
    const task = this.activeTask();
    if (!task) return;
    this.api.stopTask(task.id).subscribe({ next: ({ data }) => this.upsertTask(data), error: () => this.handleError('หยุด task ไม่สำเร็จ') });
  }

  renameTask(id: string, title: string): void {
    const normalized = title.trim();
    if (!normalized) return;
    this.api.updateTask(id, { title: normalized }).subscribe({
      next: ({ data }) => this.upsertTask(data),
      error: () => this.handleError('เปลี่ยนชื่องานไม่สำเร็จ'),
    });
  }

  archiveTask(id: string): void {
    this.api.updateTask(id, { archived: true }).subscribe({
      next: () => this.removeTaskFromList(id),
      error: () => this.handleError('เก็บงานเข้าคลังไม่สำเร็จ'),
    });
  }

  deleteTask(id: string): void {
    this.api.deleteTask(id).subscribe({
      next: () => this.removeTaskFromList(id),
      error: () => this.handleError('ลบงานไม่สำเร็จ'),
    });
  }

  statusLabel(status: TaskStatus): string {
    return ({ idle: 'พร้อมเริ่ม', working: 'กำลังทำงาน', waiting_permission: 'รอการอนุญาต', completed: 'เสร็จแล้ว', stopped: 'หยุดแล้ว', failed: 'เกิดข้อผิดพลาด' })[status];
  }

  private subscribeToEvents(taskId: string): void {
    this.eventsSubscription?.unsubscribe();
    this.eventsSubscription = this.taskEvents.connect(taskId).subscribe({
      next: (event) => this.handleAgentEvent(event),
      error: () => this.error.set('อ่านข้อมูลจาก event stream ไม่สำเร็จ'),
    });
  }

  private handleAgentEvent(event: AgentEvent): void {
    if (event.taskId !== this.activeTaskId()) return;
    const payload = event.payload as Record<string, unknown>;
    if (event.type === 'status') {
      const status = String(payload['status']) as TaskStatus;
      this.patchStatus(status);
      // A 'working' status can restart the agent loop mid-task (e.g. the
      // service retrying a turn that answered without calling a tool) - any
      // text already streamed for the turn being restarted is stale, so
      // clear it rather than let the next attempt's deltas appear appended
      // after it.
      if (status === 'working') {
        // A replayed permission_required event may arrive first when the SSE
        // stream reconnects. A newer working status means that request was
        // already allowed, so it must not remain visible as pending.
        this.pendingPermission.set(null);
        this.startWorkTimer();
        this.clearStreamingText();
      } else if (status === 'completed' || status === 'stopped' || status === 'failed') {
        // ReplaySubject deliberately replays recent events after a reload.
        // Terminal task state is newer than any replayed permission request,
        // so clear the stale card instead of asking for the same decision again.
        this.pendingPermission.set(null);
        this.stopWorkTimer();
      }
    } else if (event.type === 'message_delta') {
      this.queueStreamDelta(String(payload['delta'] ?? ''));
    } else if (event.type === 'tool_started') {
      this.clearStreamingText();
      this.addActivity(event.id, `เรียก ${String(payload['tool'])}`, String(payload['path'] ?? ''), 'working');
    } else if (event.type === 'tool_completed') {
      this.completeWorkingActivity(`${String(payload['tool'])} เสร็จแล้ว`);
    } else if (event.type === 'permission_required') {
      this.patchStatus('waiting_permission');
      this.pendingPermission.set(payload['permission'] as PermissionRequest);
    } else if (event.type === 'message') {
      this.clearStreamingText();
      this.appendMessage(payload['message'] as ChatMessage);
      // The message now carries its own toolCalls log, so the live feed
      // used while this turn was in progress is redundant - drop it rather
      // than leaving it to linger under the finished message.
      this.activities.set([]);
    } else if (event.type === 'completed') {
      this.clearStreamingText();
      this.stopWorkTimer();
      this.finishWorkingActivities();
      this.patchStatus('completed');
    } else if (event.type === 'error') {
      this.clearStreamingText();
      this.stopWorkTimer();
      this.finishWorkingActivities('failed');
      this.patchStatus('failed');
      this.error.set(String(payload['message'] ?? 'Agent ทำงานไม่สำเร็จ'));
    }
  }

  private startWorkTimer(): void {
    if (this.workTimer !== undefined) return;
    this.workStartedAt = Date.now();
    this.workingSeconds.set(0);
    this.workTimer = setInterval(() => {
      this.workingSeconds.set(Math.floor((Date.now() - this.workStartedAt) / 1000));
    }, 250);
  }

  private stopWorkTimer(): void {
    if (this.workTimer !== undefined) clearInterval(this.workTimer);
    this.workTimer = undefined;
    if (this.workStartedAt) {
      this.workingSeconds.set(Math.floor((Date.now() - this.workStartedAt) / 1000));
    }
  }

  private queueStreamDelta(delta: string): void {
    if (!delta) return;
    this.pendingStreamText += delta;
    if (this.streamFrame !== undefined) return;

    // Coalesce token bursts into one paint. Updating the signal for every tiny
    // Ollama chunk causes unnecessary DOM work and makes the text look jittery.
    this.streamFrame = requestAnimationFrame(() => {
      const text = this.pendingStreamText;
      this.pendingStreamText = '';
      this.streamFrame = undefined;
      if (text) this.streamingText.update((current) => current + text);
    });
  }

  private clearStreamingText(): void {
    if (this.streamFrame !== undefined) cancelAnimationFrame(this.streamFrame);
    this.streamFrame = undefined;
    this.pendingStreamText = '';
    this.streamingText.set('');
  }

  private upsertTask(task: AssistantTask, first = false): void {
    this.tasks.update((tasks) => {
      const withoutTask = tasks.filter((item) => item.id !== task.id);
      return first ? [task, ...withoutTask] : withoutTask.length === tasks.length ? [task, ...tasks] : tasks.map((item) => item.id === task.id ? task : item);
    });
  }

  private patchActiveTask(task: AssistantTask): void { this.upsertTask(task); }
  private patchStatus(status: TaskStatus): void {
    const task = this.activeTask();
    if (task) this.patchActiveTask({ ...task, status, updatedAt: new Date().toISOString() });
  }
  private appendMessage(message: ChatMessage): void {
    const task = this.activeTask();
    if (!task || task.messages.some((item) => item.id === message.id)) return;
    this.patchActiveTask({ ...task, messages: [...task.messages, message] });
  }
  private removeMessage(id: string): void {
    const task = this.activeTask();
    if (task) this.patchActiveTask({ ...task, messages: task.messages.filter((message) => message.id !== id) });
  }
  private removeTaskFromList(id: string): void {
    const remaining = this.tasks().filter((task) => task.id !== id);
    this.tasks.set(remaining);
    if (this.activeTaskId() === id) {
      if (remaining.length > 0) this.selectTask(remaining[0].id);
      else this.newTask();
    }
  }
  private addActivity(id: string, label: string, detail: string, state: ActivityItem['state']): void {
    if (this.activities().some((activity) => activity.id === id)) return;
    this.activities.update((activities) => [...activities, { id, label, detail, state }]);
  }
  private finishWorkingActivities(state: ActivityItem['state'] = 'done'): void {
    this.activities.update((activities) => activities.map((activity) => activity.state === 'working' ? { ...activity, state, detail: state === 'done' ? 'เสร็จสิ้น' : 'ไม่สำเร็จ' } : activity));
  }
  private completeWorkingActivity(label: string): void {
    this.activities.update((activities) => {
      const indexFromEnd = [...activities].reverse().findIndex((activity) => activity.state === 'working');
      if (indexFromEnd === -1) return activities;
      const index = activities.length - 1 - indexFromEnd;
      const updated = [...activities];
      updated[index] = { ...updated[index], label, detail: 'เสร็จสิ้น', state: 'done' };
      return updated;
    });
  }
  private handleError(message: string): void { this.loading.set(false); this.error.set(message); }
}
