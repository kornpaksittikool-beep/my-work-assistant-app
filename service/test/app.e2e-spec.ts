import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { createTestApp } from './utils/create-test-app';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = createTestApp(moduleFixture);
    await app.init();
  });

  it('/api/health (GET)', () => {
    return request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect((res: request.Response) => {
        expect(res.body).toMatchObject({
          success: true,
          data: { status: 'ok', service: 'assistant-service' },
        });
      });
  });

  it('creates and reads a task', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/tasks')
      .send({ title: 'Scan project', workspacePath: 'D:\\my-work' })
      .expect(201);
    const taskId = created.body.data.id as string;
    await request(app.getHttpServer())
      .get(`/api/tasks/${taskId}`)
      .expect(200)
      .expect((res: request.Response) => {
        expect(res.body.data).toMatchObject({
          id: taskId,
          title: 'Scan project',
          status: 'idle',
        });
      });
  });

  afterEach(async () => {
    await app.close();
  });
});
