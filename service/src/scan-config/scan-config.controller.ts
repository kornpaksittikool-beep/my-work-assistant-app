import { Body, Controller, Delete, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { ScanRoot, ScanRootBrowseResult } from '@assistant-app/contracts';
import { ApiEndpoint } from '../common/decorators/api-endpoint.decorator';
import { ScanConfigClientService } from './scan-config-client.service';
import { ScanRootBrowseQueryDto } from './dto/scan-root-browse-query.dto';
import { ScanRootBrowseResultDto, ScanRootDto } from './dto/scan-root.dto';
import { ScanRootPathDto } from './dto/scan-root-path.dto';

@ApiTags('scan-config')
@Controller('scan-config/roots')
export class ScanConfigController {
  constructor(private readonly client: ScanConfigClientService) {}

  @Get()
  @ApiEndpoint({
    summary: 'รายชื่อ root ที่อนุญาตให้สแกนอยู่ตอนนี้',
    type: ScanRootDto,
    isArray: true,
  })
  list(): Promise<ScanRoot[]> {
    return this.client.listRoots();
  }

  @Get('browse')
  @ApiEndpoint({
    summary:
      'ดูโฟลเดอร์ย่อยของ path ที่ระบุ (หรือรายชื่อไดรฟ์ถ้าไม่ระบุ) สำหรับตัวเลือกโฟลเดอร์',
    type: ScanRootBrowseResultDto,
    extraErrors: [403, 502],
  })
  browse(@Query() dto: ScanRootBrowseQueryDto): Promise<ScanRootBrowseResult> {
    return this.client.browse(dto.path);
  }

  @Post()
  @ApiEndpoint({
    summary: 'เพิ่ม root ใหม่',
    type: ScanRootDto,
    extraErrors: [403, 502],
  })
  add(@Body() dto: ScanRootPathDto): Promise<ScanRoot> {
    return this.client.addRoot(dto.path);
  }

  @Delete()
  @ApiEndpoint({
    summary: 'ลบ root ออกจากรายการที่อนุญาต',
    type: ScanRootDto,
    isArray: true,
    extraErrors: [404, 502],
  })
  remove(@Body() dto: ScanRootPathDto): Promise<ScanRoot[]> {
    return this.client.removeRoot(dto.path);
  }
}
