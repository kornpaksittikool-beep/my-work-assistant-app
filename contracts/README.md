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

เสร็จแล้ว: `client`, `service`, `contracts` อยู่ใน pnpm workspace เดียวกันแล้ว (`assistant-app/pnpm-workspace.yaml`) และทั้งสองฝั่ง import type จาก `@assistant-app/contracts` จริง (ผ่าน `workspace:*` dependency) แทนการ copy type ไว้คนละที่ — `client/core/models/assistant.models.ts` และ `service/tasks/task.types.ts`/`permissions/permission.types.ts` (ไฟล์หลังถูกลบไปแล้ว) ไม่มี type ที่ซ้ำกับที่นี่อีกต่อไป

`contracts` ไม่มี build step (ไม่มี runtime code เลย มีแต่ `export type`/`interface`) — ทุกฝั่งใช้ `import type { ... } from '@assistant-app/contracts'` เพื่อให้ TypeScript ลบ import ทิ้งตอน compile แล้วไม่ต้องพึ่ง Node resolve ไฟล์ `.ts` ตอน runtime

ระหว่างทางพบว่า `ToolActivityEntry`/`toolCalls` (เพิ่มหลัง 18 ก.ค.) และ `archived` บน `AssistantTask` ยังไม่เคยอยู่ใน contracts เลย จึงย้ายเข้ามาเป็นส่วนหนึ่งของ contract ด้วย (แก้ข้อสังเกตเดิมที่บอกว่า `ActivityItem`/tool-activity เป็น UI-only — จริงๆ แล้ว `toolCalls` ถูก persist และส่งผ่าน wire จริง ต่างจาก `ActivityItem` ของ client ที่ยังเป็น UI-only จริงๆ เพราะมี state `working`/`queued` เพิ่มสำหรับ live feed เท่านั้น)

**กติกาเฉพาะหน้า** (ยังใช้เหมือนเดิม): เวลาจะแก้รูปแบบ field ของ `AssistantTask`, `ChatMessage`, `PermissionRequest`, `AgentEvent` หรือ envelope ให้แก้ที่นี่ก่อนเป็นหลัก แล้วค่อยพา `client`/`service` ตามให้ตรงกัน

## ทิศทางถัดไป

ไม่มีงานค้างสำหรับ workspace/import แล้ว — ขยาย type ที่นี่ต่อเมื่อมี field ใหม่ที่ต้องส่งผ่าน wire จริงๆ เท่านั้น
