import { Body, Controller, Post } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { ApiEndpoint } from './api-endpoint.decorator';

class FixtureDto {
  @ApiProperty()
  name: string;
}

interface JsonResponseSchema {
  $ref?: string;
  allOf?: Array<{ properties?: { data?: { $ref?: string } } }>;
}

function getJsonSchema(
  document: OpenAPIObject,
  path: string,
  status: string,
): JsonResponseSchema {
  const operation = document.paths[path]?.post;
  if (!operation) throw new Error(`no POST operation documented for ${path}`);

  const response = operation.responses?.[status];
  if (!response || !('content' in response)) {
    throw new Error(`no content documented for ${path} ${status}`);
  }

  return response.content?.['application/json']?.schema as JsonResponseSchema;
}

@Controller('items')
class TestController {
  @Post()
  @ApiEndpoint({
    summary: 'create an item',
    type: FixtureDto,
    status: 201,
    description: 'created',
  })
  create(@Body() dto: FixtureDto): FixtureDto {
    return dto;
  }
}

describe('ApiEndpoint', () => {
  it('documents the success envelope with data typed as the given model, plus a default 400', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TestController],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const operation = document.paths['/items']?.post;
    expect(operation?.summary).toBe('create an item');

    const successSchema = getJsonSchema(document, '/items', '201');
    expect(successSchema.allOf?.[0]?.properties?.data).toEqual({
      $ref: '#/components/schemas/FixtureDto',
    });

    const errorSchema = getJsonSchema(document, '/items', '400');
    expect(errorSchema.$ref).toBe('#/components/schemas/ErrorResponseDto');

    expect(Object.keys(document.components?.schemas ?? {})).toEqual(
      expect.arrayContaining(['FixtureDto', 'ErrorResponseDto']),
    );

    await app.close();
  });

  it('documents extra error status codes when provided', async () => {
    @Controller('secure-items')
    class SecureController {
      @Post()
      @ApiEndpoint({
        summary: 'create a protected item',
        type: FixtureDto,
        status: 201,
        extraErrors: [401, 404],
      })
      create(@Body() dto: FixtureDto): FixtureDto {
        return dto;
      }
    }

    const moduleRef = await Test.createTestingModule({
      controllers: [SecureController],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const operation = document.paths['/secure-items']?.post;

    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(['201', '400', '401', '404']),
    );

    await app.close();
  });

  it('defaults to status 200 when status is omitted', async () => {
    @Controller('default-status-items')
    class DefaultStatusController {
      @Post()
      @ApiEndpoint({
        summary: 'create with default status',
        type: FixtureDto,
      })
      create(@Body() dto: FixtureDto): FixtureDto {
        return dto;
      }
    }

    const moduleRef = await Test.createTestingModule({
      controllers: [DefaultStatusController],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const operation = document.paths['/default-status-items']?.post;

    expect(Object.keys(operation?.responses ?? {})).toContain('200');

    await app.close();
  });
});
