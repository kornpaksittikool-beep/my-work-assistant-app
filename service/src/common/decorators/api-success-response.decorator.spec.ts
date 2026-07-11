import { Controller, Get } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { ApiSuccessResponse } from './api-success-response.decorator';

class FixtureDto {
  @ApiProperty()
  name: string;
}

interface JsonResponseSchema {
  allOf?: Array<{ properties?: { data?: unknown } }>;
}

function getJsonSchema(
  document: OpenAPIObject,
  path: string,
  status: string,
): JsonResponseSchema {
  const operation = document.paths[path]?.get;
  const response = operation?.responses?.[status];
  if (!response || !('content' in response)) {
    throw new Error(`no content documented for ${path} ${status}`);
  }
  return response.content?.['application/json']?.schema as JsonResponseSchema;
}

async function buildDocument(
  ControllerClass: new () => unknown,
): Promise<OpenAPIObject> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ControllerClass],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().build(),
  );
  await app.close();
  return document;
}

describe('ApiSuccessResponse', () => {
  it('defaults to status 200 when no options are given', async () => {
    @Controller('default-status')
    class DefaultStatusController {
      @Get()
      @ApiSuccessResponse(FixtureDto)
      find(): FixtureDto[] {
        return [];
      }
    }

    const document = await buildDocument(DefaultStatusController);
    const operation = document.paths['/default-status']?.get;

    expect(Object.keys(operation?.responses ?? {})).toContain('200');
    const schema = getJsonSchema(document, '/default-status', '200');
    expect(schema.allOf?.[0]?.properties?.data).toEqual({
      $ref: '#/components/schemas/FixtureDto',
    });
  });

  it('documents data as an array of the model when isArray is true', async () => {
    @Controller('list-items')
    class ListController {
      @Get()
      @ApiSuccessResponse(FixtureDto, { status: 200, isArray: true })
      find(): FixtureDto[] {
        return [];
      }
    }

    const document = await buildDocument(ListController);
    const schema = getJsonSchema(document, '/list-items', '200');

    expect(schema.allOf?.[0]?.properties?.data).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/FixtureDto' },
    });
  });
});
