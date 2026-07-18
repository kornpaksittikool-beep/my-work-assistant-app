import {
  evaluateToolPolicy,
  FILE_METADATA_POLICY_PROMPT,
} from './tool-policy';

describe('tool policy', () => {
  it('requires verified evidence for Thai and English file lookups', () => {
    expect(evaluateToolPolicy('ช่วยหาไฟล์ report.pdf')).toMatchObject({
      requiresFileEvidence: true,
      isMutation: false,
    });
    expect(evaluateToolPolicy('list the Desktop folder')).toMatchObject({
      requiresFileEvidence: true,
      isDirectoryListing: true,
    });
  });

  it('does not force an unsupported mutation through a read-only tool', () => {
    expect(evaluateToolPolicy('ลบไฟล์ report.pdf')).toMatchObject({
      requiresFileEvidence: false,
      isMutation: true,
    });
  });

  it('keeps modification-time lookups read-only', () => {
    expect(evaluateToolPolicy('หาไฟล์ที่แก้ไขวันนี้')).toMatchObject({
      requiresFileEvidence: true,
      isMutation: false,
    });
  });

  it('states that filename metadata cannot be used to summarize contents', () => {
    expect(FILE_METADATA_POLICY_PROMPT).toContain(
      'Use read_file before every claim about actual file content',
    );
    expect(FILE_METADATA_POLICY_PROMPT).toContain(
      'Never infer content from filename',
    );
  });

  it('detects direct requests to read or summarize file contents', () => {
    expect(
      evaluateToolPolicy('README.md ใน root พูดถึงอะไร สรุปเนื้อหาให้หน่อย'),
    ).toMatchObject({ requestsFileContent: true });
    expect(evaluateToolPolicy('read the contents of report.txt')).toMatchObject(
      { requestsFileContent: true },
    );
  });

  it('does not mistake a directory-list summary for reading file contents', () => {
    expect(
      evaluateToolPolicy('สแกน Desktop แล้วสรุปสิ่งที่พบ'),
    ).toMatchObject({ requestsFileContent: false });
  });
});
