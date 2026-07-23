import { ApiProperty } from '@nestjs/swagger';

export class MemoryResponseDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['global', 'workspace'] }) scope: string;
  @ApiProperty({ required: false }) workspacePath?: string;
  @ApiProperty() text: string;
  @ApiProperty() createdAt: string;
  @ApiProperty() sourceTaskId: string;
}
