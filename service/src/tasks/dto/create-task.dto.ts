import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateTaskDto {
  @ApiProperty({ example: 'สรุปไฟล์ในโปรเจกต์', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiProperty({ example: 'D:\\my-work' })
  @IsString()
  @IsNotEmpty()
  workspacePath: string;
}
