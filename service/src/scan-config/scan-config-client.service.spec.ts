import { BadGatewayException, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScanConfigClientService } from './scan-config-client.service';

describe('ScanConfigClientService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const createService = (url?: string) => {
    const configService = { get: () => url } as unknown as ConfigService;
    return new ScanConfigClientService(configService);
  };

  const mockFetchJson = (body: unknown, ok = true, status = ok ? 200 : 400) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(body),
    });
  };

  it('listRoots returns the roots array from the envelope', async () => {
    mockFetchJson({ data: { roots: [{ path: 'D:\\', accessible: true }] } });
    const service = createService();

    await expect(service.listRoots()).resolves.toEqual([
      { path: 'D:\\', accessible: true },
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3201/api/roots',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses the configured SCAN_REST_URL when provided', async () => {
    mockFetchJson({ data: { roots: [] } });
    const service = createService('http://scan-host:3201/api');

    await service.listRoots();

    expect(global.fetch).toHaveBeenCalledWith(
      'http://scan-host:3201/api/roots',
      expect.any(Object),
    );
  });

  it('browse fetches the roots/browse endpoint with an encoded path query', async () => {
    mockFetchJson({ data: { path: 'D:\\', parent: null, entries: [] } });
    const service = createService();

    await expect(service.browse('D:\\Projects')).resolves.toEqual({
      path: 'D:\\',
      parent: null,
      entries: [],
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3201/api/roots/browse?path=D%3A%5CProjects',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('browse omits the query string when no path is given', async () => {
    mockFetchJson({ data: { path: null, parent: null, entries: [] } });
    const service = createService();

    await service.browse();

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3201/api/roots/browse',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('addRoot posts the path and returns the created entry', async () => {
    mockFetchJson({ data: { path: 'D:\\', accessible: true } });
    const service = createService();

    await expect(service.addRoot('D:\\')).resolves.toEqual({
      path: 'D:\\',
      accessible: true,
    });
    const [, requestInit] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      { method: string; body: string },
    ];
    expect(requestInit.method).toBe('POST');
    expect(JSON.parse(requestInit.body)).toEqual({ path: 'D:\\' });
  });

  it('removeRoot deletes the path and returns the fresh list', async () => {
    mockFetchJson({ data: { roots: [] } });
    const service = createService();

    await expect(service.removeRoot('D:\\')).resolves.toEqual([]);
    const [, requestInit] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      { method: string },
    ];
    expect(requestInit.method).toBe('DELETE');
  });

  it('throws BadGatewayException when the request itself fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const service = createService();

    await expect(service.listRoots()).rejects.toThrow(BadGatewayException);
  });

  it('stringifies a non-Error thrown value in the connection failure message', async () => {
    global.fetch = jest.fn().mockRejectedValue('ECONNREFUSED');
    const service = createService();

    await expect(service.listRoots()).rejects.toThrow(
      'Cannot connect to Scan service: ECONNREFUSED',
    );
  });

  it('throws BadGatewayException when the body is not valid JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('bad json')),
    });
    const service = createService();

    await expect(service.listRoots()).rejects.toThrow(BadGatewayException);
  });

  it('throws an HttpException carrying the upstream status and message', async () => {
    mockFetchJson(
      { message: ['Path is outside the allowed scan ceiling: C:\\'] },
      false,
      403,
    );
    const service = createService();

    await expect(service.addRoot('C:\\')).rejects.toMatchObject({
      status: 403,
      message: 'Path is outside the allowed scan ceiling: C:\\',
    });
  });

  it('falls back to the error field when message is absent', async () => {
    mockFetchJson({ error: 'Not Found' }, false, 404);
    const service = createService();

    await expect(service.removeRoot('D:\\')).rejects.toThrow(HttpException);
    await expect(service.removeRoot('D:\\')).rejects.toMatchObject({
      message: 'Not Found',
    });
  });

  it('falls back to a generic message when neither message nor error is present', async () => {
    mockFetchJson({}, false, 500);
    const service = createService();

    await expect(service.listRoots()).rejects.toMatchObject({
      message: 'Scan service request failed',
    });
  });
});
