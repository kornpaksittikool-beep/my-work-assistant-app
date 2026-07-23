import { Controller, Delete, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { MemoryRecord } from '@assistant-app/contracts';
import { ApiEndpoint } from '../common/decorators/api-endpoint.decorator';
import { MemoryResponseDto } from './dto/memory-response.dto';
import { MemoryService } from './memory.service';

@ApiTags('memory')
@Controller('memory')
export class MemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Get()
  @ApiEndpoint({
    summary: 'ดูความจำทั้งหมด (global + ทุก workspace)',
    type: MemoryResponseDto,
    isArray: true,
  })
  findAll(): MemoryRecord[] {
    return this.memory.listAll();
  }

  @Delete(':id')
  @ApiEndpoint({
    summary: 'ลบความจำหนึ่งรายการ',
    type: MemoryResponseDto,
    isArray: true,
  })
  remove(@Param('id') id: string): MemoryRecord[] {
    this.memory.remove(id);
    return this.memory.listAll();
  }
}
