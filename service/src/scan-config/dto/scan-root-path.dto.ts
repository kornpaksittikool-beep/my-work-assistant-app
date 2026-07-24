import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class ScanRootPathDto {
  @ApiProperty({ example: 'D:\\' })
  @IsString()
  @IsNotEmpty()
  path: string;
}
