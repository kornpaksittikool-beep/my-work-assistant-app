import { computed, inject, Injectable, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { AssistantApiService } from '../api/assistant-api.service';
import { TaskEventsService } from '../api/task-events.service';
import { DEFAULT_WORKSPACE_PATH } from '../config/api.config';
import { ActivityItem, AgentEvent, AssistantTask, ChatMessage, PermissionRequest, TaskStatus } from '../models/assistant.models';

@Injectable({ providedIn: 'root' })
export class AssistantStore {
  private readonly api = inject(AssistantApiService);
  private readonly taskEvents = inject(TaskEventsService);
  private eventsSubscription?: Subscription;

  readonly sidebarCollapsed = signal(false);
  readonly workspacePanelOpen = signal(false);
  readonly tasks = signal<AssistantTask[]>([]);
  readonly activeTaskId = signal<string | null>(null);
  readonly activities = signal<ActivityItem[]>([]);
  readonly pendingPermission = signal<PermissionRequest | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly activeTask = computed(() => this.tasks().find((task) => task.id === this.activeTaskId()) ?? null);
  readonly activeTaskTitle = computed(() => this.activeTask()?.title ?? 'งานใหม่');
  readonly messages = computed(() => this.activeTask()?.messages.filter((message) => message.role !== 'tool') ?? []);
  readonly isWorking = computed(() => this.activeTask()?.status === 'working');

  constructor() { this.loadTasks(); }

  toggleSidebar(): void { this.sidebarCollapsed.update((value) => !value); }
  toggleWorkspacePanel(): void { this.workspacePanelOpen.update((value) => !value); }

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
    this.activeTaskId.set(id);
    this.activities.set([]);
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
    this.error.set(null);
    this.api.sendMessage(task.id, normalized).subscribe({
      next: ({ data }) => this.upsertTask(data),
      error: () => {
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
      this.patchStatus(String(payload['status']) as TaskStatus);
      this.addActivity(event.id, String(payload['text'] ?? 'อัปเดตสถานะ'), this.statusLabel(String(payload['status']) as TaskStatus), 'working');
    } else if (event.type === 'tool_started') {
      this.addActivity(event.id, `เรียก ${String(payload['tool'])}`, String(payload['path'] ?? ''), 'working');
    } else if (event.type === 'tool_completed') {
      this.finishWorkingActivities();
      this.addActivity(event.id, `${String(payload['tool'])} เสร็จแล้ว`, String(payload['path'] ?? ''), 'done');
    } else if (event.type === 'permission_required') {
      this.patchStatus('waiting_permission');
      this.pendingPermission.set(payload['permission'] as PermissionRequest);
    } else if (event.type === 'message') {
      this.appendMessage(payload['message'] as ChatMessage);
    } else if (event.type === 'completed') {
      this.finishWorkingActivities();
      this.patchStatus('completed');
    } else if (event.type === 'error') {
      this.finishWorkingActivities('failed');
      this.patchStatus('failed');
      this.error.set(String(payload['message'] ?? 'Agent ทำงานไม่สำเร็จ'));
    }
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
  private addActivity(id: string, label: string, detail: string, state: ActivityItem['state']): void {
    if (this.activities().some((activity) => activity.id === id)) return;
    this.activities.update((activities) => [...activities, { id, label, detail, state }]);
  }
  private finishWorkingActivities(state: ActivityItem['state'] = 'done'): void {
    this.activities.update((activities) => activities.map((activity) => activity.state === 'working' ? { ...activity, state, detail: state === 'done' ? 'เสร็จสิ้น' : 'ไม่สำเร็จ' } : activity));
  }
  private handleError(message: string): void { this.loading.set(false); this.error.set(message); }
}
