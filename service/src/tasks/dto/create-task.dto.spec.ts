import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTaskDto } from './create-task.dto';

describe('CreateTaskDto', () => {
  it('passes validation with only a workspacePath', async () => {
    const dto = plainToInstance(CreateTaskDto, {
      workspacePath: 'D:\\my-work',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('passes validation with a title and workspacePath', async () => {
    const dto = plainToInstance(CreateTaskDto, {
      title: 'สรุปไฟล์ในโปรเจกต์',
      workspacePath: 'D:\\my-work',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('fails when workspacePath is missing', async () => {
    const dto = plainToInstance(CreateTaskDto, {});
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'workspacePath')).toBe(true);
  });

  it('fails when workspacePath is empty', async () => {
    const dto = plainToInstance(CreateTaskDto, { workspacePath: '' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'workspacePath')).toBe(true);
  });

  it('fails when title exceeds the max length', async () => {
    const dto = plainToInstance(CreateTaskDto, {
      title: 'a'.repeat(121),
      workspacePath: 'D:\\my-work',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'title')).toBe(true);
  });

  it('fails when title is not a string', async () => {
    const dto = plainToInstance(CreateTaskDto, {
      title: 123,
      workspacePath: 'D:\\my-work',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'title')).toBe(true);
  });
});
