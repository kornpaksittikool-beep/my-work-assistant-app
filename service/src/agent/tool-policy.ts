/** Central policy for deciding when a file-related answer needs real tool evidence. */
const FILE_LOOKUP_INTENT =
  /ไฟล์|โฟลเดอร์|เอกสาร|หา|ค้นหา|ดู|สแกน|มีอะไร|อยู่ที่ไหน|\bfile\b|\bfolder\b|\bdirectory\b|\bfind\b|\bsearch\b|\bscan\b|\blist\b|\bshow\b/i;
const FILE_MUTATION_INTENT =
  /ลบ|แก้ไข|เปลี่ยน|สร้าง|ย้าย|คัดลอก|เขียน|บันทึก|\bdelete\b|\bremove\b|\bedit\b|\bmodify\b|\bwrite\b|\bcreate\b|\brename\b|\bmove\b|\bcopy\b/i;
const READ_ONLY_MODIFICATION_TIME =
  /(?:ไฟล์|โฟลเดอร์|เอกสาร).{0,60}(?:แก้ไข|เปลี่ยนแปลง).{0,40}(?:วันนี้|เมื่อวาน|วันที่|วัน|ชั่วโมง|สัปดาห์|อาทิตย์|เดือน|ปี)|\b(?:files?|folders?|documents?).{0,60}\b(?:modified|changed).{0,40}\b(?:today|yesterday|date|day|hours?|weeks?|months?|years?)\b/i;
const FILE_CONTENT_REQUEST =
  /สรุปเนื้อหา|อ่าน(?:เนื้อหา|ไฟล์|เอกสาร)|พูดถึงอะไร|เกี่ยวกับอะไร|ใจความ(?:สำคัญ)?|หัวข้อ(?:ของ|ใน)(?:ไฟล์|เอกสาร)|มีอะไรเขียน|\b(?:read|summari[sz]e)\b.{0,80}\b(?:file|document|contents?)\b|\bwhat (?:does|is in)\b.{0,80}\b(?:file|document)\b/i;

export const DIRECTORY_LIST_INTENT =
  /สแกน|ดู(?:ใน|ข้างใน)|มีอะไร|รายการ|ระดับบนสุด|\bscan\b|\blist\b|\bshow\b|\bcontents?\b/i;

export interface ToolPolicyDecision {
  requiresFileEvidence: boolean;
  isMutation: boolean;
  isDirectoryListing: boolean;
  requestsFileContent: boolean;
}

export function evaluateToolPolicy(userText: string): ToolPolicyDecision {
  const isMutation =
    FILE_MUTATION_INTENT.test(userText) &&
    !READ_ONLY_MODIFICATION_TIME.test(userText);
  return {
    requiresFileEvidence:
      (FILE_LOOKUP_INTENT.test(userText) || FILE_CONTENT_REQUEST.test(userText)) &&
      !isMutation,
    isMutation,
    isDirectoryListing: DIRECTORY_LIST_INTENT.test(userText),
    requestsFileContent: FILE_CONTENT_REQUEST.test(userText),
  };
}

export const FILE_CONTENT_UNAVAILABLE_RESPONSE =
  'ยังสรุปเนื้อหาไฟล์นี้ไม่ได้ เพราะระบบไม่ได้รับผลจาก read_file จริงในรอบนี้ครับ จึงจะไม่เดาเนื้อหาจากชื่อไฟล์หรือ metadata กรุณาระบุ path ของไฟล์ให้ชัดเจนแล้วลองอีกครั้ง';

export const UNVERIFIED_FILE_RESPONSE =
  'ยังตอบเรื่องไฟล์นี้ไม่ได้ เพราะระบบยังไม่ได้รับผลตรวจสอบจริงจากเครื่องมือ จึงจะไม่เดาหรือสร้างรายชื่อไฟล์ขึ้นมา กรุณาระบุชื่อไฟล์ โฟลเดอร์ หรือ path ให้ชัดเจนขึ้นแล้วลองอีกครั้งครับ';

export const FILE_METADATA_POLICY_PROMPT =
  'FILE TOOL POLICY: For every file/folder lookup, listing, search, or claim about what exists, use scan_directory or search_files in the current turn before answering. Use read_file before every claim about actual file content, and only summarize the content field returned by read_file in the current turn. Never invent a tool result. When the user asks for file types, pass them through search_files.extensions, not as filename queries. scan_directory/search_files expose presentation-ready Thai metadata fields only (ชื่อ, ตำแหน่ง, ประเภท, ขนาด, แก้ไขล่าสุด). Copy ขนาด and แก้ไขล่าสุด exactly as provided: do not translate units, convert timezones, add UTC, or reformat them. Never infer content from filename, extension, path, size, or timestamps.';
