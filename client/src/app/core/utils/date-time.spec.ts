import { describe, expect, it } from 'vitest';
import { formatLocalTime } from './date-time';

describe('formatLocalTime', () => {
  it('formats an ISO timestamp in the machine local timezone', () => {
    const value = '2026-07-18T14:32:00.000Z';
    const date = new Date(value);
    const expected = new Intl.DateTimeFormat('th-TH-u-nu-latn', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);

    expect(formatLocalTime(value)).toBe(expected);
  });

  it('returns a stable placeholder for invalid timestamps', () => {
    expect(formatLocalTime('not-a-date')).toBe('--:--');
  });
});
