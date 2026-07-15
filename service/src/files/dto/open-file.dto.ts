import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class OpenFileDto {
  @ApiProperty({ example: 'G:\\My Drive\\Ta\\เก็บเงินเครียหนี้.gsheet' })
  @IsString()
  @IsNotEmpty()
  path: string;
}
