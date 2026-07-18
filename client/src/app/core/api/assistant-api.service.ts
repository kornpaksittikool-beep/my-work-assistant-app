import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { API_BASE_URL } from '../config/api.config';
import { ApiEnvelope, AssistantTask, HealthStatus } from '../models/assistant.models';

@Injectable({ providedIn: 'root' })
export class AssistantApiService {
  private readonly http = inject(HttpClient);

  getHealth(): Observable<ApiEnvelope<HealthStatus>> {
    return this.http.get<ApiEnvelope<HealthStatus>>(`${API_BASE_URL}/health`);
  }

  listTasks(): Observable<ApiEnvelope<AssistantTask[]>> {
    return this.http.get<ApiEnvelope<AssistantTask[]>>(`${API_BASE_URL}/tasks`);
  }

  getTask(id: string): Observable<ApiEnvelope<AssistantTask>> {
    return this.http.get<ApiEnvelope<AssistantTask>>(`${API_BASE_URL}/tasks/${id}`);
  }

  createTask(title: string, workspacePath: string): Observable<ApiEnvelope<AssistantTask>> {
    return this.http.post<ApiEnvelope<AssistantTask>>(`${API_BASE_URL}/tasks`, { title, workspacePath });
  }

  sendMessage(taskId: string, content: string): Observable<ApiEnvelope<AssistantTask>> {
    return this.http.post<ApiEnvelope<AssistantTask>>(`${API_BASE_URL}/tasks/${taskId}/messages`, { content });
  }

  resolvePermission(taskId: string, permissionId: string, decision: 'allow' | 'deny'): Observable<ApiEnvelope<AssistantTask>> {
    return this.http.post<ApiEnvelope<AssistantTask>>(`${API_BASE_URL}/tasks/${taskId}/permissions/${permissionId}`, { decision });
  }

  stopTask(taskId: string): Observable<ApiEnvelope<AssistantTask>> {
    return this.http.post<ApiEnvelope<AssistantTask>>(`${API_BASE_URL}/tasks/${taskId}/stop`, {});
  }

  updateTask(
    taskId: string,
    changes: { title?: string; archived?: boolean },
  ): Observable<ApiEnvelope<AssistantTask>> {
    return this.http.patch<ApiEnvelope<AssistantTask>>(
      `${API_BASE_URL}/tasks/${taskId}`,
      changes,
    );
  }

  deleteTask(taskId: string): Observable<ApiEnvelope<AssistantTask>> {
    return this.http.delete<ApiEnvelope<AssistantTask>>(
      `${API_BASE_URL}/tasks/${taskId}`,
    );
  }
}
