import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { SkipEnvelope } from '../decorators/skip-envelope.decorator';
import { TransformInterceptor } from './transform.interceptor';

class TestController {
  handler(): void {}

  @SkipEnvelope()
  skippedHandler(): void {}
}

describe('TransformInterceptor', () => {
  let interceptor: TransformInterceptor<unknown>;

  beforeEach(() => {
    interceptor = new TransformInterceptor(new Reflector());
  });

  const createContext = (
    statusCode: number,
    url: string,
    handler: () => void = TestController.prototype.handler,
  ): ExecutionContext => {
    const response = { statusCode };
    const request = { url };
    return {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
      getHandler: () => handler,
      getClass: () => TestController,
    } as unknown as ExecutionContext;
  };

  it('wraps the handler result in the success envelope', (done) => {
    const context = createContext(201, '/api/items');
    const next: CallHandler = { handle: () => of({ name: 'Laptop' }) };

    interceptor.intercept(context, next).subscribe((result) => {
      expect(result).toMatchObject({
        success: true,
        statusCode: 201,
        data: { name: 'Laptop' },
        path: '/api/items',
      });
      expect(typeof result.timestamp).toBe('string');
      done();
    });
  });

  it('reflects the actual response status code, not a hardcoded one', (done) => {
    const context = createContext(200, '/api');
    const next: CallHandler = { handle: () => of('Hello World!') };

    interceptor.intercept(context, next).subscribe((result) => {
      expect(result.statusCode).toBe(200);
      expect(result.data).toBe('Hello World!');
      done();
    });
  });

  it('passes the raw handler result through untouched when @SkipEnvelope is set', (done) => {
    const context = createContext(
      200,
      '/api/tasks/1/events',
      TestController.prototype.skippedHandler,
    );
    const next: CallHandler = { handle: () => of('raw-sse-payload') };

    interceptor.intercept(context, next).subscribe((result) => {
      expect(result).toBe('raw-sse-payload');
      done();
    });
  });

  it('defaults to constructing its own Reflector when none is injected', () => {
    expect(new TransformInterceptor()).toBeInstanceOf(TransformInterceptor);
  });
});
