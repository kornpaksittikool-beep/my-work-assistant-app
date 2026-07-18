# Agent regression matrix

ชุดนี้แบ่งตามระดับที่เหมาะกับความเสี่ยง ไม่ยิง Ollama จริงใน CI เพื่อให้ผลแน่นอนและรันซ้ำได้

| Scenario | Coverage |
| --- | --- |
| Path ใน workspace ไม่ต้องขอสิทธิ์ | `src/agent/agent.service.spec.ts` |
| D:, G: และ Desktop นอก workspace ต้องขอสิทธิ์ | `src/agent/agent.service.spec.ts` |
| Allow ทำงานต่อ / deny หยุดพร้อมตอบผู้ใช้ | `src/agent/agent.service.spec.ts` |
| โมเดลไม่เรียก tool หรือแต่งผล | `src/agent/agent.service.spec.ts` |
| ช่วงวันปฏิทิน local | `src/agent/agent.service.spec.ts`, `../../../1-scan-file/test/scan.e2e-spec.ts` |
| โมเดลเรียก scan_directory (shallow) แทน search_files ทั้งที่ผู้ใช้ระบุนามสกุล/ประเภทไฟล์ - พลาดไฟล์ที่อยู่ในโฟลเดอร์ย่อย | `src/agent/agent.service.spec.ts` ("redirects a scan_directory call to a recursive search_files...") |
| Query ภาษาไทยที่เป็นคำผสม (เช่น "หนี้สิน") หาไม่เจอเพราะ search_files จับคู่ตัวอักษรตรงตัว ไม่ตัดคำ - ต้อง nudge ให้ลองคำย่อย/คำพ้องความหมาย | `src/agent/agent.service.spec.ts` ("nudges the model to retry with shorter root words...", "does not nudge a second time...") |
| โมเดลแอบใส่ modifiedRange (เช่น "today") ทั้งที่ผู้ใช้ไม่ได้พูดถึงวันที่เลย - กรองไฟล์เก่าออกไปเงียบๆ | `src/agent/agent.service.spec.ts` ("ignores a valid modifiedRange the model attached when the user never mentioned time at all") |
| read_file เนื้อหาไฟล์จริง (เช่น .xlsx ขนาดหลายสิบ KB) เกิน context window ของโมเดลจนทั้ง task ล้มเหลว | `src/agent/agent.service.spec.ts` ("caps read_file at a model-facing default maxBytes...") |
| Safe read, ไฟล์ไม่มีนามสกุล และไฟล์ลับ | `../../../1-scan-file/test/scan.e2e-spec.ts` |
| search_files ผสม extension filter กับช่วงวันที่พร้อมกัน (ไม่ใช่แค่ทีละตัว) | `../../../1-scan-file/test/scan.e2e-spec.ts` ("combines an extension filter with a modified-date range") |
| เซลล์ Excel ที่ format เป็นวันที่/เวลาถูกอ่านออกมาเป็นเลข serial ดิบ (เช่น "0.354166..." แทนที่จะเป็น "08:30") | `../../../1-scan-file/src/read/document-extractor.service.spec.ts`, `../../../1-scan-file/test/scan.e2e-spec.ts` ("converts a date-formatted Excel cell...") |
| Rename/archive/delete ผ่าน HTTP | `app.e2e-spec.ts` |
| Task รอดจากการปิดและสร้าง Nest application ใหม่ | `app.e2e-spec.ts` |

รันด้วย `npm test -- --runInBand` และ `npm run test:e2e -- --runInBand` ใน service รวมถึงคำสั่งเดียวกันใน `1-scan-file`.

หมายเหตุ: พฤติกรรมของ agent/tool-call (3 แถวกลางด้านบน) อยู่ใน `agent.service.spec.ts` ที่ mock `OllamaService` แทนที่จะยิง Ollama จริงใน `app.e2e-spec.ts` - เพื่อให้ผลตรวจสอบได้แน่นอนซ้ำๆ (โมเดล local ตอบไม่เหมือนกันทุกครั้ง) ตามหลักการเดิมของไฟล์นี้ที่ระบุไว้ด้านบนแล้ว.
