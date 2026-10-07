# กฎการทำงานกับ repo นี้

1. ตอบเป็นภาษาไทย และตรวจสอบข้อเท็จจริงก่อนตอบ
2. ก่อน commit/push ตรวจบั๊กและช่องโหว่ให้ละเอียด แล้วแก้ไขก่อน
3. commit/push ไป `main` เท่านั้น
4. ก่อน deploy ขึ้น Apps Script (`scriptId` ใน `.clasp.json`) ให้เทียบโค้ด repo กับใน Apps Script
   - ถ้าไม่มีการเปลี่ยนแปลง ไม่ต้อง deploy
   - ถ้า Apps Script มีส่วนที่ repo ไม่มี ให้หยุดและถามก่อน
   - ถ้า repo ใหม่กว่า ให้ push แล้วอัปเดต deployment เดิม ห้ามสร้าง URL ใหม่
