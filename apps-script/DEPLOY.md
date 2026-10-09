# Deploy Apps Script และสแกน HawkScan จากเซสชัน Claude Code บนคลาวด์

เอกสารนี้ใช้คู่กับกฎใน `CLAUDE.md` (โดยเฉพาะข้อ 4 เรื่อง deploy Apps Script)
ส่วนที่ 1 ตั้งค่าครั้งเดียว ส่วนที่ 2 เป็นคำสั่งสำหรับคัดลอกไปวางในเซสชันใหม่

ห้ามนำค่าจริงของ token หรือคีย์มาใส่ในไฟล์นี้หรือไฟล์ใดใน repo (repo เป็นสาธารณะ)
และห้ามวางค่าเหล่านี้ในแชต

## 1. ตั้งค่า environment ก่อนเปิดเซสชันใหม่

ตั้งค่าที่ claude.ai/code → เมนู cloud environment บนแถบชื่อเซสชัน → **Edit**

### ก. ตัวแปรสำหรับ deploy (`CLASPRC_JSON_B64`)

1. ใช้บัญชี Google ที่เป็นเจ้าของสคริปต์ เปิด https://script.google.com/home/usersettings แล้วเปิด **Google Apps Script API**
2. ในเครื่องของคุณ (ต้องมี Node.js) รัน `npm install -g @google/clasp@3.4.1` แล้ว `clasp login` และ login บัญชีเดียวกัน
   จะได้ไฟล์ `.clasprc.json`
3. แปลงไฟล์เป็นข้อความบรรทัดเดียว:

   ```
   node -e "process.stdout.write(require('fs').readFileSync(require('os').homedir()+'/.clasprc.json').toString('base64'))"
   ```

4. ใส่ในช่อง **Environment variables** เป็น `CLASPRC_JSON_B64=<ค่าที่ได้>`

### ข. คีย์ HawkScan (`HAWK_API_KEY`)

1. เข้า https://app.stackhawk.com → **Settings → API Keys** → สร้างคีย์ใหม่
   คีย์มีรูปแบบ `hawk.xxxx.xxxx` และแสดงแค่ครั้งเดียวตอนสร้าง
2. ใส่ในช่อง **Environment variables** เป็น `HAWK_API_KEY=<คีย์>`

ต้องใส่ทั้งสองค่าเป็น Environment variables ใช้ Network secrets แทนไม่ได้
เพราะทั้ง clasp และ hawk ต้องอ่านค่าจากไฟล์หรือตัวแปรในเครื่อง

ข้อควรระวัง: ทุกคนที่ใช้ environment นี้อ่านค่าได้ จึงควรใช้ environment ส่วนตัว และลบตัวแปรหลังใช้เสร็จ
ถ้าสงสัยว่าค่ารั่ว ให้ยกเลิกสิทธิ์ของ clasp ที่ https://myaccount.google.com/permissions
และลบคีย์ในหน้า API Keys ของ StackHawk

### ค. Setup script

```bash
#!/bin/bash
npm install -g @google/clasp@3.4.1 || true
url=$(curl -fsSL https://download.stackhawk.com/hawkdocs/hawk.manifest.json \
  | jq -r '.latest.assets[] | select(.asset.group == "linux-x64" and (.url | endswith("/hawk"))) | .url') \
  && curl -fsSL "$url" -o /usr/local/bin/hawk && chmod +x /usr/local/bin/hawk || true
exit 0
```

### ง. Network access

เลือก **Custom** (หรือ **Limited**) ติ๊ก **Also include default list of common package managers**
แล้วใส่ใน **Allowed domains**:

```
script.google.com
script.googleapis.com
oauth2.googleapis.com
www.googleapis.com
*.googleusercontent.com
download.stackhawk.com
api.stackhawk.com
app.stackhawk.com
ooovzjovkrfyuqakkpig.supabase.co
```

## 2. คำสั่งสำหรับวางในเซสชันใหม่

```text
ทำงานกับ repo envburiram/envburiram.github.io ตามกฎใน CLAUDE.md ทุกข้อ (ตอบภาษาไทย ตรวจข้อเท็จจริง ตรวจบั๊กก่อน commit/push ไป main เท่านั้น และกฎข้อ 4 เรื่อง deploy Apps Script)

งาน: deploy Apps Script 2 โปรเจกต์ที่แก้ล่าสุด
- apps-script/envbrclub (commit 8e594df)
- apps-script/envbrclub-supabase (commit ec80ca7 และ e99f037 — ฐานข้อมูล Supabase apply migration 4 ชุดไปแล้ว ไม่ต้องแตะฐานข้อมูล)
pm25 และ line-drive ไม่ได้แก้ ไม่ต้องทำอะไร

0) เตรียมเครื่องมือ
- ตรวจ `clasp --version` ต้องเป็น 3.4.1 ถ้าไม่มีให้ `npm install -g @google/clasp@3.4.1`
- ถ้ายังไม่มี ~/.clasprc.json ให้สร้างจากตัวแปรที่ฉันตั้งไว้:
  printf '%s' "$CLASPRC_JSON_B64" | base64 -d > ~/.clasprc.json && chmod 600 ~/.clasprc.json
  ห้ามแสดงเนื้อหาไฟล์หรือค่าตัวแปรใด ๆ ออกมา
- ตรวจว่า login ได้ด้วย `clasp show-authorized-user` ถ้าไม่มีตัวแปร หรือ login ไม่ผ่าน ให้หยุดและบอกฉันว่าต้องตั้งค่าอะไร ห้ามขอให้ฉันวาง token ในแชต

1) เทียบโค้ดตามกฎข้อ 4 ทีละโปรเจกต์
- สร้างโฟลเดอร์ชั่วคราวใน scratchpad คัดลอก .clasp.json ไปไว้ แล้วรัน `clasp pull` ที่นั่น ห้าม pull ทับโฟลเดอร์ใน repo
- เทียบกับ repo เฉพาะไฟล์ที่ clasp จัดการ (.gs .js .html appsscript.json) โดยเทียบชื่อไฟล์แบบไม่สนนามสกุล เพราะไฟล์ .gs ใน repo จะถูก pull มาเป็น .js และไม่นับความต่างของ CRLF หรือบรรทัดว่างท้ายไฟล์ ใช้ `clasp status` ดูรายการไฟล์ที่จะ push ประกอบ
- ตัดสิน:
  ไม่ต่างกัน → ไม่ต้อง deploy
  Apps Script มีส่วนที่ repo ไม่มี (ไม่มีอยู่ในประวัติ git ของ repo เลย) → หยุด สรุปความต่างให้ฉันดู แล้วถามก่อน
  repo ใหม่กว่า → ทำข้อ 2

2) Deploy (เฉพาะโปรเจกต์ที่ repo ใหม่กว่า)
- รัน `clasp push -f` ในโฟลเดอร์โปรเจกต์ของ repo
- รัน `clasp deployments` หา deployment เดิมของ web app (ไม่ใช่ @HEAD) ถ้ามีมากกว่าหนึ่งตัวให้หยุดถาม
- รัน `clasp update-deployment <deploymentId> -d "<สรุปสั้นของ commit>"` เพื่ออัปเดต deployment เดิมให้ได้ URL เดิม ห้ามใช้ `clasp deploy` แบบไม่ระบุ -i เพราะจะได้ URL ใหม่
- รัน `clasp deployments` อีกครั้ง ยืนยันว่า deploymentId เดิมชี้ไปที่ version ใหม่

3) ตรวจหลัง deploy
- curl https://script.google.com/macros/s/<deploymentId>/exec?page=verify ต้องได้ HTTP 200 หรือ 302
- โปรเจกต์ envbrclub: ให้บอกฉันว่าต้องรัน diagnose() หนึ่งครั้งจากตัวแก้ไขสคริปต์ (ตาม README ข้อ 1.7) ไม่ต้องลองใช้ clasp run

4) HawkScan (ทำเมื่อมี HAWK_API_KEY และคำสั่ง hawk เท่านั้น)
- ใช้ skill hawkscan โดยรันเป็น `API_KEY=$HAWK_API_KEY hawk ...`
- เป้าหมายคือระบบจริงที่มีข้อมูลสมาชิก ก่อนสแกนให้อธิบายเป้าหมาย ขอบเขต และผลข้างเคียงที่อาจเกิด แล้วรอฉันยืนยัน
- จำกัดเฉพาะหน้า public ห้ามส่งฟอร์มสมัคร เข้าสู่ระบบ หรือฟอร์มที่เขียนข้อมูล
- ห้ามใส่คีย์ในไฟล์ใด และถามฉันก่อน commit stackhawk.yml

5) รายงานเป็นภาษาไทย
- แต่ละโปรเจกต์ deploy หรือไม่ เพราะอะไร
- deploymentId และ URL เดิมที่ยังใช้อยู่
- ผลตรวจหลัง deploy และผล HawkScan
- commit/push เฉพาะเมื่อมีไฟล์ใน repo เปลี่ยนเท่านั้น
```

ถ้าเปิดเซสชันใหม่แล้วยังไม่มีตัวแปร `CLASPRC_JSON_B64` คำสั่งข้างบนจะหยุดที่ข้อ 0
และบอกว่าต้องตั้งค่าอะไรก่อน ไม่ deploy ไปเอง
