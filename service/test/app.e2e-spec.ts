import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { createTestApp } from './utils/create-test-app';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;
  let dataDir: string;

  const startApp = async (): Promise<INestApplication<App>> => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const instance = createTestApp(moduleFixture);
    await instance.init();
    return instance;
  };

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'assistant-e2e-'));
    process.env.TASKS_DATA_FILE = join(dataDir, 'tasks.json');
    app = await startApp();
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

  it('renames, archives and deletes a task through the API', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/tasks')
      .send({ title: 'Original', workspacePath: 'D:\\my-work' })
      .expect(201);
    const taskId = created.body.data.id as string;

    await request(app.getHttpServer())
      .patch(`/api/tasks/${taskId}`)
      .send({ title: 'Renamed', archived: true })
      .expect(200)
      .expect((res: request.Response) => {
        expect(res.body.data).toMatchObject({
          id: taskId,
          title: 'Renamed',
          archived: true,
        });
      });

    await request(app.getHttpServer())
      .get('/api/tasks')
      .expect(200)
      .expect((res: request.Response) => {
        expect(res.body.data).toEqual([]);
      });

    await request(app.getHttpServer())
      .delete(`/api/tasks/${taskId}`)
      .expect(200);
    await request(app.getHttpServer()).get(`/api/tasks/${taskId}`).expect(404);
  });

  it('keeps a conversation after a full application restart', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/tasks')
      .send({ title: 'Survive restart', workspacePath: 'D:\\my-work' })
      .expect(201);
    const taskId = created.body.data.id as string;

    await app.close();
    app = await startApp();

    await request(app.getHttpServer())
      .get(`/api/tasks/${taskId}`)
      .expect(200)
      .expect((res: request.Response) => {
        expect(res.body.data).toMatchObject({
          id: taskId,
          title: 'Survive restart',
        });
      });
  });

  afterEach(async () => {
    await app.close();
    delete process.env.TASKS_DATA_FILE;
    rmSync(dataDir, { recursive: true, force: true });
  });
});
