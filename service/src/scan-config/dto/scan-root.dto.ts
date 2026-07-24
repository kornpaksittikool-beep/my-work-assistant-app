import { ApiProperty } from '@nestjs/swagger';

export class ScanRootDto {
  @ApiProperty({ example: 'D:\\' })
  path: string;

  @ApiProperty({ example: true })
  accessible: boolean;
}

export class ScanRootBrowseEntryDto {
  @ApiProperty({ example: 'Projects' })
  name: string;

  @ApiProperty({ example: 'D:\\Projects' })
  path: string;

  @ApiProperty({ example: true })
  accessible: boolean;
}

export class ScanRootBrowseResultDto {
  @ApiProperty({ example: 'D:\\', nullable: true })
  path: string | null;

  @ApiProperty({ example: null, nullable: true })
  parent: string | null;

  @ApiProperty({ type: [ScanRootBrowseEntryDto] })
  entries: ScanRootBrowseEntryDto[];
}
