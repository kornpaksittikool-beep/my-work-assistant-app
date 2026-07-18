# Assistant Service

NestJS Agent Backend สำหรับ Local Assistant ทำหน้าที่เป็นตัวกลางระหว่าง Angular client, Ollama และ MCP tools โดย client ไม่ต้องเข้าถึงโมเดลหรือ filesystem โดยตรง

## Responsibilities

- สร้างและเก็บ task/conversation สำหรับ MVP
- ส่งข้อความไปยัง Ollama พร้อม tool definition
- ควบคุม agent flow และสถานะของ task
- เรียก `scan_directory`/`search_files` ผ่าน Scan MCP (ไม่จำกัดแค่ workspace ปัจจุบัน — system prompt บอก agent ว่าเรียกกับ path/ไดรฟ์อื่นได้โดยตรง เช่น `G:\`) — `search_files` ค้นหาไฟล์แบบ recursive ข้ามทุก root พร้อมกรองตามเวลาแก้ไขล่าสุด (`modifiedRange`) ได้
- เปิดไฟล์/โฟลเดอร์ที่พบใน Explorer ผ่าน `GET /api/files/open` — ลิงก์ถูกแนบอัตโนมัติในคำตอบเมื่อ tool เจอไฟล์จริง
- หยุดรอเมื่อ tool ต้องการอ่าน path นอก workspace
- รับการอนุญาตหรือปฏิเสธจากผู้ใช้ แล้วทำงานต่อหรือหยุด
- ส่งสถานะ, tool activity, permission request และคำตอบผ่าน SSE
- ตรวจ config ตอน boot และเปิด CORS เฉพาะ Angular client

## Structure

```text
src/
├── agent/          agent orchestration และ tool flow
├── mcp/            client สำหรับ Scan MCP
├── ollama/         Ollama chat/tool-calling adapter
├── permissions/    permission requests และการตัดสินใจ
├── tasks/          task, messages, repository, events และ REST/SSE API
├── common/         response envelope, filters และ Swagger decorators
└── configs/        environment validation และ Swagger
```

`tasks/task.types.ts` และ `permissions/permission.types.ts` เป็น shape เดียวกับที่นิยามไว้ใน [`../contracts`](../contracts) (source of truth ของ type ที่ client/service ต้องตรงกัน) — ตอนนี้ยัง copy ไว้ในเครื่องตัวเองเพราะ client/service ยังไม่ได้อยู่ใน pnpm workspace เดียวกัน ดูรายละเอียดใน [contracts/README.md](../contracts/README.md)

## Configuration

คัดลอก `.env.example` เป็น `.env` แล้วปรับค่าตามเครื่อง:

```env
NODE_ENV=development
PORT=3200
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3:4b
OLLAMA_NUM_CTX=8192
SCAN_MCP_URL=http://localhost:3100/mcp
AGENT_MAX_STEPS=5
CORS_ORIGIN=http://localhost:4200
TASKS_DATA_FILE=./data/tasks.json
```

## Run

```bash
pnpm install
pnpm run start:dev
```

- API: <http://localhost:3200/api>
- Swagger: <http://localhost:3200/docs>
- Health: <http://localhost:3200/api/health>

ก่อนทดลอง Scan tool ต้องเปิด Ollama และ `1-scan-file` MCP server ด้วย

## API Flow

### 1. Create task

```http
POST /api/tasks
Content-Type: application/json

{
  "title": "สรุปไฟล์ในโปรเจกต์",
  "workspacePath": "D:\\my-work"
}
```

### 2. Subscribe to events

```http
GET /api/tasks/:taskId/events
Accept: text/event-stream
```

Event types:

- `status`
- `message_delta` — เนื้อหาคำตอบที่ทยอยส่งออกมาทีละ token ระหว่างที่ Ollama กำลัง generate (ใช้ทำ streaming UI ฝั่ง client)
- `message` — ข้อความคำตอบตัวเต็มจริง ส่งครั้งเดียวหลัง stream จบ
- `tool_started`
- `tool_completed`
- `permission_required`
- `completed`
- `error`

### 3. Send message

```http
POST /api/tasks/:taskId/messages
Content-Type: application/json

{
  "content": "ช่วยสแกนและสรุปไฟล์ใน workspace"
}
```

### 4. Resolve permission

เมื่อได้รับ `permission_required` event:

```http
POST /api/tasks/:taskId/permissions/:permissionId
Content-Type: application/json

{
  "decision": "allow"
}
```

ค่า decision คือ `allow` หรือ `deny`

### 5. Stop task

```http
POST /api/tasks/:taskId/stop
```

## Security Boundary

Permission ใน Assistant Service เป็น product-level approval เท่านั้น ไม่ได้ข้าม filesystem guardrail ของ `1-scan-file`

แม้ผู้ใช้กดอนุญาต path นอก workspace แล้ว path ดังกล่าวยังต้องอยู่ใน `SCAN_ALLOWED_ROOTS` ของ `1-scan-file` มิฉะนั้น Scan MCP จะปฏิเสธตามปกติ เป็นการตรวจสอบสองชั้นโดยตั้งใจ

## Current MVP Limitations

- Task/conversation persist ลงไฟล์ JSON แล้ว (`TASKS_DATA_FILE`, ดูที่ [tasks.repository.ts](src/tasks/tasks.repository.ts)) ไม่หายตอน restart อีกต่อไป — ส่วน permission request ยังอยู่ใน memory ล้วนๆ (แต่เป็นของที่มีอายุสั้นตามธรรมชาติ ไม่ใช่ประวัติที่ต้องเก็บยาว)
- Agent ทำงานหนึ่ง tool call ต่อรอบเป็นหลัก
- ยังไม่มี authentication หรือ multi-user isolation จริง (Swagger เตรียม Bearer/JWT scheme ไว้ในเอกสารแล้ว แต่ยังไม่มี guard หรือ endpoint ใดตรวจ token จริง)
- Stop ป้องกันขั้นถัดไป แต่ยังยกเลิก HTTP request ที่ส่งไป Ollama ระหว่างทางไม่ได้ (แม้ตอนนี้เป็น streaming request แล้วก็ตาม)
- `scan_directory` เป็น shallow scan ตามความสามารถปัจจุบันของ `1-scan-file`
- Ollama chat request ส่ง SSE event `message_delta` แยกทีละ token ค่อนข้าง chatty สำหรับคำตอบยาวๆ (event หลายร้อยอันต่อรอบ) ยังไม่ได้ทำ batching

## Commands

```bash
pnpm run build
pnpm run lint
pnpm run test
pnpm run test:e2e
pnpm run test:cov
```
