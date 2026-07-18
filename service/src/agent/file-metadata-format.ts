export function formatFileSize(bytes: number): string {
  const wholeBytes = `${Math.max(0, Math.round(bytes)).toLocaleString('en-US')} ไบต์`;
  if (bytes < 1024) return wholeBytes;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]} (${wholeBytes})`;
}

export function formatLocalDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('day')}/${part('month')}/${part('year')} ${part('hour')}:${part('minute')}`;
}

/**
 * Give the model only presentation-ready metadata so it cannot copy a raw
 * UTC timestamp or invent a unit translation such as "คิบ". The raw result
 * is still persisted unchanged for audit/history; this clone is prompt-only.
 */
export function formatToolResultForModel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(formatToolResultForModel);
  if (!value || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const formatted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key === 'name' && typeof item === 'string') {
      formatted['ชื่อ'] = item;
    } else if (key === 'path' && typeof item === 'string') {
      formatted['ตำแหน่ง'] = item;
    } else if (key === 'type' && typeof item === 'string') {
      formatted['ประเภท'] =
        item === 'file' ? 'ไฟล์' : item === 'directory' ? 'โฟลเดอร์' : item;
    } else if (key === 'size' && typeof item === 'number') {
      formatted['ขนาด'] = formatFileSize(item);
    } else if (key === 'modifiedAt' && typeof item === 'string') {
      formatted['แก้ไขล่าสุด'] = formatLocalDateTime(item);
    } else {
      formatted[key] = formatToolResultForModel(item);
    }
  }
  return formatted;
}
