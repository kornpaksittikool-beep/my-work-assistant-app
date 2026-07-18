# Local Assistant Client

Angular client สำหรับ Local AI Assistant ทำหน้าที่แสดง task, การสนทนา, activity จาก agent, workspace และ permission prompt

## Development

```bash
pnpm install
pnpm run start
```

จากนั้นเปิด <http://localhost:4200>

## Commands

```bash
pnpm run start  # Development server
pnpm run build  # Production build
pnpm run test   # Unit tests
```

## สถานะปัจจุบัน

หน้า UI หลักเชื่อมกับ NestJS Assistant Service ที่ `http://localhost:3200/api` แล้ว

Interaction ที่ทดลองได้:

- สร้าง เลือก ค้นหา เปลี่ยนชื่อ archive และลบ task
- ย่อ sidebar
- เปิด workspace panel
- อนุญาตหรือปฏิเสธ permission request
- ส่งข้อความด้วยปุ่มส่งหรือ Enter (ปุ่มเดียวกันสลับเป็น "หยุด" ระหว่างที่ agent กำลังทำงาน กันการส่งซ้ำ)
- ขึ้นบรรทัดใหม่ด้วย Shift + Enter
- หยุดสถานะการทำงาน
- เช็คโมเดล/สถานะ Ollama ที่ใช้งานอยู่ได้จากปุ่ม Model (กดเพื่อ refresh)

การเชื่อมต่อที่มีแล้ว:

- โหลด สร้าง และเลือก task ผ่าน REST API
- ส่งข้อความไปเริ่ม agent
- รับคำตอบแบบ **streaming** ผ่าน SSE — เห็นข้อความทยอยขึ้นทีละคำระหว่างที่โมเดลกำลังตอบ ไม่ต้องรอครบก่อนถึงจะเห็น
- รับ status, tool activity, permission ผ่าน SSE
- อนุญาตหรือปฏิเสธ permission request
- หยุด task จากหน้า client
- เช็คโมเดล/สถานะ Ollama ผ่าน `GET /api/health`
- แสดงข้อผิดพลาดเมื่อ service ใช้งานไม่ได้
- ดูย้อนหลังได้ว่าแต่ละคำตอบเรียก tool อะไรไปบ้าง (กาง dropdown "ใช้ N tools" ใต้ข้อความ) — เก็บติดกับข้อความนั้นแล้ว ไม่ใช่แค่ feed ชั่วคราวระหว่าง agent กำลังทำงาน
- แยกให้เห็นชัดว่าคำตอบใช้เพียง metadata หรืออ่านเนื้อหาไฟล์จริงผ่าน `read_file`
- คลิกลิงก์ไฟล์ที่ AI แนบมาในคำตอบเพื่อเปิด Explorer ที่ตำแหน่งไฟล์นั้นได้ทันที

ก่อนเปิด client ให้รัน service ที่ `http://localhost:3200` และ Ollama ก่อน

## โครงสร้างภายใน

```text
src/app/
├── core/
│   ├── api/                 REST (AssistantApiService) และ SSE (TaskEventsService) client
│   ├── config/               ค่าคงที่ เช่น API_BASE_URL, DEFAULT_WORKSPACE_PATH
│   ├── models/              types ที่ใช้ภายใน client
│   └── state/               state และ actions ของแอป (AssistantStore)
├── layout/
│   └── sidebar/             navigation และ task list
├── features/
│   ├── chat/
│   │   ├── activity-list/   สถานะ tool/agent
│   │   ├── chat-workspace/  ประกอบหน้าการสนทนา
│   │   ├── composer/        ช่องพิมพ์และส่งข้อความ
│   │   └── conversation/    แสดงข้อความและผลการทำงาน
│   ├── permissions/
│   │   └── permission-card/ การอนุมัติการเข้าถึง
│   └── workspace/
│       ├── workspace-header/
│       └── workspace-panel/
└── app.ts                   ประกอบ layout ระดับบนเท่านั้น
```

`AssistantStore` เป็นผู้ประสาน state กับ REST/SSE services ใน `core/api/` ส่วน component ไม่เรียก HTTP โดยตรง

`core/models/assistant.models.ts` เป็น shape เดียวกับที่นิยามไว้ใน [`../contracts`](../contracts) (source of truth ของ type ที่ client/service ต้องตรงกัน) — ตอนนี้ยัง copy ไว้ในเครื่องตัวเองเพราะ client/service ยังไม่ได้อยู่ใน pnpm workspace เดียวกัน ดูรายละเอียดใน [contracts/README.md](../contracts/README.md)

## ขอบเขตของเวอร์ชันแรก

UI เน้นเฉพาะสิ่งที่เชื่อมกับ service ได้จริงตาม flow หลัก (ดู [flow ใน README ของ assistant-app](../README.md)) ปุ่ม/ส่วนที่ยังไม่มีฟีเจอร์รองรับจริง (เช่น สลับโปรเจกต์, ตั้งค่า, แนบไฟล์, เลือกโมเดล, แก้ชื่องาน) ถูกตัดออกจาก UI ไปก่อน เพื่อไม่ให้ผู้ใช้กดแล้วไม่มีอะไรเกิดขึ้น — จะใส่กลับมาเมื่อ service รองรับฟีเจอร์นั้นจริงเท่านั้น
