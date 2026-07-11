import { TasksController } from './tasks.controller';
import { TasksRepository } from './tasks.repository';
import { TaskEventsService } from './task-events.service';
import { AgentService } from '../agent/agent.service';
import { AssistantTask } from './task.types';

describe('TasksController', () => {
  const task: AssistantTask = {
    id: 'task-1',
    title: 'Test',
    workspacePath: 'D:\\my-work',
    status: 'idle',
    messages: [],
    createdAt: 'now',
    updatedAt: 'now',
  };

  const createController = () => {
    const tasks = {
      create: jest.fn().mockReturnValue(task),
      findAll: jest.fn().mockReturnValue([task]),
      findOne: jest.fn().mockReturnValue(task),
    } as unknown as TasksRepository;
    const events = {
      stream: jest.fn().mockReturnValue('stream-observable'),
    } as unknown as TaskEventsService;
    const agent = {
      start: jest.fn(),
      stop: jest.fn(),
      resolvePermission: jest.fn(),
    } as unknown as AgentService;

    return {
      controller: new TasksController(tasks, events, agent),
      tasks,
      events,
      agent,
    };
  };

  it('creates a task using the given title', () => {
    const { controller, tasks } = createController();

    controller.create({ title: 'My task', workspacePath: 'D:\\my-work' });

    expect(tasks.create).toHaveBeenCalledWith('My task', 'D:\\my-work');
  });

  it('falls back to a default title when none is given', () => {
    const { controller, tasks } = createController();

    controller.create({ workspacePath: 'D:\\my-work' });

    expect(tasks.create).toHaveBeenCalledWith('งานใหม่', 'D:\\my-work');
  });

  it('falls back to a default title when the given title is only whitespace', () => {
    const { controller, tasks } = createController();

    controller.create({ title: '   ', workspacePath: 'D:\\my-work' });

    expect(tasks.create).toHaveBeenCalledWith('งานใหม่', 'D:\\my-work');
  });

  it('lists all tasks', () => {
    const { controller } = createController();

    expect(controller.findAll()).toEqual([task]);
  });

  it('finds a single task', () => {
    const { controller, tasks } = createController();

    expect(controller.findOne('task-1')).toBe(task);
    expect(tasks.findOne).toHaveBeenCalledWith('task-1');
  });

  it('sends a message and starts the agent', () => {
    const { controller, agent } = createController();

    const result = controller.sendMessage('task-1', { content: 'hello' });

    expect(agent.start).toHaveBeenCalledWith('task-1', 'hello');
    expect(result).toBe(task);
  });

  it('streams events for a task', () => {
    const { controller, tasks } = createController();

    const result = controller.eventsStream('task-1');

    expect(tasks.findOne).toHaveBeenCalledWith('task-1');
    expect(result).toBe('stream-observable');
  });

  it('resolves a permission as allowed', () => {
    const { controller, agent } = createController();

    controller.resolvePermission('task-1', 'perm-1', { decision: 'allow' });

    expect(agent.resolvePermission).toHaveBeenCalledWith(
      'task-1',
      'perm-1',
      true,
    );
  });

  it('resolves a permission as denied', () => {
    const { controller, agent } = createController();

    controller.resolvePermission('task-1', 'perm-1', { decision: 'deny' });

    expect(agent.resolvePermission).toHaveBeenCalledWith(
      'task-1',
      'perm-1',
      false,
    );
  });

  it('stops a task', () => {
    const { controller, agent } = createController();

    controller.stop('task-1');

    expect(agent.stop).toHaveBeenCalledWith('task-1');
  });
});
