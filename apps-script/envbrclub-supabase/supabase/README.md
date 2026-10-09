# สำรองฐานข้อมูล Supabase: club-data

โปรเจกต์ `club-data` (ref `ooovzjovkrfyuqakkpig`, องค์กร envburiramclub, ap-southeast-1, PostgreSQL 17)
สำรองเมื่อ 2026-10-01 ปรับปรุงล่าสุด 2026-10-09

| ไฟล์ | เนื้อหา |
| --- | --- |
| `schema.sql` | โครงสร้างฐานข้อมูลปัจจุบันทั้งหมดของสคีมา `public` และ `app_private`: ตาราง ฟังก์ชัน 58 ตัว ทริกเกอร์ ดัชนี RLS policy (รวม `storage.objects`) สิทธิ์ grant คอมเมนต์ storage bucket 4 ตัว และงานตามเวลา pg_cron 1 งาน |
| `seed.sql` | ข้อมูลอ้างอิงของระบบ: `org_types` (9 แถว) และ `settings` (8 แถว) |
| `migrations/` | SQL ของ migration ทั้ง 34 รายการตามที่บันทึกไว้ใน `supabase_migrations.schema_migrations` |

## ใช้ไฟล์ไหนกู้ระบบ

ใช้ `schema.sql` เป็นหลัก เพราะมีการแก้ฐานข้อมูลจริงหลายครั้งโดยไม่ผ่าน migration
(เช่น ตาราง `announcements`, บทบาท `registrar_treasurer`, policy ที่ใช้ `admin_can()`,
คอลัมน์ `receipts.voided_*` และ `members.work_addr_detail_enc`)
การรัน `migrations/` ตามลำดับจะได้โครงสร้างที่ยังไม่ตรงกับของจริง จึงเก็บไว้เป็นประวัติเท่านั้น

`schema.sql` ตรวจแล้วว่าตรงกับฐานข้อมูลจริงทุกรายการ (ตาราง คอลัมน์ ค่าเริ่มต้น เนื้อฟังก์ชัน
policy ทริกเกอร์ ดัชนี constraint สิทธิ์ RLS คอมเมนต์ และ bucket)

## วิธีกู้ลงโปรเจกต์ Supabase ใหม่

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f supabase/schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f supabase/seed.sql
```

`DATABASE_URL` ดูได้ที่ Project Settings > Database > Connection string (ใช้ผู้ใช้ `postgres`)

`schema.sql` ต้องใช้ส่วนขยาย `pg_cron` (Supabase มีให้ทุกโปรเจกต์) และสร้างงานประจำวันให้ด้วย

## งานประจำวัน (pg_cron)

| งาน | เวลา | ทำอะไร |
| --- | --- | --- |
| `club-expire-memberships` | `5 17 * * *` (17:05 UTC = 00:05 น. เวลาไทย) | `app_private.expire_memberships(true)` ปรับสมาชิกและบัตรที่เลยวันหมดอายุ (ตามวันที่ของไทย) เป็น "หมดอายุ" |

- หน้าภาพรวมของผู้ดูแลแสดงสถานะงานนี้ (`admin_system_health().protections.daily_expire_job`)
  ถ้างานถูกปิด รอบล่าสุดล้มเหลว หรือไม่ได้รันเกิน 26 ชั่วโมง หน้าภาพรวมจะเตือน
  และปรับสถานะให้เองเมื่อผู้ดูแลงานทะเบียนเปิดหน้านั้น
- ตรวจงาน: `select jobname, schedule, active from cron.job;`
  และ `select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5;`
- หยุดงาน: `select cron.unschedule('club-expire-memberships');`

## บทบาทในประวัติการใช้งาน (`audit_log.actor_role`)

นอกจากบทบาทของผู้ดูแลและ `member` (สมาชิกที่เข้าสู่ระบบ) ยังมี

- `system` งานอัตโนมัติ: งานประจำวันข้างต้น และการเรียกด้วย service_role (Edge Function `verify-slip`)
- `database` การแก้ข้อมูลตรงที่ฐานข้อมูลโดยไม่ผ่านระบบ (SQL editor, Table editor, migration)
  ผู้ตรวจควรสอบถามที่มาของรายการเหล่านี้
  (ก่อน 2026-10-09 รายการที่ไม่มีผู้ใช้เข้าสู่ระบบทั้งหมด รวมทั้งงานอัตโนมัติ ถูกบันทึกเป็น `member`)

## สิ่งที่ไม่อยู่ในที่เก็บนี้

ที่เก็บนี้เป็นสาธารณะ และ GitHub Pages เผยแพร่ทุกไฟล์ในที่เก็บ ห้ามนำข้อมูลต่อไปนี้มาไว้ที่นี่

- ข้อมูลสมาชิกและข้อมูลส่วนบุคคล: `members`, `applications`, `payments`, `receipts`, `cards`,
  `consents`, `profiles`, `admins`, `audit_log`, `app_private.counters` และทุกตารางในสคีมา `auth`
- ไฟล์ใน Storage (รูปถ่าย ลายมือชื่อ สลิป)
- กุญแจใน Vault (`club_pii_enc_key`, `club_pii_bidx_pepper`)
  `schema.sql` จะสร้างกุญแจใหม่แบบสุ่มให้โปรเจกต์ใหม่ ถ้าจะกู้ข้อมูลสมาชิกเดิมต้องใช้กุญแจเดิม
  มิฉะนั้นถอดรหัสคอลัมน์ `*_enc` (เลขบัตรประชาชน โทรศัพท์ ที่อยู่) ไม่ได้
- Edge Function `verify-slip` และ secret ของมัน
