import { Controller, Get } from '@nestjs/common';
import { AppService, HealthStatus } from './app.service';

@Controller('health')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHealth(): Promise<HealthStatus> {
    return this.appService.getHealth();
  }
}
