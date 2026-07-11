import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class ResolvePermissionDto {
  @ApiProperty({ enum: ['allow', 'deny'] })
  @IsIn(['allow', 'deny'])
  decision: 'allow' | 'deny';
}
