import { ApiProperty } from '@nestjs/swagger';

export class TaskResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() title: string;
  @ApiProperty() workspacePath: string;
  @ApiProperty() status: string;
  @ApiProperty({ type: 'array', items: { type: 'object' } })
  messages: unknown[];
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}
