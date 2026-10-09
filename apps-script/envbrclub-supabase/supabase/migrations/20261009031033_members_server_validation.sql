-- ตรวจความยาวและรูปแบบข้อมูลสมาชิกที่ฐานข้อมูล
-- ---------------------------------------------------------------------------
-- เดิมความยาวและรูปแบบของข้อมูลถูกจำกัดด้วย maxlength ของหน้าเว็บเท่านั้น
-- ผู้ที่เรียก upsert_my_member หรือ admin_update_member ผ่าน REST API ตรง ๆ
-- จึงบันทึกข้อความยาวเท่าใดก็ได้ อีเมลผิดรูปแบบ หรือวันเกิดในอนาคตได้
-- (ระบบ envbrclub ตรวจทุกช่องที่ฝั่งเซิร์ฟเวอร์ซ้ำกับหน้าเว็บ จึงนำหลักเดียวกันมาใช้)
--
-- ตรวจด้วยทริกเกอร์ BEFORE INSERT OR UPDATE บนตาราง members ที่เดียว
-- ครอบคลุมทุกทางที่เขียนตารางนี้ (upsert_my_member, admin_update_member และฟังก์ชันอนุมัติ/ยกเลิก)
-- โดยไม่ต้องแก้ตัวฟังก์ชันเหล่านั้น
--
-- ตอนแก้ไข (UPDATE) ตรวจเฉพาะช่องที่ค่าเปลี่ยน ข้อมูลเดิมที่ไม่ตรงเกณฑ์ (ถ้ามี)
-- จึงไม่ทำให้งานอื่นของแถวนั้น เช่น อนุมัติใบสมัคร ปรับสถานะหมดอายุ หรือแก้ช่องอื่น ล้มเหลว
-- ช่องที่เข้ารหัส (โทรศัพท์ ที่อยู่) : upsert_my_member และ admin_update_member เข้ารหัสใหม่ทุกครั้งที่บันทึก
-- และการเข้ารหัสแต่ละครั้งได้ค่าไม่ซ้ำกัน (pgp_sym_encrypt สุ่ม salt) จึงถอดรหัสเทียบข้อความเดิมก่อน
-- ตรวจเฉพาะเมื่อข้อความเปลี่ยนจริง เหมือนช่องอื่น
--
-- เกณฑ์ตรงกับ maxlength ในหน้าใบสมัครและหน้าแก้ไขข้อมูลสมาชิก
--   คำนำหน้า(อื่นๆ) 40 · ชื่อ/นามสกุล (ไทย/อังกฤษ) 80 · อีเมล 120 · เลขใบอนุญาต 60 · ประเภทใบอนุญาต 120
--   สาขาวิชา 120 · ประเภทหน่วยงาน(อื่นๆ) 150 · ชื่อหน่วยงาน 180 · ตำแหน่ง 150 · โทรศัพท์หน่วยงาน 30
--   ที่อยู่ (บ้านเลขที่/ถนน) 200 · โทรศัพท์มือถือ 20 ตัวอักษร มีตัวเลข 9-15 หลัก
--   รหัสไปรษณีย์ 5 หลัก · วันเกิดไม่อยู่ในอนาคตและไม่ก่อน พ.ศ. 2443
--   (ปีเกิดที่กรอกเป็น พ.ศ. ในช่อง ค.ศ. เช่น 2525 จะถูกปฏิเสธ)

create or replace function app_private.members_validate()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'app_private', 'public', 'pg_temp'
as $function$
declare
  e        text[] := '{}';
  o        public.members;   -- ค่าเดิม (ตอนเพิ่มแถวทุกช่องเป็นค่าว่าง ทุกช่องที่มีค่าจึงถูกตรวจ)
  v_phone  text;
  v_addr   text;
begin
  if tg_op = 'UPDATE' then
    o := old;
  end if;

  -- ข้อความ: ตรวจความยาวเมื่อเพิ่มแถว หรือเมื่อค่าเปลี่ยน
  if (new.title is distinct from o.title) and length(new.title) > 40 then
    e := e || 'คำนำหน้ายาวเกิน 40 ตัวอักษร'::text; end if;
  if (new.title_other is distinct from o.title_other) and length(new.title_other) > 40 then
    e := e || 'คำนำหน้า (อื่นๆ) ยาวเกิน 40 ตัวอักษร'::text; end if;
  if (new.first_name is distinct from o.first_name) then
    if btrim(coalesce(new.first_name, '')) = '' then e := e || 'กรุณากรอกชื่อ'::text;
    elsif length(new.first_name) > 80 then e := e || 'ชื่อยาวเกิน 80 ตัวอักษร'::text; end if;
  end if;
  if (new.last_name is distinct from o.last_name) then
    if btrim(coalesce(new.last_name, '')) = '' then e := e || 'กรุณากรอกนามสกุล'::text;
    elsif length(new.last_name) > 80 then e := e || 'นามสกุลยาวเกิน 80 ตัวอักษร'::text; end if;
  end if;
  if (new.first_name_en is distinct from o.first_name_en) and length(new.first_name_en) > 80 then
    e := e || 'ชื่อภาษาอังกฤษยาวเกิน 80 ตัวอักษร'::text; end if;
  if (new.last_name_en is distinct from o.last_name_en) and length(new.last_name_en) > 80 then
    e := e || 'นามสกุลภาษาอังกฤษยาวเกิน 80 ตัวอักษร'::text; end if;
  if (new.email is distinct from o.email) and new.email is not null then
    if length(new.email) > 120 then e := e || 'อีเมลยาวเกิน 120 ตัวอักษร'::text;
    elsif new.email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      e := e || 'รูปแบบอีเมลไม่ถูกต้อง'::text; end if;
  end if;
  if (new.license_no is distinct from o.license_no) and length(new.license_no) > 60 then
    e := e || 'เลขที่ใบอนุญาตยาวเกิน 60 ตัวอักษร'::text; end if;
  if (new.license_type is distinct from o.license_type) and length(new.license_type) > 120 then
    e := e || 'ประเภทใบอนุญาตยาวเกิน 120 ตัวอักษร'::text; end if;
  if (new.education_level is distinct from o.education_level) and length(new.education_level) > 60 then
    e := e || 'ระดับการศึกษายาวเกิน 60 ตัวอักษร'::text; end if;
  if (new.education_major is distinct from o.education_major) and length(new.education_major) > 120 then
    e := e || 'สาขาวิชายาวเกิน 120 ตัวอักษร'::text; end if;
  if (new.org_type_other is distinct from o.org_type_other) and length(new.org_type_other) > 150 then
    e := e || 'ประเภทหน่วยงาน (อื่นๆ) ยาวเกิน 150 ตัวอักษร'::text; end if;
  if (new.org_name is distinct from o.org_name) and length(new.org_name) > 180 then
    e := e || 'ชื่อหน่วยงานยาวเกิน 180 ตัวอักษร'::text; end if;
  if (new.position_name is distinct from o.position_name) and length(new.position_name) > 150 then
    e := e || 'ตำแหน่งยาวเกิน 150 ตัวอักษร'::text; end if;
  if (new.work_phone is distinct from o.work_phone) and length(new.work_phone) > 30 then
    e := e || 'โทรศัพท์หน่วยงานยาวเกิน 30 ตัวอักษร'::text; end if;
  if (new.work_tambon is distinct from o.work_tambon or new.work_amphoe is distinct from o.work_amphoe
      or new.work_province is distinct from o.work_province or new.addr_tambon is distinct from o.addr_tambon
      or new.addr_amphoe is distinct from o.addr_amphoe or new.addr_province is distinct from o.addr_province)
     and greatest(length(new.work_tambon), length(new.work_amphoe), length(new.work_province),
                  length(new.addr_tambon), length(new.addr_amphoe), length(new.addr_province)) > 100 then
    e := e || 'ชื่อตำบล อำเภอ หรือจังหวัดยาวเกิน 100 ตัวอักษร'::text; end if;
  if (new.work_zip is distinct from o.work_zip) and new.work_zip is not null and new.work_zip !~ '^[0-9]{5}$' then
    e := e || 'รหัสไปรษณีย์ของที่ทำงานต้องเป็นตัวเลข 5 หลัก'::text; end if;
  if (new.addr_zip is distinct from o.addr_zip) and new.addr_zip is not null and new.addr_zip !~ '^[0-9]{5}$' then
    e := e || 'รหัสไปรษณีย์ของที่อยู่ต้องเป็นตัวเลข 5 หลัก'::text; end if;

  -- วันที่
  if (new.birth_date is distinct from o.birth_date) and new.birth_date is not null
     and (new.birth_date < date '1900-01-01' or new.birth_date > (now() at time zone 'Asia/Bangkok')::date) then
    e := e || 'วันเกิดไม่ถูกต้อง (กรุณากรอกปีเป็น ค.ศ. ในปฏิทิน ระบบแสดงเป็น พ.ศ. ให้เอง)'::text; end if;
  if (new.license_issued_on is distinct from o.license_issued_on or new.license_expires_on is distinct from o.license_expires_on)
     and new.license_issued_on is not null and new.license_expires_on is not null
     and new.license_issued_on > new.license_expires_on then
    e := e || 'วันที่ออกใบอนุญาตต้องไม่หลังวันหมดอายุใบอนุญาต'::text; end if;
  if (new.valid_from is distinct from o.valid_from or new.valid_to is distinct from o.valid_to)
     and new.valid_from is not null and new.valid_to is not null and new.valid_from > new.valid_to then
    e := e || 'วันเริ่มสมาชิกภาพต้องไม่หลังวันหมดอายุ'::text; end if;

  -- ช่องที่เข้ารหัส : ถอดรหัสแล้วตรวจเฉพาะเมื่อข้อความต่างจากเดิม
  -- (ตอนเพิ่มแถว o เป็นค่าว่าง decrypt_pii(null) ได้ null ทุกค่าที่มีจึงถูกตรวจ)
  if (new.phone_enc is distinct from o.phone_enc) and new.phone_enc is not null then
    v_phone := app_private.decrypt_pii(new.phone_enc);
    if v_phone is distinct from app_private.decrypt_pii(o.phone_enc)
       and v_phone is not null and (length(v_phone) > 20 or v_phone !~ '^[0-9+() .-]+$'
        or length(regexp_replace(v_phone, '[^0-9]', '', 'g')) not between 9 and 15) then
      e := e || 'เบอร์โทรศัพท์มือถือไม่ถูกต้อง (ตัวเลข 9-15 หลัก ใช้ได้เฉพาะตัวเลข เว้นวรรค - + และวงเล็บ)'::text;
    end if;
  end if;
  if (new.addr_detail_enc is distinct from o.addr_detail_enc) and new.addr_detail_enc is not null then
    v_addr := app_private.decrypt_pii(new.addr_detail_enc);
    if v_addr is distinct from app_private.decrypt_pii(o.addr_detail_enc) and length(v_addr) > 200 then
      e := e || 'ที่อยู่ (บ้านเลขที่/หมู่/ถนน) ยาวเกิน 200 ตัวอักษร'::text; end if;
  end if;
  if (new.work_addr_detail_enc is distinct from o.work_addr_detail_enc) and new.work_addr_detail_enc is not null then
    v_addr := app_private.decrypt_pii(new.work_addr_detail_enc);
    if v_addr is distinct from app_private.decrypt_pii(o.work_addr_detail_enc) and length(v_addr) > 200 then
      e := e || 'ที่อยู่ที่ทำงานยาวเกิน 200 ตัวอักษร'::text; end if;
  end if;

  if array_length(e, 1) > 0 then
    raise exception 'ข้อมูลไม่ถูกต้อง: %', array_to_string(e, ' · ') using errcode = '22023';
  end if;
  return new;
end;
$function$;

-- ฟังก์ชันนี้ถอดรหัสข้อมูลส่วนบุคคลด้วยสิทธิ์ของเจ้าของ จึงไม่ให้บทบาทใดเรียกหรือนำไปผูกกับตารางอื่น
-- ทริกเกอร์ยังทำงานได้ทุกทางที่เขียนตาราง เพราะ PostgreSQL ตรวจสิทธิ์ EXECUTE ตอนสร้างทริกเกอร์เท่านั้น
-- (แบบเดียวกับ audit_row_change)
revoke all on function app_private.members_validate() from public, anon, authenticated, service_role;

-- create or replace (PostgreSQL 14 ขึ้นไป) รัน migration ซ้ำได้โดยไม่ต้องลบทริกเกอร์ก่อน
create or replace trigger trg_members_validate
  before insert or update on public.members
  for each row execute function app_private.members_validate();
