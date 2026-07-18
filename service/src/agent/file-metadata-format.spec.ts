import {
  formatFileSize,
  formatLocalDateTime,
  formatToolResultForModel,
} from './file-metadata-format';

describe('file metadata formatting', () => {
  it('uses consistent byte, KB and MB labels', () => {
    expect(formatFileSize(233)).toBe('233 ไบต์');
    expect(formatFileSize(66_285)).toBe('64.7 KB (66,285 ไบต์)');
    expect(formatFileSize(2 * 1024 * 1024)).toBe(
      '2.00 MB (2,097,152 ไบต์)',
    );
  });

  it('formats ISO timestamps as local DD/MM/YYYY HH:mm', () => {
    const value = '2026-07-18T14:45:15.000Z';
    const expectedDate = new Date(value);
    const expected = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(expectedDate).replace(',', '');
    expect(formatLocalDateTime(value)).toBe(expected);
  });

  it('replaces raw size and modifiedAt fields only in the model-facing clone', () => {
    const raw = {
      matches: [
        {
          name: 'report.json',
          path: 'D:\\report.json',
          size: 2048,
          modifiedAt: '2026-07-18T14:45:15.000Z',
        },
      ],
    };

    const formatted = formatToolResultForModel(raw) as {
      matches: Array<Record<string, unknown>>;
    };
    expect(formatted.matches[0]).toMatchObject({
      ชื่อ: 'report.json',
      ตำแหน่ง: 'D:\\report.json',
      ขนาด: '2.00 KB (2,048 ไบต์)',
    });
    expect(formatted.matches[0]).toHaveProperty('แก้ไขล่าสุด');
    expect(formatted.matches[0]).not.toHaveProperty('name');
    expect(formatted.matches[0]).not.toHaveProperty('size');
    expect(formatted.matches[0]).not.toHaveProperty('modifiedAt');
    expect(raw.matches[0]).toHaveProperty('size', 2048);
  });
});
