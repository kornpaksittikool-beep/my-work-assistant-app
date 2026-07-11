import { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common/pipes/validation.pipe';
import { TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { TransformInterceptor } from '../../src/common/interceptors/transform.interceptor';

/** Mirrors the global setup in src/main.ts (minus Swagger) so e2e tests hit the same prefix/pipes/envelope as production. */
export function createTestApp(
  moduleFixture: TestingModule,
): INestApplication<App> {
  const app = moduleFixture.createNestApplication<INestApplication<App>>();

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  return app;
}
