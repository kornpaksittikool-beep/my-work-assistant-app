import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentService, SEARCH_EVERYWHERE_LABEL } from './agent.service';
import { TasksRepository } from '../tasks/tasks.repository';
import { TaskEventsService } from '../tasks/task-events.service';
import { OllamaService } from '../ollama/ollama.service';
import { McpClientService } from '../mcp/mcp-client.service';
import { PermissionsService } from '../permissions/permissions.service';
import { AssistantTask } from '../tasks/task.types';

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
      addMessage: jest.fn(),
      setStatus: jest.fn(),
      findOne: jest.fn().mockReturnValue(task),
    } as unknown as TasksRepository;
    const events = { emit: jest.fn() } as unknown as TaskEventsService;
    const ollama = { chat: jest.fn() } as unknown as OllamaService;
    const mcp = {
      scanDirectory: jest.fn(),
      searchFiles: jest.fn(),
    } as unknown as McpClientService;
    const permissions = {
      create: jest.fn(),
      findOne: jest.fn(),
      resolve: jest.fn(),
    } as unknown as PermissionsService;
    const config = { get: () => maxSteps } as unknown as ConfigService;

    const agent = new AgentService(
      tasks,
      events,
      ollama,
      mcp,
      permissions,
      config,
    );
    return { agent, tasks, events, ollama, mcp, permissions, task };
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

    expect(tasks.addMessage).toHaveBeenCalledWith(task.id, 'assistant', 'Done');
    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'completed');
    expect(events.emit).toHaveBeenCalledWith(task.id, 'completed', {
      status: 'completed',
      stepsUsed: 1,
    });
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
    );
    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'completed');
    expect(events.emit).toHaveBeenCalledWith(task.id, 'completed', {
      status: 'completed',
      stepsUsed: 2,
    });
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

  it('stops the task when permission is denied', async () => {
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
      status: 'denied',
    });

    agent.start(task.id, 'scan outside');
    await flush();

    agent.resolvePermission(task.id, 'perm-1', false);

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

  it('marks the task failed when the tool call throws after permission is resumed', async () => {
    const { agent, tasks, events, ollama, mcp, permissions, task } =
      createAgent();
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
      id: 'perm-5',
      taskId: task.id,
      path: 'C:\\Windows',
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
      new Error('disk unreadable'),
    );

    agent.start(task.id, 'scan outside');
    await flush();

    agent.resolvePermission(task.id, 'perm-5', true);
    await flush();

    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'failed');
    expect(events.emit).toHaveBeenCalledWith(task.id, 'error', {
      message: 'disk unreadable',
    });
  });

  it('stringifies a non-Error thrown value when marking the task failed', async () => {
    const { agent, tasks, events, ollama, mcp, task } = createAgent();
    (ollama.chat as jest.Mock).mockResolvedValue({
      content: '',
      toolCalls: [
        {
          function: {
            name: 'scan_directory',
            arguments: { path: task.workspacePath },
          },
        },
      ],
    });
    (mcp.scanDirectory as jest.Mock).mockRejectedValue('boom-string');

    agent.start(task.id, 'scan');
    await flush();

    expect(tasks.setStatus).toHaveBeenCalledWith(task.id, 'failed');
    expect(events.emit).toHaveBeenCalledWith(task.id, 'error', {
      message: 'boom-string',
    });
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
        maxResults: undefined,
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
        maxResults: undefined,
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
        maxResults: undefined,
        maxDepth: undefined,
      });
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
});
