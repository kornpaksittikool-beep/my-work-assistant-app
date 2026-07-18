# Agent regression matrix

ชุดนี้แบ่งตามระดับที่เหมาะกับความเสี่ยง ไม่ยิง Ollama จริงใน CI เพื่อให้ผลแน่นอนและรันซ้ำได้

| Scenario | Coverage |
| --- | --- |
| Path ใน workspace ไม่ต้องขอสิทธิ์ | `src/agent/agent.service.spec.ts` |
| D:, G: และ Desktop นอก workspace ต้องขอสิทธิ์ | `src/agent/agent.service.spec.ts` |
| Allow ทำงานต่อ / deny หยุดพร้อมตอบผู้ใช้ | `src/agent/agent.service.spec.ts` |
| โมเดลไม่เรียก tool หรือแต่งผล | `src/agent/agent.service.spec.ts` |
| ช่วงวันปฏิทิน local | `src/agent/agent.service.spec.ts`, `../../../1-scan-file/test/scan.e2e-spec.ts` |
| Safe read, ไฟล์ไม่มีนามสกุล และไฟล์ลับ | `../../../1-scan-file/test/scan.e2e-spec.ts` |
| Rename/archive/delete ผ่าน HTTP | `app.e2e-spec.ts` |
| Task รอดจากการปิดและสร้าง Nest application ใหม่ | `app.e2e-spec.ts` |

รันด้วย `npm test -- --runInBand` และ `npm run test:e2e -- --runInBand` ใน service รวมถึงคำสั่งเดียวกันใน `1-scan-file`.
