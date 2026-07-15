import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ApiEndpoint } from '../common/decorators/api-endpoint.decorator';
import { OpenFileDto } from './dto/open-file.dto';
import { OpenFileResultDto } from './dto/open-file-result.dto';
import { FilesService } from './files.service';

@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Get('open')
  @ApiEndpoint({
    summary: 'เปิดไฟล์หรือโฟลเดอร์ในเครื่องด้วยโปรแกรมเริ่มต้น',
    type: OpenFileResultDto,
    extraErrors: [404],
  })
  open(@Query() dto: OpenFileDto): OpenFileResultDto {
    this.files.open(dto.path);
    return { opened: true };
  }
}
