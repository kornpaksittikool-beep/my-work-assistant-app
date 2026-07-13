# Assistant App

แอปพลิเคชันหลักสำหรับใช้งาน **Local AI Assistant** ผ่านหน้าเว็บ โดยมีหน้าตาและรูปแบบการทำงานคล้ายผู้ช่วย AI แบบ agent: ผู้ใช้สามารถแชท เลือก workspace ดูสถานะการทำงาน และอนุมัติการเข้าถึงไฟล์หรือการกระทำที่มีผลกระทบได้

ตัวแอปไม่ได้ให้หน้าเว็บเชื่อมกับ Ollama หรือเครื่องมือต่าง ๆ โดยตรง แต่ใช้ `service` เป็นตัวกลางในการควบคุมการสนทนา เลือกเครื่องมือ ตรวจสอบสิทธิ์ และส่งผลลัพธ์กลับมาแสดงที่ `client`

## เป้าหมาย

- มีหน้าแชทหลักสำหรับสั่งงาน AI ด้วยภาษาไทยหรืออังกฤษ
- เลือกโฟลเดอร์หรือโปรเจกต์เป็น workspace ได้
- แสดงสิ่งที่ AI กำลังทำ เช่น อ่านไฟล์ ค้นหาไฟล์ หรือเรียกเครื่องมือ
- ขออนุญาตก่อนเข้าถึงพื้นที่ใหม่ แก้ไขไฟล์ รันคำสั่ง หรือส่งข้อมูลออกภายนอก
- ใช้ Ollama และโมเดล AI ที่ทำงานอยู่ภายในเครื่อง
- เชื่อมเครื่องมือแยกผ่าน MCP เช่น `1-scan-file`
- รองรับการเพิ่มเครื่องมืออื่นในอนาคตโดยไม่ผูกทุกอย่างไว้กับหน้าเว็บ

## โครงสร้าง

```text
assistant-app/
├── client/       Angular — หน้าเว็บและประสบการณ์ใช้งาน
├── service/      NestJS — Agent Backend และ API กลาง
├── contracts/    TypeScript — รูปแบบข้อมูลที่ client และ service ใช้ร่วมกัน
└── README.md
```

## Client

`client/` เป็นเว็บแอปที่พัฒนาด้วย **Angular** รับผิดชอบเฉพาะส่วนที่ผู้ใช้มองเห็นและโต้ตอบด้วย

หน้าที่หลัก:

- แสดงหน้าแชทและคำตอบจาก AI
- แสดงรายการ task และประวัติการสนทนา
- ให้ผู้ใช้เลือกหรือเปลี่ยน workspace
- แสดง activity และ tool call ระหว่างที่ AI ทำงาน
- แสดงหน้าต่างขออนุญาตและส่งคำตอบอนุญาต/ปฏิเสธกลับไปยัง service
- แสดงรายการไฟล์ ผลการค้นหา ตัวอย่างไฟล์ และ diff
- แสดงสถานะ Ollama โมเดลที่ใช้ และการเชื่อมต่อ
- รับข้อมูลแบบ streaming จาก service

Client ต้องติดต่อเฉพาะ `service` เท่านั้น และไม่ควรเรียก Ollama, filesystem หรือ MCP tool โดยตรง

## Service

`service/` เป็น **NestJS Agent Backend** ทำหน้าที่เป็นสมองส่วนควบคุมระหว่างหน้าเว็บ Ollama และเครื่องมือต่าง ๆ

หน้าที่หลัก:

- รับข้อความและคำสั่งจาก client
- จัดการ task, session และประวัติการสนทนา
- ส่งข้อความและบริบทไปยัง Ollama
- ควบคุม agent loop ให้โมเดลวางแผน เรียกเครื่องมือ อ่านผล และตอบกลับ
- เชื่อมต่อ MCP server เช่น `1-scan-file`
- จัดการ workspace และสิทธิ์ Read / Write / Execute
- หยุดและรอการยืนยันเมื่อเครื่องมือต้องการสิทธิ์เพิ่มเติม
- ส่งข้อความ คำตอบ และ activity event กลับไปยัง client แบบ streaming
- จำกัดจำนวนรอบ เวลา และทรัพยากร เพื่อป้องกัน agent ทำงานวนหรือใช้เครื่องมือเกินขอบเขต

Service ไม่ควรนำ business logic ของแต่ละเครื่องมือมาทำซ้ำ เช่น logic การสแกนไฟล์ควรอยู่ใน `1-scan-file` แล้วเรียกผ่าน MCP

## Contracts

`contracts/` เก็บ **TypeScript types และ schemas แบบกลาง** ที่ทั้ง Angular และ NestJS ใช้ร่วมกัน เพื่อให้รูปแบบ request, response และ streaming event ตรงกัน

ตัวอย่างข้อมูลที่เหมาะกับส่วนนี้:

- `ChatMessage`
- `Task`
- `Workspace`
- `WorkspacePermission`
- `ToolActivity`
- `PermissionRequest`
- `AgentEvent`

Contracts ควรเป็น TypeScript ธรรมดาหรือ schema ที่ไม่ผูกกับ Angular/NestJS โดยตรง ไม่ควรนำ NestJS DTO ที่มี decorators มา import ใน Angular

## การทำงานร่วมกับระบบอื่น

```text
ผู้ใช้
  ↓
Angular Client
  ↓
NestJS Agent Service
  ├── Ollama                 สร้างคำตอบและตัดสินใจเรียกเครื่องมือ
  ├── 1-scan-file MCP        สแกนโฟลเดอร์ภายในพื้นที่ที่อนุญาต
  └── Database               เก็บ task, chat, workspace และ permission
```

### Ollama

Ollama เป็น runtime สำหรับรันโมเดล AI ภายในเครื่อง ทำหน้าที่สร้างคำตอบ วิเคราะห์คำสั่ง และเลือก tool ที่เหมาะสม แต่ Ollama ไม่ควรเข้าถึงไฟล์หรือรันคำสั่งด้วยตัวเอง การกระทำเหล่านั้นต้องผ่าน Agent Service และ guardrail เสมอ

สลับ model ได้ผ่าน `OLLAMA_MODEL` ใน `service/.env` โดยไม่ต้องแก้โค้ด — Client มีตัวแสดงชื่อ/สถานะ model ที่ใช้งานอยู่ (ผ่าน `GET /api/health`) ให้เช็คได้ว่าเชื่อม Ollama ติดไหมและใช้ model ตัวไหนอยู่

### 1-scan-file

`../1-scan-file/` เป็นเครื่องมือแยกสำหรับดูรายการไฟล์และโฟลเดอร์ โดยเปิด MCP tool ชื่อ `scan_directory` ให้ Agent Service เรียกใช้งาน

เครื่องมือนี้รับผิดชอบ:

- ตรวจสอบว่า path มีอยู่จริง
- ป้องกัน path traversal
- ป้องกัน symlink ที่ชี้ออกนอกพื้นที่อนุญาต
- จำกัดการอ่านให้อยู่ภายใน `SCAN_ALLOWED_ROOTS` (รองรับหลาย root พร้อมกัน เช่น ทั้งไดรฟ์ + โฟลเดอร์ส่วนตัวเฉพาะ)
- กรองไฟล์/โฟลเดอร์ซ่อนและไฟล์ระบบ (dotfile, `$RECYCLE.BIN`, `System Volume Information` ฯลฯ) ออกก่อนคืนผล เพื่อให้อ่านง่ายจากมุมผู้ใช้ทั่วไป
- คืนข้อมูลชื่อ path ประเภท ขนาด และเวลาแก้ไขของไฟล์

### Open WebUI

Open WebUI ใน `../dockers/` ใช้สำหรับทดลองและตรวจสอบ Ollama ในช่วงพัฒนา เมื่อ Assistant App พร้อมแล้ว ผู้ใช้ทั่วไปจะใช้งานผ่าน Angular Client เป็นหลัก โดยไม่จำเป็นต้องเปิด Open WebUI

## Permission Flow

ตัวอย่างเมื่อ AI ต้องการอ่านโฟลเดอร์นอก workspace:

1. ผู้ใช้ส่งคำสั่งผ่าน client
2. Service ให้ Ollama วิเคราะห์คำสั่ง
3. Ollama ขอเรียก `scan_directory`
4. Service ตรวจพบว่า path ยังไม่ได้รับอนุญาต
5. Service ส่ง `permission_required` event ไปยัง client
6. Client แสดงปุ่มอนุญาตหรือปฏิเสธ
7. เมื่อผู้ใช้อนุญาต Service จึงเรียก MCP tool
8. `1-scan-file` ตรวจ path ซ้ำด้วย guardrail
9. Service ส่งผลให้ Ollama สรุปและ stream คำตอบกลับ client

## พอร์ตที่เสนอ

| ระบบ | พอร์ต | หน้าที่ |
|---|---:|---|
| Angular Client | `4200` | หน้าเว็บระหว่างพัฒนา |
| Agent Service | `3200` | API และ streaming สำหรับ Assistant App |
| Scan MCP | `3100` | MCP tool สำหรับสแกนไฟล์ |
| Scan REST API | `3201` | REST API สำหรับทดสอบ Scan Service |
| Open WebUI | `3000` | หน้าทดลอง Ollama |
| Ollama | `11434` | Local model runtime |

พอร์ตเหล่านี้เป็นค่าเสนอเบื้องต้น สามารถเปลี่ยนได้ผ่าน configuration ของแต่ละ service

## ขอบเขตของเวอร์ชันแรก

เวอร์ชันแรกเน้น flow หลักดังนี้:

1. แชทกับ Ollama แบบ streaming (ข้อความทยอยขึ้นทีละคำผ่าน SSE event `message_delta`) พร้อม lifecycle event และ final answer
2. สร้าง task และเก็บประวัติการสนทนา
3. เลือก workspace
4. ให้ Agent Service เรียก `scan_directory` ผ่าน MCP
5. แสดง activity ระหว่างทำงาน
6. ขออนุญาตเมื่อเข้าถึง path นอก workspace
7. หยุด task ที่กำลังทำงานได้

การแก้ไขไฟล์ รันคำสั่ง ระบบ memory ระยะยาว และเครื่องมืออื่นควรเพิ่มหลังจาก flow หลักนี้ทำงานได้เสถียรแล้ว

## หลักการสำคัญ

- **Local-first:** ข้อมูลควรอยู่ในเครื่องหรือเครือข่ายที่องค์กรควบคุม
- **Security-first:** ทุก tool ต้องถูกจำกัดสิทธิ์และตรวจสอบ input ฝั่ง server
- **Human approval:** การกระทำที่มีผลกระทบต้องให้ผู้ใช้ยืนยันก่อน
- **Separation of concerns:** Client แสดงผล, Service ควบคุม agent, MCP services ทำงานเฉพาะทาง
- **Observable:** ผู้ใช้ต้องเห็นว่า AI กำลังทำอะไรและสามารถหยุดได้
- **Extensible:** เพิ่ม tool และโมเดลใหม่ได้โดยไม่ต้องแก้ client ทุกครั้ง
