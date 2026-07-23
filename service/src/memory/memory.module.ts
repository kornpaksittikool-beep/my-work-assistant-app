import { Module } from '@nestjs/common';
import { MemoryController } from './memory.controller';
import { MemoryRepository } from './memory.repository';
import { MemoryService } from './memory.service';

@Module({
  controllers: [MemoryController],
  providers: [MemoryService, MemoryRepository],
  exports: [MemoryService],
})
export class MemoryModule {}
