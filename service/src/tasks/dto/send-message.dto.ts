import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SendMessageDto {
  @ApiProperty({ example: 'ช่วยสแกนและสรุปไฟล์ใน workspace' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20_000)
  content: string;
}
