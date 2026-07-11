import { applyDecorators, HttpStatus, Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';

interface ApiSuccessResponseOptions {
  status?: number;
  description?: string;
  isArray?: boolean;
}

export function ApiSuccessResponse<TModel extends Type<unknown>>(
  model: TModel,
  {
    status = HttpStatus.OK,
    description,
    isArray = false,
  }: ApiSuccessResponseOptions = {},
) {
  return applyDecorators(
    ApiExtraModels(model),
    ApiResponse({
      status,
      description,
      schema: {
        allOf: [
          {
            properties: {
              success: { type: 'boolean', example: true },
              statusCode: { type: 'number', example: status },
              data: isArray
                ? { type: 'array', items: { $ref: getSchemaPath(model) } }
                : { $ref: getSchemaPath(model) },
              timestamp: { type: 'string', example: new Date().toISOString() },
              path: { type: 'string', example: '/api/items' },
            },
          },
        ],
      },
    }),
  );
}
