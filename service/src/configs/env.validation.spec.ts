import { validate } from './env.validation';

describe('validate (env)', () => {
  it('passes with no config at all — nothing is required yet', () => {
    expect(() => validate({})).not.toThrow();
  });

  it('passes with a valid NODE_ENV and PORT', () => {
    const result = validate({ NODE_ENV: 'production', PORT: '3200' });
    expect(result.NODE_ENV).toBe('production');
    expect(result.PORT).toBe(3200);
  });

  it('throws when NODE_ENV is not a known environment', () => {
    expect(() => validate({ NODE_ENV: 'staging' })).toThrow();
  });

  it('throws when PORT is not an integer', () => {
    expect(() => validate({ PORT: 'not-a-number' })).toThrow();
  });

  it('throws when PORT is out of range', () => {
    expect(() => validate({ PORT: '70000' })).toThrow();
  });

  it('passes with a valid OLLAMA_NUM_CTX', () => {
    const result = validate({ OLLAMA_NUM_CTX: '8192' });
    expect(result.OLLAMA_NUM_CTX).toBe(8192);
  });

  it('throws when OLLAMA_NUM_CTX is below the minimum', () => {
    expect(() => validate({ OLLAMA_NUM_CTX: '100' })).toThrow();
  });
});
