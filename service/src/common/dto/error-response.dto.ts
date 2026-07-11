import { ApiProperty } from '@nestjs/swagger';

export class ErrorResponseDto {
  @ApiProperty({ example: false })
  success: false;

  @ApiProperty({ example: 400 })
  statusCode: number;

  @ApiProperty({ type: [String], example: ['name should not be empty'] })
  message: string[];

  @ApiProperty({ example: 'Bad Request' })
  error: string;

  @ApiProperty({ example: '2026-07-10T16:07:17.428Z' })
  timestamp: string;

  @ApiProperty({ example: '/api/items' })
  path: string;
}
