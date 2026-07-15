import { ApiProperty } from '@nestjs/swagger';

export class OpenFileResultDto {
  @ApiProperty() opened: boolean;
}
