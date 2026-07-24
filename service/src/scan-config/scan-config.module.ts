import { Module } from '@nestjs/common';
import { ScanConfigController } from './scan-config.controller';
import { ScanConfigClientService } from './scan-config-client.service';

@Module({
  controllers: [ScanConfigController],
  providers: [ScanConfigClientService],
})
export class ScanConfigModule {}
