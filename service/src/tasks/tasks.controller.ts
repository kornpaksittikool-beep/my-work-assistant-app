import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  MessageEvent,
  Param,
  Post,
  Sse,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { AgentService } from '../agent/agent.service';
import { ApiEndpoint } from '../common/decorators/api-endpoint.decorator';
import { SkipEnvelope } from '../common/decorators/skip-envelope.decorator';
import { ResolvePermissionDto } from '../permissions/dto/resolve-permission.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { TaskResponseDto } from './dto/task-response.dto';
import { TaskEventsService } from './task-events.service';
import { TasksRepository } from './tasks.repository';
import type { AssistantTask } from './task.types';

@ApiTags('tasks')
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksRepository,
    private readonly events: TaskEventsService,
    private readonly agent: AgentService,
  ) {}

  @Post()
  @ApiEndpoint({
    summary: 'สร้าง task ใหม่',
    type: TaskResponseDto,
    status: 201,
  })
  create(@Body() dto: CreateTaskDto): AssistantTask {
    return this.tasks.create(dto.title?.trim() || 'งานใหม่', dto.workspacePath);
  }

  @Get()
  @ApiEndpoint({
    summary: 'ดูรายการ task',
    type: TaskResponseDto,
    isArray: true,
  })
  findAll(): AssistantTask[] {
    return this.tasks.findAll();
  }

  @Get(':id')
  @ApiEndpoint({
    summary: 'ดู task และข้อความ',
    type: TaskResponseDto,
    extraErrors: [404],
  })
  findOne(@Param('id') id: string): AssistantTask {
    return this.tasks.findOne(id);
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiEndpoint({
    summary: 'ส่งข้อความและเริ่ม agent',
    type: TaskResponseDto,
    status: 202,
    extraErrors: [404, 502],
  })
  sendMessage(
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ): AssistantTask {
    this.tasks.findOne(id);
    this.agent.start(id, dto.content);
    return this.tasks.findOne(id);
  }

  @Sse(':id/events')
  @SkipEnvelope()
  eventsStream(@Param('id') id: string): Observable<MessageEvent> {
    this.tasks.findOne(id);
    return this.events.stream(id);
  }

  @Post(':id/permissions/:permissionId')
  @ApiEndpoint({
    summary: 'อนุญาตหรือปฏิเสธ permission request',
    type: TaskResponseDto,
    extraErrors: [404],
  })
  resolvePermission(
    @Param('id') id: string,
    @Param('permissionId') permissionId: string,
    @Body() dto: ResolvePermissionDto,
  ): AssistantTask {
    this.tasks.findOne(id);
    this.agent.resolvePermission(id, permissionId, dto.decision === 'allow');
    return this.tasks.findOne(id);
  }

  @Post(':id/stop')
  @ApiEndpoint({
    summary: 'หยุด agent task',
    type: TaskResponseDto,
    extraErrors: [404],
  })
  stop(@Param('id') id: string): AssistantTask {
    this.tasks.findOne(id);
    this.agent.stop(id);
    return this.tasks.findOne(id);
  }
}
