# Contracts

TypeScript types ที่เป็น "wire contract" ระหว่าง `client` (Angular) และ `service` (NestJS) เท่านั้น — คือรูปแบบข้อมูลที่ทั้งสองฝั่งต้องตรงกันเป๊ะเพราะส่งผ่าน HTTP/SSE จริง

ไม่ใส่ type ที่เป็นรายละเอียดภายในของฝั่งใดฝั่งหนึ่ง เช่น UI-only state (`ActivityItem` ของ client) หรือ environment/DTO validation ภายในของ service — พวกนี้ยังอยู่ที่เดิมของแต่ละฝั่ง

## โครงสร้าง

```text
src/
├── task.ts          AssistantTask, ChatMessage, TaskStatus, MessageRole
├── permission.ts     PermissionRequest
├── agent-event.ts     AgentEvent (SSE event ที่ service ส่งให้ client)
└── api-envelope.ts    ApiSuccessEnvelope / ApiErrorEnvelope (response envelope)
```

## สถานะปัจจุบัน

ตอนนี้เป็น**เอกสารต้นทาง** (source of truth) ของรูปแบบข้อมูลเท่านั้น ยังไม่ได้ถูก import ข้ามโปรเจกต์จริง — `client` (`core/models/assistant.models.ts`) และ `service` (`tasks/task.types.ts`, `permissions/permission.types.ts`) ยังคง copy type พวกนี้ไว้ในเครื่องตัวเอง

สาเหตุ: `client` และ `service` เป็นสอง pnpm project แยกกัน (คนละ lockfile, คนละ node_modules) ไม่ได้อยู่ใน workspace เดียวกัน การเชื่อมให้ import ข้ามจริง (ผ่าน pnpm workspace หรือ TS path mapping) เป็นงาน infra ที่ควรทำแยกต่างหากพร้อมทดสอบ build/dev-server ทั้งสองฝั่งให้ชัวร์ ไม่ใช่แก้ผ่านๆ ระหว่างงานอื่น

**กติกาเฉพาะหน้า:** เวลาจะแก้รูปแบบ field ของ `AssistantTask`, `ChatMessage`, `PermissionRequest`, `AgentEvent` หรือ envelope ให้แก้ที่นี่ก่อนเป็นหลัก แล้วค่อยพา `client`/`service` ตามให้ตรงกัน เพื่อไม่ให้สองฝั่ง drift ออกจากกัน

## ทิศทางถัดไป

เชื่อม import จริงด้วย pnpm workspace (`assistant-app/pnpm-workspace.yaml` รวม `client`, `service`, `contracts`) แล้วให้ทั้งสองฝั่ง import จาก `@assistant-app/contracts` แทนไฟล์ copy ของตัวเอง
