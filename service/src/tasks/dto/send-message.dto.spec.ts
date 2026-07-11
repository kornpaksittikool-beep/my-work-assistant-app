import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendMessageDto } from './send-message.dto';

describe('SendMessageDto', () => {
  it('passes validation with valid content', async () => {
    const dto = plainToInstance(SendMessageDto, {
      content: 'ช่วยสแกนไฟล์ให้หน่อย',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('fails when content is missing', async () => {
    const dto = plainToInstance(SendMessageDto, {});
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'content')).toBe(true);
  });

  it('fails when content is empty', async () => {
    const dto = plainToInstance(SendMessageDto, { content: '' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'content')).toBe(true);
  });

  it('fails when content exceeds the max length', async () => {
    const dto = plainToInstance(SendMessageDto, {
      content: 'a'.repeat(20_001),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'content')).toBe(true);
  });
});
