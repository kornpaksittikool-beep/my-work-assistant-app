import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ResolvePermissionDto } from './resolve-permission.dto';

describe('ResolvePermissionDto', () => {
  it('passes validation with "allow"', async () => {
    const dto = plainToInstance(ResolvePermissionDto, { decision: 'allow' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('passes validation with "deny"', async () => {
    const dto = plainToInstance(ResolvePermissionDto, { decision: 'deny' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('fails with a value outside allow/deny', async () => {
    const dto = plainToInstance(ResolvePermissionDto, { decision: 'maybe' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'decision')).toBe(true);
  });
});
