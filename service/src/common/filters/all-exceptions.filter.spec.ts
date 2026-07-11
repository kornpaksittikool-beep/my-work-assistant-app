import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  const createHost = (url = '/api/items', method = 'POST'): ArgumentsHost => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    const response = { status: statusMock };
    const request = { url, method };
    return {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    } as unknown as ArgumentsHost;
  };

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('formats a validation-style exception with an array message', () => {
    const host = createHost();
    filter.catch(new BadRequestException(['name should not be empty']), host);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        statusCode: 400,
        message: ['name should not be empty'],
        error: 'Bad Request',
        path: '/api/items',
      }),
    );
  });

  it('wraps a single-string HttpException message in an array', () => {
    const host = createHost('/api/items/42', 'GET');
    filter.catch(new NotFoundException('Item not found'), host);

    expect(statusMock).toHaveBeenCalledWith(404);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        message: ['Item not found'],
        error: 'Not Found',
        path: '/api/items/42',
      }),
    );
  });

  it('reads a plain string response body directly', () => {
    const host = createHost();
    filter.catch(
      new HttpException('Something went wrong', HttpStatus.BAD_REQUEST),
      host,
    );

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: ['Something went wrong'] }),
    );
  });

  it('falls back to exception.message when the response body has no message key', () => {
    const host = createHost();
    const exception = new HttpException(
      { reason: 'quota exceeded' },
      HttpStatus.FORBIDDEN,
    );

    filter.catch(exception, host);

    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 403,
        message: [exception.message],
        error: 'Forbidden',
      }),
    );
  });

  it('maps unexpected errors to a generic 500 without leaking internals', () => {
    const host = createHost();
    filter.catch(new Error('db connection refused: secret-host:5432'), host);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        statusCode: 500,
        message: ['Internal server error'],
        error: 'Internal Server Error',
      }),
    );
  });

  it('logs unexpected errors server-side with the stack trace', () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    const host = createHost();
    const error = new Error('boom');

    filter.catch(error, host);

    expect(errorSpy).toHaveBeenCalledWith('POST /api/items', error.stack);
  });

  it('does not log for ordinary client errors (4xx)', () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    const host = createHost();

    filter.catch(new BadRequestException(['bad input']), host);

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('falls back to a generic error label for a non-standard status code', () => {
    const host = createHost();
    filter.catch(new HttpException('weird', 999), host);

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 999, error: 'Error' }),
    );
  });

  it('stringifies a non-Error thrown value when logging', () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    const host = createHost();

    filter.catch('a thrown string, not an Error instance', host);

    expect(errorSpy).toHaveBeenCalledWith(
      'POST /api/items',
      'a thrown string, not an Error instance',
    );
  });
});
