# LINE bot บันทึกไฟล์ลง Google Drive (Google Apps Script)

รับไฟล์ที่ส่งเข้ามาในแชต LINE (1:1 หรือกลุ่ม) บันทึกลงโฟลเดอร์ Google Drive แล้วตอบกลับด้วยลิงก์ไฟล์

## การติดตั้ง

1. **ออก Channel access token ใหม่ทันที** ที่ LINE Developers Console > Messaging API
   token เดิมเคยเขียนไว้ในโค้ดและถูกเปิดเผยไปแล้ว ต้องถือว่ารั่ว ห้ามนำมาใช้ต่อ
2. คัดลอก `Code.gs` ไปวางในโปรเจกต์ Apps Script (ลบ token และ ID เดิมออกจากโค้ดให้หมด)
3. Project Settings > Script properties เพิ่มค่าต่อไปนี้

   | Key | ค่า |
   | --- | --- |
   | `CHANNEL_TOKEN` | Channel access token ที่ออกใหม่ |
   | `FOLDER_ID` | ID ของโฟลเดอร์ที่เก็บไฟล์ (ถ้าไม่ใส่จะเก็บที่ My Drive) |
   | `ALLOWED_SOURCE_IDS` | (แนะนำ) userId / groupId / roomId ที่อนุญาต คั่นด้วย `,` |
   | `WEBHOOK_KEY` | สร้างอัตโนมัติในข้อ 4 |

4. เลือกฟังก์ชัน `setupWebhookKey` แล้วกด Run จะสร้าง `WEBHOOK_KEY` แบบสุ่ม และแสดง `?key=...` ใน Execution log
5. (แนะนำ) Project Settings > เปิด "Show appsscript.json" แล้วใช้ค่าจาก `appsscript.json`
   เพื่อจำกัดสิทธิ์ (OAuth scopes) เท่าที่ใช้จริง
6. Deploy > New deployment > Web app ตั้ง Execute as: **Me** และ Who has access: **Anyone**
7. LINE Developers Console > Messaging API > Webhook URL ใส่ URL ของ Web app ต่อท้ายด้วย `?key=...` จากข้อ 4
   เช่น `https://script.google.com/macros/s/xxxx/exec?key=yyyy` แล้วกด Verify
8. ทดสอบโดยส่งไฟล์เข้าแชต (Verify ผ่านไม่ได้แปลว่า key ถูก) ถ้าบอทไม่ตอบ ให้ดู log ที่หน้า Executions
   ถ้าเห็น `ปฏิเสธคำขอที่ไม่มี key หรือ key ไม่ถูกต้อง` แสดงว่า `?key=` ใน Webhook URL ไม่ตรง

ทุกครั้งที่แก้โค้ด ต้อง Deploy > Manage deployments > แก้ deployment เดิม > Version: **New version**
URL `/exec` จึงจะใช้โค้ดใหม่ (URL เดิมไม่เปลี่ยน)

### หา userId / groupId สำหรับ `ALLOWED_SOURCE_IDS`

- userId ของผู้พัฒนาเอง ดูได้ที่ LINE Developers Console > Basic settings > Your user ID
- ID อื่น ๆ: เมื่อตั้ง `ALLOWED_SOURCE_IDS` แล้ว ไฟล์จากผู้ส่งที่ไม่อยู่ในรายการจะถูกข้าม และ log
  `ข้ามไฟล์จากผู้ส่งที่ไม่ได้รับอนุญาต: {...}` ที่หน้า Executions ให้คัดลอก ID จากตรงนั้นมาเพิ่ม
- ใส่ groupId = ทุกคนในกลุ่มนั้นส่งไฟล์ได้, ใส่ userId = ผู้ใช้นั้นส่งได้ทั้งแชต 1:1 และในกลุ่ม
  (ในกลุ่ม LINE ส่ง userId มาเฉพาะผู้ใช้ LINE บน iOS / Android)

### ข้อจำกัด

- Apps Script อ่าน HTTP header ของคำขอไม่ได้ จึงตรวจลายเซ็น `X-Line-Signature` ของ LINE ไม่ได้
  โค้ดนี้ใช้ `WEBHOOK_KEY` ใน URL แทน ดังนั้นต้องเก็บ Webhook URL เป็นความลับ ถ้าสงสัยว่ารั่ว
  ให้ลบ `WEBHOOK_KEY` แล้วรัน `setupWebhookKey` ใหม่ และแก้ Webhook URL ใน LINE
  (ถ้าต้องการตรวจลายเซ็นจริง ต้องมีเซิร์ฟเวอร์ที่อ่าน header ได้คั่นกลาง เช่น Cloud Run / Cloud Functions)
- ไฟล์ที่บันทึกจะแชร์แบบ "ทุกคนที่มีลิงก์ดูได้" เพื่อให้คนในแชตเปิดได้โดยไม่ต้องขอสิทธิ์
  ในแชตกลุ่ม ทุกคนในกลุ่มจะเห็นลิงก์ จึงไม่ควรใช้กับเอกสารลับ
- ไฟล์ใหญ่เกิน 50 MB บันทึกไม่ได้ (ขีดจำกัดของ UrlFetchApp) บอทจะตอบกลับแจ้งแทน

## สิ่งที่แก้จากโค้ดเดิม

### ช่องโหว่

| ปัญหา | การแก้ไข |
| --- | --- |
| Channel access token เขียนไว้ในโค้ด ใครเห็นโค้ดก็เรียก Messaging API แทนบอทได้ทั้งหมด เช่น broadcast ข้อความถึงผู้ติดตามทุกคน | ย้ายไป Script properties และต้องออก token ใหม่ |
| ไม่ยืนยันว่าคำขอมาจาก LINE ใครรู้ URL ก็ยิงคำขอปลอมได้ เช่นส่ง message id เดิมซ้ำให้บันทึกไฟล์ซ้ำ หรือยิงจำนวนมากจนโควตา UrlFetch หมด | ตรวจ `WEBHOOK_KEY` ใน URL (fail closed ถ้าไม่ตั้งค่า) เทียบแบบเวลาคงที่ |
| แชร์ไฟล์ด้วย `DriveApp.Access.ANYONE` = "Anyone on the Internet can find and access" | เปลี่ยนเป็น `ANYONE_WITH_LINK` เปิดได้เฉพาะคนที่มีลิงก์ |
| ใครก็ได้ที่เพิ่มเพื่อนบอทส่งไฟล์เข้า Drive ของเจ้าของได้ไม่จำกัด (เต็มพื้นที่, ใช้เป็นที่ฝากไฟล์สาธารณะ) | จำกัดผู้ส่งได้ด้วย `ALLOWED_SOURCE_IDS` |
| ส่งข้อความ error ภายใน (`Error uploading to Google Drive: ...`) เข้าแชตแทนลิงก์ | log รายละเอียดไว้ที่ Executions และตอบผู้ใช้ด้วยข้อความทั่วไป |
| นำ `message.id` จาก body ไปต่อ URL ที่แนบ token โดยไม่ตรวจ | ตรวจให้เป็นตัวอักษร/ตัวเลขเท่านั้น |

### บั๊ก

| ปัญหา | การแก้ไข |
| --- | --- |
| `return` ใน `else` ออกจากลูปทันทีเมื่อเจอข้อความที่ไม่ใช่ไฟล์ event ที่เหลือในคำขอเดียวกันไม่ถูกประมวลผล | ข้ามเฉพาะ event นั้น แล้วตอบกลับครั้งเดียวตอนจบ |
| อ่าน `event.message.id` นอก try สำหรับ event ที่ไม่มี message (follow, join, postback ฯลฯ) ทำให้ `TypeError` และ event ที่เหลือหายทั้งหมด | ตรวจชนิด event ก่อน และ try/catch แยกทีละ event |
| `e.postData` ไม่มี หรือ body ไม่ใช่ JSON ทำให้ doPost พัง | ตรวจก่อนใช้ |
| ไม่ตรวจ HTTP status ของการดึงไฟล์จาก LINE | ใช้ `muteHttpExceptions` และตรวจ status code |
| `setSharing` ล้ม (โดเมนไม่อนุญาตแชร์ภายนอก) ทำให้ผู้ใช้ได้ error ทั้งที่ไฟล์บันทึกลง Drive แล้ว | ยังส่งลิงก์ให้ พร้อมแจ้งว่าเปิดได้เฉพาะผู้ที่มีสิทธิ์ |
| ไฟล์เกิน 50 MB ล้มโดยไม่บอกสาเหตุ | ตรวจ `fileSize` ก่อนดาวน์โหลด และแจ้งผู้ใช้ |
| เมื่อเปิด Webhook redelivery หรือมีคนส่งคำขอเดิมซ้ำ จะได้ไฟล์ซ้ำใน Drive | จำ message id ที่บันทึกแล้วไว้ด้วย `CacheService` |
| event ที่ไม่มี `replyToken` (เช่นโหมด standby) ยังพยายามตอบกลับ | ข้ามการตอบกลับ |
| ไม่ตรวจผลการ reply และ error ถูกกลืนด้วย `console.log` | ตรวจ status code และ log ด้วย `console.error` พร้อม stack |
| โค้ดรูป/วิดีโอ/เสียงที่ปิดไว้ บอกชื่อไฟล์ `.jpg` `.mp4` `.mp3` แต่ไฟล์ใน Drive ไม่มีนามสกุล | เปิดใช้ได้ใน `SAVE_TYPES` และตั้งนามสกุลตามชนิดข้อมูลที่ LINE ส่งมาจริง |
| ค่าคงที่ `DriveUrl` ไม่ได้ใช้ | ลบออก |
