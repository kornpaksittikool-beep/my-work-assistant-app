import { applyDecorators, HttpStatus, Type } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ApiSuccessResponse } from './api-success-response.decorator';
import { ErrorResponseDto } from '../dto/error-response.dto';

interface ApiEndpointOptions<TModel extends Type<unknown>> {
  summary: string;
  type: TModel;
  status?: number;
  description?: string;
  isArray?: boolean;
  /** additional error status codes beyond the default 400 (e.g. [401, 404]) */
  extraErrors?: number[];
}

export function ApiEndpoint<TModel extends Type<unknown>>({
  summary,
  type,
  status = HttpStatus.OK,
  description,
  isArray = false,
  extraErrors = [],
}: ApiEndpointOptions<TModel>) {
  return applyDecorators(
    ApiOperation({ summary }),
    ApiSuccessResponse(type, { status, description, isArray }),
    ApiResponse({
      status: HttpStatus.BAD_REQUEST,
      description: 'ข้อมูลไม่ผ่าน validation',
      type: ErrorResponseDto,
    }),
    ...extraErrors.map((code) =>
      ApiResponse({ status: code, type: ErrorResponseDto }),
    ),
  );
}
