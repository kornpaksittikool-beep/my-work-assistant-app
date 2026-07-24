import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ScanRootBrowseQueryDto {
  @ApiPropertyOptional({ example: 'D:\\Projects' })
  @IsOptional()
  @IsString()
  path?: string;
}
