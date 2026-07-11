import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import { App } from 'supertest/types';
import { setupSwagger } from './swagger.config';

@Controller()
class PingController {
  @Get('ping')
  ping(): string {
    return 'pong';
  }
}

describe('setupSwagger', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PingController],
    }).compile();

    app = moduleRef.createNestApplication();
    setupSwagger(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves an OpenAPI document at /docs-json with the expected metadata', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    const document = response.body as OpenAPIObject;

    expect(document.info).toMatchObject({
      title: 'Assistant Service API',
      description: 'Agent Service REST API Documentation',
      version: '1.0.0',
    });
    expect(document.components?.securitySchemes?.['JWT-auth']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
    expect(document.paths['/ping']).toBeDefined();
  });

  it('serves the Swagger UI page at /docs', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs')
      .expect(200);

    expect(response.text).toContain('Assistant Service API Docs');
  });
});
