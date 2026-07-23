import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { AgentService, SEARCH_EVERYWHERE_LABEL } from './agent.service';
import { TasksRepository } from '../tasks/tasks.repository';
import { TaskEventsService } from '../tasks/task-events.service';
import { OllamaService } from '../ollama/ollama.service';
import { McpClientService } from '../mcp/mcp-client.service';
import { PermissionsService } from '../permissions/permissions.service';
import { MemoryService } from '../memory/memory.service';
import type { AssistantTask } from '@assistant-app/contracts';
import { OllamaChatMessage } from '../ollama/ollama.types';
import {
  FILE_CONTENT_UNAVAILABLE_RESPONSE,
  FILE_MUTATION_UNAVAILABLE_RESPONSE,
  UNVERIFIED_FILE_RESPONSE,
} from './tool-policy';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('AgentService', () => {
  const createAgent = (maxSteps?: number) => {
    const task: AssistantTask = {
      id: 'task-1',
      title: 'Test',
      workspacePath: 'D:\\my-work',
      status: 'idle',
      messages: [],
      createdAt: 'now',
      updatedAt: 'now',
    };
    const tasks = {
      // Mirrors the real repository's behaviour of appending to the task's
      // own message list - shouldForceToolRetry() reads the latest user
      // message back off of it (via run()'s task.messages snapshot), so a
      // no-op mock would never see the message agent.start() just added.
      addMessage: jest.fn(
        (
          _taskId: string,
          role: string,
          content: string,
          toolName?: string,
          toolCalls?: unknown,
        ) => {
          const message = {
            id: `msg-${task.messages.length}`,
            role,
            content,
            toolName,
            toolCalls,
            createdAt: 'now',
          };
          task.messages.push(message as never);
          return message;
        },
      ),
      setStatus: jest.fn(),
      findOne: jest.fn().mockReturnValue(task),
    } as unknown as TasksRepository;
    const events = { emit: jest.fn() } as unknown as TaskEventsService;
    const ollama = {
      chat: jest.fn(),
      planFileSearch: jest.fn().mockResolvedValue(null),
      extractMemories: jest.fn().mockResolvedValue(null),
    } as unknown as OllamaService;
    const mcp = {
      scanDirectory: jest.fn(),
      searchFiles: jest.fn(),
      readFile: jest.fn(),
    } as unknown as McpClientService;
    const permissions = {
      create: jest.fn(),
      findOne: jest.fn(),
      resolve: jest.fn(),
    } as unknown as PermissionsService;
    const memory = {
      getContextFor: jest.fn().mockReturnValue([]),
      buildContextPrompt: jest.fn().mockReturnValue(null),
      applyExtracted: jest.fn(),
    } as unknown as MemoryService;
    const config = { get: () => maxSteps } as unknown as ConfigService;

    const agent = new AgentService(
      tasks,
      events,
      ollama,
      mcp,
      permissions,
      memory,
      config,
    );
    return { agent, tasks, events, ollama, mcp, permissions, memory, task };
  };

  it('completes a task when the model responds without a tool call', async () => {
    const { agent, tasks, events, ollama, task } = createAgent();
    (ollama.chat as jest.Mock).mockResolvedValue({
      content: 'Done',
      toolCalls: [],
    });

    agent.start(task.id, 'hello');

    expect(tasks.addMessage).toHaveBeenCalledWith(task.id, 'user', 'hello');
    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'working');
    expect(events.emit).toHaveBeenCalledWith(task.id, 'status', {
      status: 'working',
      text: expect.any(String),
    });

    await flush();

    expect(tasks.addMessage).toHaveBeenCalledWith(
      task.id,
      'assistant',
      'Done',
      undefined,
      undefined,
    );
    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'completed');
    expect(events.emit).toHaveBeenCalledWith(task.id, 'completed', {
      status: 'completed',
      stepsUsed: 1,
    });
  });

  it('executes a dynamic search plan directly for a topic-based file request', async () => {
    const { agent, ollama, mcp, task } = createAgent();
    (ollama.planFileSearch as jest.Mock).mockResolvedValue({
      queries: ['finance', 'budget', 'accounting'],
      fuzzy: true,
    });
    (mcp.searchFiles as jest.Mock).mockResolvedValue({
      matches: [
        {
          name: 'finance-report.xlsx',
          path: 'D:\\my-work\\finance-report.xlsx',
        },
      ],
      rootsSearched: [task.workspacePath],
      truncated: false,
    });
    (ollama.chat as jest.Mock).mockResolvedValue({
      content: 'Found a potentially relevant filename.',
      toolCalls: [],
    });

    agent.start(task.id, 'find files related to finance in this workspace');
    await flush();
    await flush();

    expect(ollama.planFileSearch).toHaveBeenCalledWith(
      'find files related to finance in this workspace',
    );
    expect(mcp.searchFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        queries: ['finance', 'budget', 'accounting'],
        fuzzy: true,
        root: task.workspacePath,
        maxResults: 25,
      }),
    );
    expect(ollama.chat).toHaveBeenCalledTimes(1);
    const chatCalls = (ollama.chat as jest.Mock).mock.calls as unknown[][];
    const summaryMessages = chatCalls[0][0] as OllamaChatMessage[];
    expect(
      summaryMessages.some(
        (message) =>
          message.role === 'system' &&
          message.content.includes('returned 1 real filename match'),
      ),
    ).toBe(true);
  });

  it('uses an explicit absolute path from a dynamic topic request as the recursive search root', async () => {
    const { agent, ollama, mcp, permissions, task } = createAgent();
    (ollama.planFileSearch as jest.Mock).mockResolvedValue({
      queries: ['การเงิน', 'รายรับ', 'รายจ่าย'],
      fuzzy: true,
    });
    (mcp.searchFiles as jest.Mock).mockResolvedValue({
      matches: [],
      rootsSearched: [task.workspacePath],
      truncated: false,
    });
    (ollama.chat as jest.Mock).mockResolvedValue({
      content: 'ไม่พบไฟล์',
      toolCalls: [],
    });

    agent.start(
      task.id,
      'เฉพาะใน workspace D:\\my-work ช่วยหาไฟล์เกี่ยวกับการเงินให้หน่อย',
    );
    await flush();
    await flush();

    expect(mcp.searchFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        root: 'D:\\my-work',
        fuzzy: true,
        queries: expect.arrayContaining(['การเงิน', 'เงิน']),
      }),
    );
    expect(permissions.create).not.toHaveBeenCalled();
  });

  it('keeps search-everywhere permission checks for a dynamic plan', async () => {
    const { agent, ollama, mcp, permissions, task } = createAgent();
    (ollama.planFileSearch as jest.Mock).mockResolvedValue({
      queries: ['mortgage', 'loan'],
      fuzzy: true,
    });
    (permissions.create as jest.Mock).mockReturnValue({
      id: 'permission-1',
      taskId: task.id,
      path: SEARCH_EVERYWHERE_LABEL,
    });

    agent.start(task.id, 'find files about a mortgage');
    await flush();

    expect(permissions.create).toHaveBeenCalledWith(
      task.id,
      SEARCH_EVERYWHERE_LABEL,
    );
    expect(mcp.searchFiles).not.toHaveBeenCalled();
  });

  it('reports stepsUsed of 1 when a configured AGENT_MAX_STEPS of 1 stops it immediately', async () => {
    const { agent, events, ollama, task } = createAgent(1);
    (ollama.chat as jest.Mock).mockResolvedValue({
      content: 'Done',
      toolCalls: [],
    });

    agent.start(task.id, 'hi');
    await flush();

    expect(events.emit).toHaveBeenCalledWith(task.id, 'completed', {
      status: 'completed',
      stepsUsed: 1,
    });
  });

  it('filters out tool-role messages when building context for Ollama', async () => {
    const { agent, ollama, task } = createAgent();
    task.messages = [
      { id: '1', role: 'user', content: 'hi', createdAt: 'now' },
      {
        id: '2',
        role: 'tool',
        content: 'raw tool output',
        toolName: 'scan_directory',
        createdAt: 'now',
      },
    ];
    (ollama.chat as jest.Mock).mockResolvedValue({
      content: 'ok',
      toolCalls: [],
    });

    agent.start(task.id, 'follow up');
    await flush();

    const chatMock = ollama.chat as jest.Mock<
      Promise<{ content: string; toolCalls: unknown[] }>,
      [Array<{ role: string; content: string }>]
    >;
    const sentMessages = chatMock.mock.calls[0][0];
    expect(sentMessages.some((m) => m.role === 'tool')).toBe(false);
    expect(sentMessages.some((m) => m.content === 'hi')).toBe(true);
  });

  it('executes the scan directly when the requested path is inside the workspace', async () => {
    const { agent, tasks, events, ollama, mcp, task } = createAgent();
    (ollama.chat as jest.Mock)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'scan_directory',
              arguments: { path: 'D:\\my-work\\src' },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ content: 'Found files', toolCalls: [] });
    (mcp.scanDirectory as jest.Mock).mockResolvedValue({ files: ['a.ts'] });

    agent.start(task.id, 'scan src');
    await flush();

    expect(mcp.scanDirectory).toHaveBeenCalledWith('D:\\my-work\\src');
    expect(events.emit).toHaveBeenCalledWith(
      task.id,
      'tool_started',
      expect.any(Object),
    );
    expect(events.emit).toHaveBeenCalledWith(
      task.id,
      'tool_completed',
      expect.any(Object),
    );
    expect(tasks.addMessage).toHaveBeenCalledWith(
      task.id,
      'tool',
      JSON.stringify({ files: ['a.ts'] }),
      'scan_directory',
    );
    expect(tasks.addMessage).toHaveBeenCalledWith(
      task.id,
      'assistant',
      'Found files',
      undefined,
      [
        expect.objectContaining({
          label: 'scan_directory เสร็จแล้ว',
          detail: 'เสร็จสิ้น',
          state: 'done',
        }),
      ],
    );
    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'completed');
    expect(events.emit).toHaveBeenCalledWith(task.id, 'completed', {
      status: 'completed',
      stepsUsed: 2,
    });
  });

  it('redirects a scan_directory call to a recursive search_files when the user asked for a specific file type', async () => {
    const { agent, tasks, ollama, mcp, task } = createAgent();
    (ollama.chat as jest.Mock)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'scan_directory',
              arguments: { path: 'D:\\my-work\\src' },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ content: 'No PDFs found', toolCalls: [] });
    (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

    agent.start(task.id, 'หาไฟล์ .pdf ใน D:\\my-work\\src หน่อย');
    await flush();

    expect(mcp.scanDirectory).not.toHaveBeenCalled();
    expect(mcp.searchFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        queries: [],
        root: 'D:\\my-work\\src',
        extensions: ['.pdf'],
      }),
    );
    expect(tasks.addMessage).toHaveBeenCalledWith(
      task.id,
      'tool',
      JSON.stringify({ matches: [] }),
      'search_files',
    );
  });

  it('keeps looping across multiple sequential tool calls until the model stops asking for one', async () => {
    const { agent, mcp, ollama, task } = createAgent();
    (ollama.chat as jest.Mock)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'scan_directory',
              arguments: { path: 'D:\\my-work\\a' },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'scan_directory',
              arguments: { path: 'D:\\my-work\\a\\b' },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ content: 'Found it', toolCalls: [] });
    (mcp.scanDirectory as jest.Mock).mockResolvedValue({});

    agent.start(task.id, 'find the file');
    await flush();
    await flush();

    expect(mcp.scanDirectory).toHaveBeenNthCalledWith(1, 'D:\\my-work\\a');
    expect(mcp.scanDirectory).toHaveBeenNthCalledWith(2, 'D:\\my-work\\a\\b');
    expect(ollama.chat).toHaveBeenCalledTimes(3);
  });

  it('halts the loop if the task is stopped between tool round-trips', async () => {
    const { agent, mcp, ollama, task } = createAgent();
    let resolveScan!: (value: unknown) => void;
    (ollama.chat as jest.Mock).mockResolvedValueOnce({
      content: '',
      toolCalls: [
        {
          function: {
            name: 'scan_directory',
            arguments: { path: 'D:\\my-work\\a' },
          },
        },
      ],
    });
    (mcp.scanDirectory as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve;
        }),
    );

    agent.start(task.id, 'find file');
    await flush();

    expect(ollama.chat).toHaveBeenCalledTimes(1);

    task.status = 'stopped';
    resolveScan({});
    await flush();

    expect(ollama.chat).toHaveBeenCalledTimes(1);
  });

  it('stops requesting further tool calls once AGENT_MAX_STEPS is reached, without executing the last one', async () => {
    const { agent, tasks, mcp, ollama, task } = createAgent(2);
    (ollama.chat as jest.Mock)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'scan_directory',
              arguments: { path: 'D:\\my-work\\a' },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'scan_directory',
              arguments: { path: 'D:\\my-work\\a\\b' },
            },
          },
        ],
      });
    (mcp.scanDirectory as jest.Mock).mockResolvedValue({});

    agent.start(task.id, 'find the file');
    await flush();
    await flush();

    expect(mcp.scanDirectory).toHaveBeenCalledTimes(1);
    expect(ollama.chat).toHaveBeenCalledTimes(2);
    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'completed');
    expect(tasks.addMessage).toHaveBeenCalledWith(
      task.id,
      'assistant',
      'ถึงจำนวนขั้นตอนสูงสุดที่กำหนดไว้แล้ว ไม่สามารถดำเนินการต่อได้',
      undefined,
      [
        expect.objectContaining({
          label: 'scan_directory เสร็จแล้ว',
          detail: 'เสร็จสิ้น',
          state: 'done',
        }),
      ],
    );
  });

  it('defaults the scan path to the workspace root when the model omits it', async () => {
    const { agent, mcp, ollama, task } = createAgent();
    (ollama.chat as jest.Mock)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ function: { name: 'scan_directory', arguments: {} } }],
      })
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
    (mcp.scanDirectory as jest.Mock).mockResolvedValue({});

    agent.start(task.id, 'scan');
    await flush();

    expect(mcp.scanDirectory).toHaveBeenCalledWith(task.workspacePath);
  });

  it('falls back to a default completion message when the follow-up has no content', async () => {
    const { agent, tasks, ollama, mcp, task } = createAgent();
    (ollama.chat as jest.Mock)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'scan_directory',
              arguments: { path: task.workspacePath },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ content: '', toolCalls: [] });
    (mcp.scanDirectory as jest.Mock).mockResolvedValue({});

    agent.start(task.id, 'scan');
    await flush();

    expect(tasks.addMessage).toHaveBeenCalledWith(
      task.id,
      'assistant',
      'ดำเนินการเสร็จแล้ว',
      undefined,
      [
        expect.objectContaining({
          label: 'scan_directory เสร็จแล้ว',
          detail: 'เสร็จสิ้น',
          state: 'done',
        }),
      ],
    );
  });

  it('supports POSIX-style workspace paths', async () => {
    const { agent, mcp, ollama, task } = createAgent();
    task.workspacePath = '/home/user/project';
    (ollama.chat as jest.Mock)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'scan_directory',
              arguments: { path: '/home/user/project/src' },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
    (mcp.scanDirectory as jest.Mock).mockResolvedValue({});

    agent.start(task.id, 'scan');
    await flush();

    expect(mcp.scanDirectory).toHaveBeenCalledWith('/home/user/project/src');
  });

  it('requests permission when the path is on a different drive than the workspace', async () => {
    const { agent, tasks, events, ollama, permissions, task } = createAgent();
    (ollama.chat as jest.Mock).mockResolvedValue({
      content: '',
      toolCalls: [
        {
          function: {
            name: 'scan_directory',
            arguments: { path: 'C:\\Windows' },
          },
        },
      ],
    });
    (permissions.create as jest.Mock).mockReturnValue({
      id: 'perm-1',
      taskId: task.id,
      path: 'C:\\Windows',
      action: 'read_directory',
      access: 'read',
      status: 'pending',
      createdAt: 'now',
    });

    agent.start(task.id, 'scan outside');
    await flush();

    expect(permissions.create).toHaveBeenCalledWith(task.id, 'C:\\Windows');
    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'waiting_permission');
    expect(events.emit).toHaveBeenCalledWith(task.id, 'permission_required', {
      permission: expect.objectContaining({ id: 'perm-1' }),
    });
  });

  it('treats a parent directory on the same drive as outside the workspace', async () => {
    const { agent, tasks, ollama, permissions, task } = createAgent();
    task.workspacePath = 'D:\\my-work\\sub';
    (ollama.chat as jest.Mock).mockResolvedValue({
      content: '',
      toolCalls: [
        {
          function: {
            name: 'scan_directory',
            arguments: { path: 'D:\\my-work' },
          },
        },
      ],
    });
    (permissions.create as jest.Mock).mockReturnValue({
      id: 'perm-2',
      taskId: task.id,
      path: 'D:\\my-work',
      action: 'read_directory',
      access: 'read',
      status: 'pending',
      createdAt: 'now',
    });

    agent.start(task.id, 'go up');
    await flush();

    expect(permissions.create).toHaveBeenCalledWith(task.id, 'D:\\my-work');
    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'waiting_permission');
  });

  it('rejects resolving a permission that does not belong to the given task', () => {
    const { agent, permissions } = createAgent();
    (permissions.findOne as jest.Mock).mockReturnValue({
      id: 'perm-1',
      taskId: 'other-task',
    });

    expect(() => agent.resolvePermission('task-1', 'perm-1', true)).toThrow(
      BadRequestException,
    );
  });

  it('resumes the scan after permission is allowed', async () => {
    const { agent, tasks, ollama, mcp, permissions, task } = createAgent();
    (ollama.chat as jest.Mock)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'scan_directory',
              arguments: { path: 'C:\\Windows' },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ content: 'Summarized', toolCalls: [] });
    (permissions.create as jest.Mock).mockReturnValue({
      id: 'perm-1',
      taskId: task.id,
      path: 'C:\\Windows',
      action: 'read_directory',
      access: 'read',
      status: 'pending',
      createdAt: 'now',
    });
    (permissions.findOne as jest.Mock).mockReturnValue({
      id: 'perm-1',
      taskId: task.id,
    });
    (permissions.resolve as jest.Mock).mockReturnValue({
      id: 'perm-1',
      taskId: task.id,
      status: 'allowed',
    });
    (mcp.scanDirectory as jest.Mock).mockResolvedValue({ files: [] });

    agent.start(task.id, 'scan outside');
    await flush();

    agent.resolvePermission(task.id, 'perm-1', true);
    await flush();

    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'working');
    expect(mcp.scanDirectory).toHaveBeenCalledWith('C:\\Windows');
    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'completed');
  });

  it('stops the task and replies with a real chat message when permission is denied, instead of going silent', async () => {
    const { agent, tasks, events, ollama, permissions, task } = createAgent();
    (ollama.chat as jest.Mock).mockResolvedValue({
      content: '',
      toolCalls: [
        {
          function: {
            name: 'scan_directory',
            arguments: { path: 'C:\\Windows' },
          },
        },
      ],
    });
    (permissions.create as jest.Mock).mockReturnValue({
      id: 'perm-1',
      taskId: task.id,
      path: 'C:\\Windows',
      action: 'read_directory',
      access: 'read',
      status: 'pending',
      createdAt: 'now',
    });
    (permissions.findOne as jest.Mock).mockReturnValue({
      id: 'perm-1',
      taskId: task.id,
    });
    (permissions.resolve as jest.Mock).mockReturnValue({
      id: 'perm-1',
      taskId: task.id,
      path: 'C:\\Windows',
      action: 'read_directory',
      access: 'read',
      status: 'denied',
      createdAt: 'now',
    });

    agent.start(task.id, 'scan outside');
    await flush();

    agent.resolvePermission(task.id, 'perm-1', false);

    expect(tasks.addMessage).toHaveBeenCalledWith(
      task.id,
      'assistant',
      expect.stringContaining('C:\\Windows'),
      undefined,
      expect.anything(),
    );
    expect(events.emit).toHaveBeenCalledWith(task.id, 'message', {
      message: expect.anything(),
    });
    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'stopped');
    expect(events.emit).toHaveBeenCalledWith(task.id, 'status', {
      status: 'stopped',
      text: expect.any(String),
    });
  });

  it('does nothing further when the permission has no matching pending run', () => {
    const { agent, tasks, permissions, task } = createAgent();
    (permissions.findOne as jest.Mock).mockReturnValue({
      id: 'perm-unknown',
      taskId: task.id,
    });
    (permissions.resolve as jest.Mock).mockReturnValue({
      id: 'perm-unknown',
      taskId: task.id,
      status: 'allowed',
    });

    expect(() =>
      agent.resolvePermission(task.id, 'perm-unknown', true),
    ).not.toThrow();
    expect(tasks.setStatus).not.toHaveBeenCalled();
  });

  it('does not run the scan if the task was stopped while waiting for permission', async () => {
    const { agent, mcp, ollama, permissions, task } = createAgent();
    (ollama.chat as jest.Mock).mockResolvedValue({
      content: '',
      toolCalls: [
        {
          function: {
            name: 'scan_directory',
            arguments: { path: 'C:\\Windows' },
          },
        },
      ],
    });
    (permissions.create as jest.Mock).mockReturnValue({
      id: 'perm-3',
      taskId: task.id,
      path: 'C:\\Windows',
      action: 'read_directory',
      access: 'read',
      status: 'pending',
      createdAt: 'now',
    });
    (permissions.findOne as jest.Mock).mockReturnValue({
      id: 'perm-3',
      taskId: task.id,
    });
    (permissions.resolve as jest.Mock).mockReturnValue({
      id: 'perm-3',
      taskId: task.id,
      status: 'allowed',
    });

    agent.start(task.id, 'scan outside');
    await flush();

    task.status = 'stopped';
    agent.resolvePermission(task.id, 'perm-3', true);
    await flush();

    expect(mcp.scanDirectory).not.toHaveBeenCalled();
  });

  it('stops a task directly', () => {
    const { agent, tasks, events, task } = createAgent();

    agent.stop(task.id);

    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'stopped');
    expect(events.emit).toHaveBeenCalledWith(task.id, 'status', {
      status: 'stopped',
      text: expect.any(String),
    });
  });

  it('marks the task failed when the model call throws an Error', async () => {
    const { agent, tasks, events, ollama, task } = createAgent();
    (ollama.chat as jest.Mock).mockRejectedValue(new Error('model down'));

    agent.start(task.id, 'hello');
    await flush();

    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'failed');
    expect(events.emit).toHaveBeenCalledWith(task.id, 'error', {
      message: 'model down',
    });
  });

  it('emits message_delta events as the model streams content', async () => {
    const { agent, events, ollama, task } = createAgent();
    (ollama.chat as jest.Mock).mockImplementation(
      (_messages: unknown, onDelta?: (delta: string) => void) => {
        onDelta?.('Hel');
        onDelta?.('lo');
        return Promise.resolve({ content: 'Hello', toolCalls: [] });
      },
    );

    agent.start(task.id, 'hi');
    await flush();

    expect(events.emit).toHaveBeenCalledWith(task.id, 'message_delta', {
      delta: 'Hel',
    });
    expect(events.emit).toHaveBeenCalledWith(task.id, 'message_delta', {
      delta: 'lo',
    });
  });

  it('feeds a tool call failure back as a tool result instead of failing the whole task, once permission is resumed', async () => {
    const { agent, tasks, ollama, mcp, permissions, task } = createAgent();
    (ollama.chat as jest.Mock)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'scan_directory',
              arguments: { path: 'C:\\Windows\\NonexistentFolder' },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: 'ไม่พบโฟลเดอร์ที่ระบุครับ',
        toolCalls: [],
      });
    (permissions.create as jest.Mock).mockReturnValue({
      id: 'perm-5',
      taskId: task.id,
      path: 'C:\\Windows\\NonexistentFolder',
      action: 'read_directory',
      access: 'read',
      status: 'pending',
      createdAt: 'now',
    });
    (permissions.findOne as jest.Mock).mockReturnValue({
      id: 'perm-5',
      taskId: task.id,
    });
    (permissions.resolve as jest.Mock).mockReturnValue({
      id: 'perm-5',
      taskId: task.id,
      status: 'allowed',
    });
    (mcp.scanDirectory as jest.Mock).mockRejectedValue(
      new Error('Path does not exist: C:\\Windows\\NonexistentFolder'),
    );

    agent.start(task.id, 'scan outside');
    await flush();

    agent.resolvePermission(task.id, 'perm-5', true);
    await flush();

    expect(tasks.addMessage).toHaveBeenCalledWith(
      task.id,
      'tool',
      JSON.stringify({
        error: 'Path does not exist: C:\\Windows\\NonexistentFolder',
      }),
      'scan_directory',
    );
    expect(tasks.addMessage).toHaveBeenCalledWith(
      task.id,
      'assistant',
      'ไม่พบโฟลเดอร์ที่ระบุครับ',
      undefined,
      expect.arrayContaining([
        expect.objectContaining({
          label: 'scan_directory ไม่สำเร็จ',
          state: 'failed',
        }),
      ]),
    );
    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'completed');
  });

  it('stringifies a non-Error thrown value in the tool result fed back to the model', async () => {
    const { agent, tasks, ollama, mcp, task } = createAgent();
    (ollama.chat as jest.Mock)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'scan_directory',
              arguments: { path: task.workspacePath },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ content: 'เกิดข้อผิดพลาดครับ', toolCalls: [] });
    (mcp.scanDirectory as jest.Mock).mockRejectedValue('boom-string');

    agent.start(task.id, 'scan');
    await flush();

    expect(tasks.addMessage).toHaveBeenCalledWith(
      task.id,
      'tool',
      JSON.stringify({ error: 'boom-string' }),
      'scan_directory',
    );
    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'completed');
  });

  describe('search_files', () => {
    it('executes the search directly when a root inside the workspace is given', async () => {
      const { agent, tasks, mcp, ollama, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: { queries: ['หนี้'], root: 'D:\\my-work\\docs' },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'Found it', toolCalls: [] });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(task.id, 'find my debt sheet');
      await flush();

      expect(mcp.searchFiles).toHaveBeenCalledWith({
        queries: ['หนี้'],
        root: 'D:\\my-work\\docs',
        maxResults: 25,
        maxDepth: undefined,
      });
      expect(tasks.addMessage).toHaveBeenCalledWith(
        task.id,
        'tool',
        JSON.stringify({ matches: [] }),
        'search_files',
      );
      expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'completed');
    });

    it('nudges the model to retry with shorter root words when a Thai-query search comes back empty', async () => {
      const { agent, ollama, mcp, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: { queries: ['หนี้สิน'], root: 'D:\\my-work\\docs' },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ไม่พบไฟล์', toolCalls: [] });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(task.id, 'หาไฟล์หนี้สิน');
      await flush();

      const chatMock = ollama.chat as jest.Mock<
        Promise<{ content: string; toolCalls: unknown[] }>,
        [OllamaChatMessage[]]
      >;
      const secondCallMessages = chatMock.mock.calls[1][0];
      expect(
        secondCallMessages.some(
          (message) =>
            message.role === 'system' && message.content.includes('หนี้สิน'),
        ),
      ).toBe(true);
    });

    it('does not nudge a second time once the model already got the empty-search retry this turn', async () => {
      const { agent, ollama, mcp, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: { queries: ['หนี้สิน'], root: 'D:\\my-work\\docs' },
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: { queries: ['หนี้'], root: 'D:\\my-work\\docs' },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ไม่พบไฟล์', toolCalls: [] });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(task.id, 'หาไฟล์หนี้สิน');
      await flush();
      await flush();

      const chatMock = ollama.chat as jest.Mock<
        Promise<{ content: string; toolCalls: unknown[] }>,
        [OllamaChatMessage[]]
      >;
      const thirdCallMessages = chatMock.mock.calls[2][0];
      const nudgeCount = thirdCallMessages.filter(
        (message) =>
          message.role === 'system' &&
          message.content.includes('(ระบบแนะนำให้ลองแยกคำ)'),
      ).length;
      expect(nudgeCount).toBe(1);
    });

    it('passes through numeric maxResults/maxDepth arguments', async () => {
      const { agent, mcp, ollama, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: {
                  queries: ['หนี้'],
                  root: 'D:\\my-work',
                  maxResults: 10,
                  maxDepth: 3,
                },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(task.id, 'find');
      await flush();

      expect(mcp.searchFiles).toHaveBeenCalledWith({
        queries: ['หนี้'],
        root: 'D:\\my-work',
        maxResults: 10,
        maxDepth: 3,
      });
    });

    it('normalizes model and user-requested extension filters', async () => {
      const { agent, mcp, ollama, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: {
                  queries: [],
                  extensions: ['PDF'],
                  root: 'D:\\my-work',
                },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(task.id, 'หาไฟล์ PDF ในโปรเจกต์นี้');
      await flush();

      expect(mcp.searchFiles).toHaveBeenCalledWith(
        expect.objectContaining({ extensions: ['.pdf'] }),
      );
    });

    it.each(['\\.md', '\\.md$', '/\\.md$/'])(
      'drops extension-only query %s when an extension filter is active',
      async (extensionQuery) => {
        const { agent, mcp, ollama, task } = createAgent();
        (ollama.chat as jest.Mock)
          .mockResolvedValueOnce({
            content: '',
            toolCalls: [
              {
                function: {
                  name: 'search_files',
                  arguments: {
                    queries: [extensionQuery],
                    root: 'D:\\my-work',
                  },
                },
              },
            ],
          })
          .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
        (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

        agent.start(task.id, 'หาไฟล์ .md ในโปรเจกต์นี้');
        await flush();

        expect(mcp.searchFiles).toHaveBeenCalledWith(
          expect.objectContaining({ queries: [], extensions: ['.md'] }),
        );
      },
    );

    it('defaults queries to an empty array when the model omits it', async () => {
      const { agent, mcp, ollama, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: { root: 'D:\\my-work' },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(task.id, 'find');
      await flush();

      expect(mcp.searchFiles).toHaveBeenCalledWith({
        queries: [],
        root: 'D:\\my-work',
        maxResults: 25,
        maxDepth: undefined,
      });
    });

    it('always requires permission when root is omitted, even without a workspace conflict', async () => {
      const { agent, tasks, events, permissions, ollama, mcp, task } =
        createAgent();
      (ollama.chat as jest.Mock).mockResolvedValue({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'search_files',
              arguments: { queries: ['หนี้'] },
            },
          },
        ],
      });
      (permissions.create as jest.Mock).mockReturnValue({
        id: 'perm-search',
        taskId: task.id,
        path: SEARCH_EVERYWHERE_LABEL,
        action: 'read_directory',
        access: 'read',
        status: 'pending',
        createdAt: 'now',
      });

      agent.start(task.id, 'find my debt sheet, I forgot where it is');
      await flush();

      expect(permissions.create).toHaveBeenCalledWith(
        task.id,
        SEARCH_EVERYWHERE_LABEL,
      );
      expect(tasks.setStatus).toHaveBeenCalledWith(
        task.id,
        'waiting_permission',
      );
      expect(events.emit).toHaveBeenCalledWith(task.id, 'permission_required', {
        permission: expect.objectContaining({ id: 'perm-search' }),
      });
      expect(mcp.searchFiles).not.toHaveBeenCalled();
    });

    it('searches everywhere once that permission is granted', async () => {
      const { agent, mcp, ollama, permissions, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: { queries: ['หนี้'] },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'Found it', toolCalls: [] });
      (permissions.create as jest.Mock).mockReturnValue({
        id: 'perm-search',
        taskId: task.id,
        path: SEARCH_EVERYWHERE_LABEL,
        action: 'read_directory',
        access: 'read',
        status: 'pending',
        createdAt: 'now',
      });
      (permissions.findOne as jest.Mock).mockReturnValue({
        id: 'perm-search',
        taskId: task.id,
      });
      (permissions.resolve as jest.Mock).mockReturnValue({
        id: 'perm-search',
        taskId: task.id,
        status: 'allowed',
      });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(task.id, 'find my debt sheet');
      await flush();

      agent.resolvePermission(task.id, 'perm-search', true);
      await flush();

      expect(mcp.searchFiles).toHaveBeenCalledWith({
        queries: ['หนี้'],
        root: undefined,
        maxResults: 25,
        maxDepth: undefined,
      });
    });

    it('translates modifiedRange into local calendar-day boundaries', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
      try {
        const { agent, mcp, ollama, task } = createAgent();
        (ollama.chat as jest.Mock)
          .mockResolvedValueOnce({
            content: '',
            toolCalls: [
              {
                function: {
                  name: 'search_files',
                  arguments: {
                    queries: ['รายงาน'],
                    root: 'D:\\my-work',
                    modifiedRange: 'last_7_days',
                  },
                },
              },
            ],
          })
          .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
        (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

        agent.start(task.id, 'find recent reports');
        await jest.runAllTimersAsync();

        expect(mcp.searchFiles).toHaveBeenCalledWith({
          queries: ['รายงาน'],
          root: 'D:\\my-work',
          maxResults: 25,
          maxDepth: undefined,
          modifiedAfter: '2026-07-08T17:00:00.000Z',
          modifiedBefore: '2026-07-15T16:59:59.999Z',
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it('omits modifiedAfter when modifiedRange is not a recognized bucket', async () => {
      const { agent, mcp, ollama, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: {
                  queries: ['รายงาน'],
                  root: 'D:\\my-work',
                  modifiedRange: 'sometime',
                },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(task.id, 'find reports');
      await flush();

      expect(mcp.searchFiles).toHaveBeenCalledWith({
        queries: ['รายงาน'],
        root: 'D:\\my-work',
        maxResults: 25,
        maxDepth: undefined,
        modifiedAfter: undefined,
      });
    });

    it('ignores a valid modifiedRange the model attached when the user never mentioned time at all', async () => {
      const { agent, mcp, ollama, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: {
                  queries: ['หนี้'],
                  root: 'D:\\my-work',
                  modifiedRange: 'today',
                },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(
        task.id,
        'หาไฟล์ หนี้ ของฉันให้หน่อย ฉันจำไม่ได้ว่าเก็บไว้ไหนอะ',
      );
      await flush();

      expect(mcp.searchFiles).toHaveBeenCalledWith({
        queries: ['หนี้'],
        root: 'D:\\my-work',
        maxResults: 25,
        maxDepth: undefined,
        modifiedAfter: undefined,
        modifiedBefore: undefined,
      });
    });

    it('allows omitting queries when modifiedRange is given, searching everywhere for anything changed in that window', async () => {
      const { agent, mcp, ollama, permissions, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: { modifiedRange: 'today' },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
      (permissions.create as jest.Mock).mockReturnValue({
        id: 'perm-time',
        taskId: task.id,
        path: SEARCH_EVERYWHERE_LABEL,
        action: 'read_directory',
        access: 'read',
        status: 'pending',
        createdAt: 'now',
      });
      (permissions.findOne as jest.Mock).mockReturnValue({
        id: 'perm-time',
        taskId: task.id,
      });
      (permissions.resolve as jest.Mock).mockReturnValue({
        id: 'perm-time',
        taskId: task.id,
        status: 'allowed',
      });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(task.id, 'what changed today');
      await flush();
      agent.resolvePermission(task.id, 'perm-time', true);
      await flush();

      expect(mcp.searchFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          queries: [],
          root: undefined,
          maxResults: 25,
        }),
      );
    });

    it('respects an explicit maxResults instead of the model-facing default', async () => {
      const { agent, mcp, ollama, permissions, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: { modifiedRange: 'today', maxResults: 5 },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
      (permissions.create as jest.Mock).mockReturnValue({
        id: 'perm-time-2',
        taskId: task.id,
        path: SEARCH_EVERYWHERE_LABEL,
        action: 'read_directory',
        access: 'read',
        status: 'pending',
        createdAt: 'now',
      });
      (permissions.findOne as jest.Mock).mockReturnValue({
        id: 'perm-time-2',
        taskId: task.id,
      });
      (permissions.resolve as jest.Mock).mockReturnValue({
        id: 'perm-time-2',
        taskId: task.id,
        status: 'allowed',
      });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(task.id, 'what changed today');
      await flush();
      agent.resolvePermission(task.id, 'perm-time-2', true);
      await flush();

      expect(mcp.searchFiles).toHaveBeenCalledWith(
        expect.objectContaining({ maxResults: 5 }),
      );
    });

    it('adds the English name and forces a search-everywhere when the model queries a Windows special folder by its Thai nickname, ignoring whatever root it guessed', async () => {
      const { agent, tasks, mcp, ollama, permissions, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                // the model wrongly guessed the special folder lives inside
                // the workspace - that guess must be discarded
                arguments: {
                  queries: ['ดาวโหลด'],
                  root: 'D:\\my-work',
                },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
      (permissions.create as jest.Mock).mockReturnValue({
        id: 'perm-folder',
        taskId: task.id,
        path: SEARCH_EVERYWHERE_LABEL,
        action: 'read_directory',
        access: 'read',
        status: 'pending',
        createdAt: 'now',
      });
      (permissions.findOne as jest.Mock).mockReturnValue({
        id: 'perm-folder',
        taskId: task.id,
      });
      (permissions.resolve as jest.Mock).mockReturnValue({
        id: 'perm-folder',
        taskId: task.id,
        status: 'allowed',
      });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(task.id, 'find my downloads');
      await flush();

      expect(tasks.setStatus).toHaveBeenCalledWith(
        task.id,
        'waiting_permission',
      );
      expect(mcp.searchFiles).not.toHaveBeenCalled();

      agent.resolvePermission(task.id, 'perm-folder', true);
      await flush();

      expect(mcp.searchFiles).toHaveBeenCalledWith({
        queries: ['ดาวโหลด', 'Downloads'],
        root: undefined,
        maxResults: 25,
        maxDepth: undefined,
      });
    });

    it('still forces a search-everywhere if the model already included the English name itself', async () => {
      const { agent, mcp, ollama, permissions, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: {
                  queries: ['ดาวน์โหลด', 'Downloads'],
                  root: 'D:\\my-work',
                },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
      (permissions.create as jest.Mock).mockReturnValue({
        id: 'perm-folder-2',
        taskId: task.id,
        path: SEARCH_EVERYWHERE_LABEL,
        action: 'read_directory',
        access: 'read',
        status: 'pending',
        createdAt: 'now',
      });
      (permissions.findOne as jest.Mock).mockReturnValue({
        id: 'perm-folder-2',
        taskId: task.id,
      });
      (permissions.resolve as jest.Mock).mockReturnValue({
        id: 'perm-folder-2',
        taskId: task.id,
        status: 'allowed',
      });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(task.id, 'find my downloads');
      await flush();
      agent.resolvePermission(task.id, 'perm-folder-2', true);
      await flush();

      expect(mcp.searchFiles).toHaveBeenCalledWith({
        queries: ['ดาวน์โหลด', 'Downloads'],
        root: undefined,
        maxResults: 25,
        maxDepth: undefined,
      });
    });

    it("scopes into the special folder's real path (dropping the folder name from queries) when the model combines it with a date filter, instead of treating the name as a filename to search for", async () => {
      const { agent, tasks, mcp, ollama, permissions, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: {
                  queries: ['ดาวโหลด', 'Downloads'],
                  modifiedRange: 'last_30_days',
                },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
      (permissions.create as jest.Mock).mockReturnValue({
        id: 'perm-scoped',
        taskId: task.id,
        path: `${homedir()}\\Downloads`,
        action: 'read_directory',
        access: 'read',
        status: 'pending',
        createdAt: 'now',
      });
      (permissions.findOne as jest.Mock).mockReturnValue({
        id: 'perm-scoped',
        taskId: task.id,
      });
      (permissions.resolve as jest.Mock).mockReturnValue({
        id: 'perm-scoped',
        taskId: task.id,
        status: 'allowed',
      });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(task.id, 'what changed in downloads last month');
      await flush();

      expect(tasks.setStatus).toHaveBeenCalledWith(
        task.id,
        'waiting_permission',
      );

      agent.resolvePermission(task.id, 'perm-scoped', true);
      await flush();

      expect(mcp.searchFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          queries: [],
          root: `${homedir()}\\Downloads`,
        }),
      );
    });

    it("scopes a name search into the special folder's real path when another real search term is combined with it", async () => {
      const { agent, mcp, ollama, permissions, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: { queries: ['ดาวโหลด', 'รายงาน'] },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
      (permissions.create as jest.Mock).mockReturnValue({
        id: 'perm-scoped-2',
        taskId: task.id,
        path: `${homedir()}\\Downloads`,
        action: 'read_directory',
        access: 'read',
        status: 'pending',
        createdAt: 'now',
      });
      (permissions.findOne as jest.Mock).mockReturnValue({
        id: 'perm-scoped-2',
        taskId: task.id,
      });
      (permissions.resolve as jest.Mock).mockReturnValue({
        id: 'perm-scoped-2',
        taskId: task.id,
        status: 'allowed',
      });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(task.id, 'find report in downloads');
      await flush();
      agent.resolvePermission(task.id, 'perm-scoped-2', true);
      await flush();

      expect(mcp.searchFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          queries: ['รายงาน'],
          root: `${homedir()}\\Downloads`,
        }),
      );
    });

    it('treats a non-absolute root as omitted and searches everywhere instead of passing it through', async () => {
      const { agent, tasks, events, permissions, ollama, mcp, task } =
        createAgent();
      (ollama.chat as jest.Mock).mockResolvedValue({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'search_files',
              arguments: { queries: ['ดาวโหลด'], root: 'Downloads' },
            },
          },
        ],
      });
      (permissions.create as jest.Mock).mockReturnValue({
        id: 'perm-bad-root',
        taskId: task.id,
        path: SEARCH_EVERYWHERE_LABEL,
        action: 'read_directory',
        access: 'read',
        status: 'pending',
        createdAt: 'now',
      });

      agent.start(task.id, 'find my downloads');
      await flush();

      expect(permissions.create).toHaveBeenCalledWith(
        task.id,
        SEARCH_EVERYWHERE_LABEL,
      );
      expect(tasks.setStatus).toHaveBeenCalledWith(
        task.id,
        'waiting_permission',
      );
      expect(events.emit).toHaveBeenCalledWith(task.id, 'permission_required', {
        permission: expect.objectContaining({ id: 'perm-bad-root' }),
      });
      expect(mcp.searchFiles).not.toHaveBeenCalled();
    });

    it('requires permission when an explicit root falls outside the workspace', async () => {
      const { agent, tasks, permissions, ollama, task } = createAgent();
      (ollama.chat as jest.Mock).mockResolvedValue({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'search_files',
              arguments: { queries: ['หนี้'], root: 'G:\\My Drive' },
            },
          },
        ],
      });
      (permissions.create as jest.Mock).mockReturnValue({
        id: 'perm-4',
        taskId: task.id,
        path: 'G:\\My Drive',
        action: 'read_directory',
        access: 'read',
        status: 'pending',
        createdAt: 'now',
      });

      agent.start(task.id, 'find on google drive');
      await flush();

      expect(permissions.create).toHaveBeenCalledWith(task.id, 'G:\\My Drive');
      expect(tasks.setStatus).toHaveBeenCalledWith(
        task.id,
        'waiting_permission',
      );
    });
  });

  describe('forced retry when the model answers without calling a tool', () => {
    it('retries once with a nudge when a file-lookup message gets answered with zero tool calls, then completes using the retry', async () => {
      const { agent, tasks, ollama, mcp, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: 'ไม่มีข้อมูลหรือการเข้าถึงตำแหน่งของไฟล์นั้น',
          toolCalls: [],
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'scan_directory',
                arguments: { path: 'D:\\my-work\\assistant-app' },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'Here it is', toolCalls: [] });
      (mcp.scanDirectory as jest.Mock).mockResolvedValue({ entries: [] });

      agent.start(task.id, 'ใน assistant-app มีไฟล์อะไรบ้าง');
      await flush();

      expect(ollama.chat).toHaveBeenCalledTimes(3);
      // The retry's system nudge is appended after the original conversation
      // rather than replacing it.
      const chatMock = ollama.chat as jest.Mock<
        Promise<{ content: string; toolCalls: unknown[] }>,
        [Array<{ role: string; content: string }>]
      >;
      const secondCallMessages = chatMock.mock.calls[1][0];
      expect(secondCallMessages[secondCallMessages.length - 1]).toEqual(
        expect.objectContaining({ role: 'system' }),
      );
      expect(tasks.addMessage).toHaveBeenCalledWith(
        task.id,
        'assistant',
        'Here it is',
        undefined,
        expect.anything(),
      );
      expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'completed');
    });

    it('does not retry a second time if the model still answers without a tool call', async () => {
      const { agent, tasks, ollama, task } = createAgent();
      (ollama.chat as jest.Mock).mockResolvedValue({
        content: 'ไม่พบไฟล์',
        toolCalls: [],
      });

      agent.start(task.id, 'หาไฟล์ report.pdf ให้หน่อย');
      await flush();

      expect(ollama.chat).toHaveBeenCalledTimes(2);
      expect(tasks.addMessage).toHaveBeenCalledWith(
        task.id,
        'assistant',
        UNVERIFIED_FILE_RESPONSE,
        undefined,
        undefined,
      );
      expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'completed');
    });

    it('falls back to the real Desktop path when the model ignores the tool retry and fabricates a listing', async () => {
      const { agent, tasks, events, ollama, permissions, task } = createAgent();
      (ollama.chat as jest.Mock).mockResolvedValue({
        content: 'พบ notes.txt และ presentation.pptx',
        toolCalls: [],
      });
      (permissions.create as jest.Mock).mockReturnValue({
        id: 'perm-desktop',
        taskId: task.id,
        path: `${homedir()}\\Desktop`,
        action: 'read_directory',
        access: 'read',
        status: 'pending',
        createdAt: 'now',
      });

      agent.start(
        task.id,
        'ช่วยสแกนหน้า Desktop ระดับบนสุดแบบอ่านอย่างเดียว แล้วสรุปสิ่งที่พบ',
      );
      await flush();

      expect(ollama.chat).toHaveBeenCalledTimes(2);
      expect(permissions.create).toHaveBeenCalledWith(
        task.id,
        `${homedir()}\\Desktop`,
      );
      expect(tasks.setStatus).toHaveBeenCalledWith(
        task.id,
        'waiting_permission',
      );
      expect(events.emit).toHaveBeenCalledWith(
        task.id,
        'permission_required',
        expect.objectContaining({ permission: expect.anything() }),
      );
      expect(tasks.addMessage).not.toHaveBeenCalledWith(
        task.id,
        'assistant',
        expect.stringContaining('notes.txt'),
        expect.anything(),
        expect.anything(),
      );
    });

    it('recovers an explicit absolute directory path when the model ignores both tool prompts', async () => {
      const { agent, tasks, events, ollama, permissions, task } = createAgent();
      (ollama.chat as jest.Mock).mockResolvedValue({
        content: 'ระบุ path ให้ชัดเจนขึ้น',
        toolCalls: [],
      });
      (permissions.create as jest.Mock).mockReturnValue({
        id: 'perm-absolute-path',
        taskId: task.id,
        path: 'C:\\Windows\\System32',
        action: 'read_directory',
        access: 'read',
        status: 'pending',
        createdAt: 'now',
      });

      agent.start(
        task.id,
        'ช่วยสแกนดูรายการชั้นแรกใน C:\\Windows\\System32 ให้หน่อย',
      );
      await flush();

      expect(ollama.chat).toHaveBeenCalledTimes(2);
      expect(permissions.create).toHaveBeenCalledWith(
        task.id,
        'C:\\Windows\\System32',
      );
      expect(tasks.setStatus).toHaveBeenCalledWith(
        task.id,
        'waiting_permission',
      );
      expect(events.emit).toHaveBeenCalledWith(
        task.id,
        'permission_required',
        expect.objectContaining({ permission: expect.anything() }),
      );
    });

    it('does not retry a mutation request (e.g. delete) even with zero tool calls, since no tool supports it', async () => {
      const { agent, tasks, ollama, task } = createAgent();
      (ollama.chat as jest.Mock).mockResolvedValue({
        content: 'ฉันไม่สามารถลบไฟล์ได้',
        toolCalls: [],
      });

      agent.start(task.id, 'ช่วยลบไฟล์ README.md ให้หน่อย');
      await flush();

      expect(ollama.chat).not.toHaveBeenCalled();
      expect(tasks.addMessage).toHaveBeenCalledWith(
        task.id,
        'assistant',
        FILE_MUTATION_UNAVAILABLE_RESPONSE,
        undefined,
        undefined,
      );
    });

    it('retries a modification-date lookup instead of mistaking "ไฟล์ที่แก้ไข" for an edit request', async () => {
      const { agent, ollama, mcp, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: 'วันที่ดังกล่าวยังไม่เกิดขึ้น',
          toolCalls: [],
        })
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: { modifiedRange: 'today', maxResults: 5 },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'พบไฟล์วันนี้', toolCalls: [] });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(
        task.id,
        'ค้นหาไฟล์ในโปรเจกต์นี้ที่แก้ไขวันนี้ และแสดงไม่เกิน 5 ไฟล์',
      );
      await flush();
      await flush();

      expect(ollama.chat).toHaveBeenCalledTimes(3);
      expect(mcp.searchFiles).toHaveBeenCalledWith(
        expect.objectContaining({ root: task.workspacePath, maxResults: 5 }),
      );
    });

    it('includes the real current local date in the system context', async () => {
      const { agent, ollama, task } = createAgent();
      (ollama.chat as jest.Mock).mockResolvedValue({
        content: 'ok',
        toolCalls: [],
      });

      agent.start(task.id, 'hello');
      await flush();

      const now = new Date();
      const expectedDate = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
      ].join('-');
      const chatCalls = (ollama.chat as jest.Mock).mock.calls as unknown[][];
      const firstCallMessages = chatCalls[0][0] as Array<{
        role: string;
        content: string;
      }>;
      expect(firstCallMessages[0].content).toContain(
        `current local date is ${expectedDate}`,
      );
    });

    it('does not retry once a real tool has already run earlier in the same turn', async () => {
      const { agent, ollama, mcp, task } = createAgent();
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'scan_directory',
                arguments: { path: 'D:\\my-work' },
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'ไม่พบไฟล์ที่ค้นหาเพิ่มเติมในโฟลเดอร์นี้',
          toolCalls: [],
        });
      (mcp.scanDirectory as jest.Mock).mockResolvedValue({ entries: [] });

      agent.start(task.id, 'หาไฟล์ในโฟลเดอร์นี้ให้หน่อย');
      await flush();

      expect(ollama.chat).toHaveBeenCalledTimes(2);
    });
  });

  describe('inferring search_files root from a project/folder the user already named', () => {
    let tmpWorkspace: string;

    beforeEach(() => {
      tmpWorkspace = mkdtempSync(join(tmpdir(), 'agent-workspace-'));
      mkdirSync(join(tmpWorkspace, 'my-sub-project'));
    });

    afterEach(() => {
      rmSync(tmpWorkspace, { recursive: true, force: true });
    });

    it('scopes into a named subfolder that exists directly under the workspace, without requiring permission', async () => {
      const { agent, mcp, ollama, task } = createAgent();
      task.workspacePath = tmpWorkspace;
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: { queries: ['package.json'] },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(
        task.id,
        'หา package.json ในโปรเจกต์ my-sub-project ให้หน่อย',
      );
      await flush();

      expect(mcp.searchFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          root: join(tmpWorkspace, 'my-sub-project'),
        }),
      );
    });

    it('redirects to scan_directory when the model puts the matched folder name itself as the only query (self-defeating for search_files)', async () => {
      const { agent, mcp, ollama, task } = createAgent();
      task.workspacePath = tmpWorkspace;
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: { queries: ['my-sub-project'] },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
      (mcp.scanDirectory as jest.Mock).mockResolvedValue({ entries: [] });

      agent.start(task.id, 'ในโปรเจกต์ my-sub-project มีไฟล์อะไรบ้าง');
      await flush();

      expect(mcp.scanDirectory).toHaveBeenCalledWith(
        join(tmpWorkspace, 'my-sub-project'),
      );
      expect(mcp.searchFiles).not.toHaveBeenCalled();
    });

    it('drops the matched folder name from queries but keeps searching when a real search term is combined with it', async () => {
      const { agent, mcp, ollama, task } = createAgent();
      task.workspacePath = tmpWorkspace;
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: {
                  queries: ['my-sub-project', 'package.json'],
                },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(
        task.id,
        'หา package.json ในโปรเจกต์ my-sub-project ให้หน่อย',
      );
      await flush();

      expect(mcp.searchFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          queries: ['package.json'],
          root: join(tmpWorkspace, 'my-sub-project'),
        }),
      );
    });

    it('scopes to the workspace itself on a generic "this project" reference', async () => {
      const { agent, mcp, ollama, task } = createAgent();
      task.workspacePath = tmpWorkspace;
      (ollama.chat as jest.Mock)
        .mockResolvedValueOnce({
          content: '',
          toolCalls: [
            {
              function: {
                name: 'search_files',
                arguments: { queries: ['package.json'] },
              },
            },
          ],
        })
        .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
      (mcp.searchFiles as jest.Mock).mockResolvedValue({ matches: [] });

      agent.start(task.id, 'หา package.json ในโปรเจกต์นี้ให้หน่อย');
      await flush();

      expect(mcp.searchFiles).toHaveBeenCalledWith(
        expect.objectContaining({ root: tmpWorkspace }),
      );
    });

    it('still searches everywhere (and asks permission) when nothing in the message names a real subfolder', async () => {
      const { agent, permissions, ollama, task } = createAgent();
      task.workspacePath = tmpWorkspace;
      (ollama.chat as jest.Mock).mockResolvedValue({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'search_files',
              arguments: { queries: ['package.json'] },
            },
          },
        ],
      });
      (permissions.create as jest.Mock).mockReturnValue({
        id: 'perm-scope',
        taskId: task.id,
        path: SEARCH_EVERYWHERE_LABEL,
        action: 'read_directory',
        access: 'read',
        status: 'pending',
        createdAt: 'now',
      });

      agent.start(task.id, 'หา package.json ให้หน่อย ไม่รู้อยู่ไหน');
      await flush();

      expect(permissions.create).toHaveBeenCalledWith(
        task.id,
        SEARCH_EVERYWHERE_LABEL,
      );
    });
  });

  describe('file link rendering', () => {
    type Linkifier = {
      linkifyFilePaths: (
        content: string,
        messages: Array<{ role: string; content: string }>,
      ) => string;
    };

    it('turns file paths returned by tools into encoded Markdown links', () => {
      const { agent } = createAgent();
      const linkifier = agent as unknown as Linkifier;
      const path = 'C:\\Reports\\Q1 (final).txt';

      const result = linkifier.linkifyFilePaths(`Open \`${path}\``, [
        {
          role: 'tool',
          content: JSON.stringify({
            entries: [{ name: 'Q1 [final].txt', path }],
          }),
        },
      ]);

      expect(result).toBe(
        'Open [Q1 \\[final\\].txt](http://localhost:3200/api/files/open?path=C%3A%5CReports%5CQ1%20(final).txt)\nตำแหน่ง: `C:\\Reports\\Q1 (final).txt`',
      );
    });

    it('ignores non-tool, malformed, and incomplete tool messages', () => {
      const { agent } = createAgent();
      const linkifier = agent as unknown as Linkifier;
      const content = 'Keep this unchanged';

      expect(
        linkifier.linkifyFilePaths(content, [
          { role: 'assistant', content: '{"entries":[]}' },
          { role: 'tool', content: 'not json' },
          { role: 'tool', content: 'null' },
          {
            role: 'tool',
            content: '{"matches":[null,{}, {"name":1,"path":2}]}',
          },
        ]),
      ).toBe(content);
    });

    it('links a bare filename when the model never repeats the full path (the common case for scan_directory summaries)', () => {
      const { agent } = createAgent();
      const linkifier = agent as unknown as Linkifier;
      const path = 'D:\\my-work\\dockers\\docker-compose.yml';

      const result = linkifier.linkifyFilePaths(
        'ไฟล์ docker-compose.yml ขนาด 970 ไบต์',
        [
          {
            role: 'tool',
            content: JSON.stringify({
              entries: [{ name: 'docker-compose.yml', path }],
            }),
          },
        ],
      );

      expect(result).toBe(
        `ไฟล์ [docker-compose.yml](http://localhost:3200/api/files/open?path=${encodeURIComponent(path)}) ขนาด 970 ไบต์\nตำแหน่ง: \`${path}\``,
      );
    });

    it('keeps an existing trusted Markdown link intact and adds one path line', () => {
      const { agent } = createAgent();
      const linkifier = agent as unknown as Linkifier;
      const path = 'G:\\My Drive\\Ta\\finance.gsheet';
      const url = `http://localhost:3200/api/files/open?path=${encodeURIComponent(path)}`;

      const result = linkifier.linkifyFilePaths(
        `ชื่อ: [finance.gsheet](${url})`,
        [
          {
            role: 'tool',
            content: JSON.stringify({
              matches: [{ name: 'finance.gsheet', path }],
            }),
          },
        ],
      );

      expect(result).toBe(
        `ชื่อ: [finance.gsheet](${url})\nตำแหน่ง: \`${path}\``,
      );
    });

    it('replaces a model location field with separate filename and path lines', () => {
      const { agent } = createAgent();
      const linkifier = agent as unknown as Linkifier;
      const path = 'G:\\My Drive\\Ta\\finance.gsheet';
      const url = `http://localhost:3200/api/files/open?path=${encodeURIComponent(path)}`;

      const result = linkifier.linkifyFilePaths(
        `- **ตำแหน่ง**: [finance.gsheet](${url})`,
        [
          {
            role: 'tool',
            content: JSON.stringify({
              matches: [{ name: 'finance.gsheet', path }],
            }),
          },
        ],
      );

      expect(result).toBe(`- [finance.gsheet](${url})\nตำแหน่ง: \`${path}\``);
    });

    it('strips backticks around a bare filename rather than leaving the Markdown link nested inside a code span (observed: renders as literal text, not a link)', () => {
      const { agent } = createAgent();
      const linkifier = agent as unknown as Linkifier;
      const path = 'D:\\my-work\\dockers\\docker-compose.yml';

      const result = linkifier.linkifyFilePaths(
        'ไฟล์ `docker-compose.yml` (ขนาด 970 ไบต์)',
        [
          {
            role: 'tool',
            content: JSON.stringify({
              entries: [{ name: 'docker-compose.yml', path }],
            }),
          },
        ],
      );

      expect(result).toBe(
        `ไฟล์ [docker-compose.yml](http://localhost:3200/api/files/open?path=${encodeURIComponent(path)}) (ขนาด 970 ไบต์)\nตำแหน่ง: \`${path}\``,
      );
    });

    it('does not link an ambiguous bare name shared by multiple results, to avoid pointing at the wrong file', () => {
      const { agent } = createAgent();
      const linkifier = agent as unknown as Linkifier;
      const content = 'พบ README.md สองไฟล์';

      const result = linkifier.linkifyFilePaths(content, [
        {
          role: 'tool',
          content: JSON.stringify({
            matches: [
              { name: 'README.md', path: 'D:\\my-work\\a\\README.md' },
              { name: 'README.md', path: 'D:\\my-work\\b\\README.md' },
            ],
          }),
        },
      ]);

      expect(result).toBe(content);
    });

    it('does not let a bare name match as a prefix of a longer filename that shares the same stem', () => {
      const { agent } = createAgent();
      const linkifier = agent as unknown as Linkifier;

      const result = linkifier.linkifyFilePaths('ดูไฟล์ README.md ก่อน', [
        {
          role: 'tool',
          content: JSON.stringify({
            entries: [
              { name: 'README', path: 'D:\\my-work\\README' },
              { name: 'README.md', path: 'D:\\my-work\\README.md' },
            ],
          }),
        },
      ]);

      expect(result).toBe(
        `ดูไฟล์ [README.md](http://localhost:3200/api/files/open?path=${encodeURIComponent('D:\\my-work\\README.md')}) ก่อน\nตำแหน่ง: \`D:\\my-work\\README.md\``,
      );
    });

    it('does not inject a bare-name link into an incorrect path written by the model', () => {
      const { agent } = createAgent();
      const linkifier = agent as unknown as Linkifier;
      const content = 'พบ D:\\my-work\\docker\\README หนึ่งไฟล์';

      const result = linkifier.linkifyFilePaths(content, [
        {
          role: 'tool',
          content: JSON.stringify({
            matches: [{ name: 'README', path: 'D:\\my-work\\dockers\\README' }],
          }),
        },
      ]);

      expect(result).toBe(content);
    });
  });

  it('refuses a file-content summary if the model ignores read_file twice', async () => {
    const { agent, tasks, ollama, mcp, task } = createAgent();
    (ollama.chat as jest.Mock).mockResolvedValue({
      content: 'เดาจากชื่อไฟล์',
      toolCalls: [],
    });

    agent.start(task.id, 'README.md พูดถึงอะไร สรุปเนื้อหาให้หน่อย');
    await flush();

    expect(ollama.chat).toHaveBeenCalledTimes(2);
    expect(mcp.scanDirectory).not.toHaveBeenCalled();
    expect(mcp.searchFiles).not.toHaveBeenCalled();
    expect(mcp.readFile).not.toHaveBeenCalled();
    expect(tasks.addMessage).toHaveBeenCalledWith(
      task.id,
      'assistant',
      FILE_CONTENT_UNAVAILABLE_RESPONSE,
      undefined,
      undefined,
    );
    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'completed');
  });

  it("caps read_file at a model-facing default maxBytes when the model omits it, instead of the tool's own larger default", async () => {
    const { agent, mcp, ollama, task } = createAgent();
    (ollama.chat as jest.Mock)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'read_file',
              arguments: { path: 'D:\\my-work\\README.md' },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
    (mcp.readFile as jest.Mock).mockResolvedValue({
      path: 'D:\\my-work\\README.md',
      content: '# Project',
      truncated: false,
    });

    agent.start(task.id, 'อ่าน README.md');
    await flush();

    expect(mcp.readFile).toHaveBeenCalledWith(
      'D:\\my-work\\README.md',
      6 * 1024,
    );
  });

  it('executes read_file and allows a content summary only after real content is returned', async () => {
    const { agent, tasks, ollama, mcp, task } = createAgent();
    (ollama.chat as jest.Mock)
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            function: {
              name: 'read_file',
              arguments: { path: 'D:\\my-work\\README.md', maxBytes: 4096 },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ content: 'สรุปจากเนื้อหาจริง', toolCalls: [] });
    (mcp.readFile as jest.Mock).mockResolvedValue({
      path: 'D:\\my-work\\README.md',
      content: '# Project',
      truncated: false,
    });

    agent.start(task.id, 'อ่าน README.md แล้วสรุปเนื้อหา');
    await flush();

    expect(mcp.readFile).toHaveBeenCalledWith('D:\\my-work\\README.md', 4096);
    expect(tasks.addMessage).toHaveBeenCalledWith(
      task.id,
      'assistant',
      'สรุปจากเนื้อหาจริง',
      undefined,
      expect.anything(),
    );
  });

  describe('memory', () => {
    it('includes the memory context prompt as a system message when the store has matching records', async () => {
      const { agent, ollama, memory, task } = createAgent();
      (memory.buildContextPrompt as jest.Mock).mockReturnValue(
        'Remembered context from previous sessions:\n- ชอบคำตอบสั้น',
      );
      (ollama.chat as jest.Mock).mockResolvedValue({
        content: 'ok',
        toolCalls: [],
      });

      agent.start(task.id, 'hello');
      await flush();

      expect(memory.getContextFor).toHaveBeenCalledWith(task.workspacePath);
      const chatMock = ollama.chat as jest.Mock<
        Promise<{ content: string; toolCalls: unknown[] }>,
        [OllamaChatMessage[]]
      >;
      const sentMessages = chatMock.mock.calls[0][0];
      expect(
        sentMessages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('ชอบคำตอบสั้น'),
        ),
      ).toBe(true);
    });

    it('does not add a memory system message when there is nothing remembered', async () => {
      const { agent, ollama, task } = createAgent();
      (ollama.chat as jest.Mock).mockResolvedValue({
        content: 'ok',
        toolCalls: [],
      });

      agent.start(task.id, 'hello');
      await flush();

      const chatMock = ollama.chat as jest.Mock<
        Promise<{ content: string; toolCalls: unknown[] }>,
        [OllamaChatMessage[]]
      >;
      const sentMessages = chatMock.mock.calls[0][0];
      expect(
        sentMessages.some((message) =>
          message.content.includes('Remembered context'),
        ),
      ).toBe(false);
    });

    it('extracts memories from a normal completed turn and applies them', async () => {
      const { agent, ollama, memory, task } = createAgent();
      (ollama.chat as jest.Mock).mockResolvedValue({
        content: 'ยินดีครับ',
        toolCalls: [],
      });
      (ollama.extractMemories as jest.Mock).mockResolvedValue([
        { scope: 'global', text: 'ชอบภาษาไทย' },
      ]);

      agent.start(task.id, 'สวัสดี ผมชอบคุยเป็นภาษาไทย');
      await flush();
      await flush();

      expect(ollama.extractMemories).toHaveBeenCalledWith(
        'สวัสดี ผมชอบคุยเป็นภาษาไทย',
        'ยินดีครับ',
        null,
      );
      expect(memory.applyExtracted).toHaveBeenCalledWith(
        [{ scope: 'global', text: 'ชอบภาษาไทย' }],
        task.workspacePath,
        task.id,
      );
    });

    it('does not fail the turn when extractMemories throws', async () => {
      const { agent, tasks, ollama, task } = createAgent();
      (ollama.chat as jest.Mock).mockResolvedValue({
        content: 'ok',
        toolCalls: [],
      });
      (ollama.extractMemories as jest.Mock).mockRejectedValue(
        new Error('ollama down'),
      );

      agent.start(task.id, 'hello');
      await flush();
      await flush();

      expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'completed');
    });

    it('does not trigger memory extraction for the canned mutation-refusal response', async () => {
      const { agent, ollama, memory, task } = createAgent();

      agent.start(task.id, 'ลบไฟล์ report.pdf ให้หน่อย');
      await flush();
      await flush();

      expect(ollama.chat).not.toHaveBeenCalled();
      expect(ollama.extractMemories).not.toHaveBeenCalled();
      expect(memory.applyExtracted).not.toHaveBeenCalled();
    });
  });
});
