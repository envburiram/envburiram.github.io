-- ปรับสถานะสมาชิกและบัตรที่หมดอายุอัตโนมัติทุกวัน (pg_cron) ตามเวลาประเทศไทย
-- ---------------------------------------------------------------------------
-- เดิมสถานะ "สมาชิกปัจจุบัน" ค้างอยู่จนกว่าผู้ดูแลจะกดปุ่มปรับสถานะ (admin_expire_memberships)
-- ตัวเลขสถิติ การกรองทะเบียน และไฟล์ Excel จึงคลาดเคลื่อน
-- ระบบ envbrclub มีงานประจำวันปรับสถานะให้เอง จึงนำหลักเดียวกันมาใช้ด้วย pg_cron
--
-- 1) app_private.expire_memberships() ทำงานปรับสถานะจริง ใช้ร่วมกันทั้งงานประจำวันและปุ่มของผู้ดูแล
--    เทียบกับวันที่ตามเวลาประเทศไทย (ฐานข้อมูลตั้งเขตเวลาเป็น UTC ถ้าใช้ current_date
--    งานที่รันเวลา 00:05 น. ของไทยจะยังเห็นเป็นวันก่อน บัตรที่หมดอายุเมื่อวานจะถูกปรับช้าไปหนึ่งวัน)
-- 2) admin_expire_memberships() ยังตรวจสิทธิ์พื้นที่ members แล้วเรียกฟังก์ชันข้อ 1
-- 3) log_audit() : เหตุการณ์ที่ไม่มีผู้ใช้เข้าสู่ระบบ เดิมบันทึกบทบาทเป็น member ทำให้ประวัติแสดงว่าสมาชิกเป็นผู้แก้ไข
--    แยกเป็น
--    - system   : งานอัตโนมัติ คืองานประจำวันนี้ (ตั้ง app.audit_actor = system ใน transaction ของงาน)
--                 และการเรียกด้วย service_role (Edge Function ตรวจสลิปกับธนาคาร)
--    - database : การแก้ข้อมูลตรงที่ฐานข้อมูล (SQL editor, Table editor, migration) ซึ่งเป็นการกระทำของคน
--                 นอกระบบ ต้องแยกให้ผู้ตรวจเห็น ไม่ปนกับงานอัตโนมัติ
--    ผู้ใช้ที่เข้าสู่ระบบมี auth.uid() เสมอ จึงตั้งค่าเหล่านี้เพื่อปลอมบทบาทไม่ได้
-- 4) งาน pg_cron ชื่อ club-expire-memberships รันทุกวัน 17:05 UTC = 00:05 น. เวลาประเทศไทย
-- 5) admin_system_health() รายงานงานประจำวัน : daily_expire_job เป็นจริงเมื่องานเปิดอยู่
--    และรอบล่าสุด (ตาม runid) ไม่ล้มเหลวและรันภายใน 26 ชั่วโมง (หรือยังไม่เคยรันหลังตั้งงาน)
--    พร้อม daily_expire_active / daily_expire_last_status / daily_expire_last_run ให้หน้าเว็บบอกสาเหตุ
-- 6) admin_stats() (สมาชิกที่จะหมดอายุใน 60 วัน) และ get_my_status() (บัตรหมดอายุหรือยัง)
--    นับวันตามเวลาประเทศไทยเหมือนงานประจำวันและการตรวจบัตร

-- Supabase ให้สิทธิ์ที่ postgres ต้องใช้ (USAGE บน cron, SELECT บน cron.job/cron.job_run_details,
-- เรียก cron.schedule) ตอนสร้างส่วนขยายแล้ว และตั้งใจไม่ให้แก้ cron.job ตรง จึงไม่ grant เพิ่ม
create extension if not exists pg_cron with schema pg_catalog;

CREATE OR REPLACE FUNCTION app_private.log_audit(p_action text, p_entity text, p_entity_id text, p_entity_label text DEFAULT NULL::text, p_changed jsonb DEFAULT NULL::jsonb, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  v_role  text;
begin
  begin
    v_email := nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'email', '');
  exception when others then
    v_email := null;
  end;

  if v_email is null and v_uid is not null then
    select p.email into v_email from public.profiles p where p.id = v_uid;
  end if;

  -- ทางสำรองสุดท้าย อ่านจากตารางผู้ใช้โดยตรง
  if v_email is null and v_uid is not null then
    select u.email into v_email from auth.users u where u.id = v_uid;
  end if;

  select a.role into v_role from public.admins a where a.user_id = v_uid and a.active;

  -- ไม่มีผู้ใช้ที่เข้าสู่ระบบ : งานอัตโนมัติ (system) หรือการแก้ตรงที่ฐานข้อมูล (database)
  if v_role is null and v_uid is null then
    v_role := 'database';
    if current_setting('app.audit_actor', true) = 'system' then
      v_role := 'system';
    else
      begin
        if current_setting('request.jwt.claims', true)::jsonb ->> 'role' = 'service_role' then
          v_role := 'system';
        end if;
      exception when others then
        null;
      end;
    end if;
  end if;

  insert into public.audit_log
    (actor_id, actor_email, actor_role, action, entity, entity_id, entity_label, changed, note)
  values
    (v_uid, v_email, coalesce(v_role, 'member'),
     p_action, p_entity, p_entity_id, p_entity_label, p_changed, p_note);
end;
$function$
;

create or replace function app_private.expire_memberships(p_scheduled boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'app_private', 'pg_temp'
as $function$
declare
  v_m int; v_c int;
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
  v_prev_actor text := current_setting('app.audit_actor', true);
begin
  -- งานประจำวัน : ให้ประวัติที่เกิดในฟังก์ชันนี้ (รวมจากทริกเกอร์) บันทึกผู้ทำเป็น system
  -- แล้วคืนค่าเดิมก่อนจบ คำสั่งอื่นใน transaction เดียวกันจะได้ไม่ถูกนับเป็นงานอัตโนมัติ
  if p_scheduled then
    perform set_config('app.audit_actor', 'system', true);
  end if;

  update public.cards c set status = 'expired'
   where c.status = 'active' and c.valid_to < v_today;
  get diagnostics v_c = row_count;
  update public.members m set status = 'expired'
   where m.status = 'active' and m.valid_to is not null and m.valid_to < v_today;
  get diagnostics v_m = row_count;
  if v_m > 0 or v_c > 0 then
    perform app_private.log_audit('expire_sweep', 'members', null, null,
      jsonb_build_object('members_expired', v_m, 'cards_expired', v_c),
      case when p_scheduled then 'ระบบปรับสถานะสมาชิก/บัตรที่หมดอายุอัตโนมัติประจำวัน'
           else 'ปรับสถานะสมาชิก/บัตรที่หมดอายุ' end);
  end if;
  if p_scheduled then
    perform set_config('app.audit_actor', coalesce(v_prev_actor, ''), true);
  end if;
  return jsonb_build_object('ok', true, 'members_expired', v_m, 'cards_expired', v_c);
end;
$function$;

revoke all on function app_private.expire_memberships(boolean) from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_expire_memberships()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
begin
  perform app_private.require_area('members');
  return app_private.expire_memberships(false);
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_system_health()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_enc jsonb;
  v_active boolean := false; v_last_status text; v_last_at timestamptz; v_last_runid bigint;
begin
  perform app_private.require_area('dashboard');
  v_enc := app_private.check_encryption();
  -- อ่านตารางของ pg_cron แบบไม่ผูกตอนสร้างฟังก์ชัน ถ้าส่วนขยายหายไปจะรายงานว่าไม่ทำงานแทนการล้ม
  if to_regclass('cron.job') is not null then
    begin
      -- รอบล่าสุดเรียงตาม runid (start_time ว่างได้ถ้าฐานข้อมูลรีสตาร์ตระหว่างเริ่มรอบ)
      execute $q$
        select j.active, d.status, coalesce(d.start_time, d.end_time), d.runid
          from cron.job j
          left join lateral (
            select r.runid, r.status, r.start_time, r.end_time from cron.job_run_details r
             where r.jobid = j.jobid order by r.runid desc limit 1
          ) d on true
         where j.jobname = $1$q$
        into v_active, v_last_status, v_last_at, v_last_runid using 'club-expire-memberships';
    exception when others then
      v_active := false;
    end;
  end if;
  return jsonb_build_object(
    'encryption', v_enc,
    'counts', jsonb_build_object(
      'members',      (select count(*) from public.members),
      'applications', (select count(*) from public.applications),
      'payments',     (select count(*) from public.payments),
      'receipts',     (select count(*) from public.receipts),
      'cards',        (select count(*) from public.cards),
      'consents',     (select count(*) from public.consents),
      'audit_log',    (select count(*) from public.audit_log),
      'admins',       (select count(*) from public.admins where active)
    ),
    'oldest_audit', (select min(at) from public.audit_log),
    'latest_audit', (select max(at) from public.audit_log),
    'protections', jsonb_build_object(
      'audit_log_append_only', exists (
        select 1 from pg_trigger where tgname = 'trg_audit_log_append_only' and not tgisinternal),
      'receipts_block_member_delete', true,
      'delete_requires_name_confirmation', true,
      'consents_survive_member_delete', true,
      'daily_expire_job', coalesce(v_active, false)
        and coalesce(v_last_status, '') <> 'failed'
        and (v_last_runid is null or coalesce(v_last_at > now() - interval '26 hours', false)),
      'daily_expire_active', coalesce(v_active, false),
      'daily_expire_last_status', v_last_status,
      'daily_expire_last_run', v_last_at
    ),
    'checked_at', now()
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.admin_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
begin
  perform app_private.require_area('dashboard');
  return jsonb_build_object(
    'members_total',   (select count(*) from public.members),
    'members_active',  (select count(*) from public.members where status = 'active'),
    'members_pending', (select count(*) from public.members where status = 'pending'),
    'members_expired', (select count(*) from public.members where status = 'expired'),
    'expiring_60d',    (select count(*) from public.members
                         where status = 'active' and valid_to is not null
                           and valid_to between (now() at time zone 'Asia/Bangkok')::date and (now() at time zone 'Asia/Bangkok')::date + 60),
    'apps_awaiting_payment', (select count(*) from public.applications where status = 'awaiting_payment'),
    'apps_payment_submitted',(select count(*) from public.applications where status = 'payment_submitted'),
    'apps_payment_verified', (select count(*) from public.applications where status = 'payment_verified'),
    'payments_pending',(select count(*) from public.payments where status = 'pending'),
    'fees_verified_total', (select coalesce(sum(amount), 0) from public.payments where status = 'verified'),
    'cards_active',    (select count(*) from public.cards where status = 'active'),
    'by_org_type',     (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (
                          select coalesce(o.name, 'ไม่ระบุ') as k, count(*) as n
                          from public.members m
                          left join public.org_types o on o.code = m.org_type_code
                          group by 1) s),
    'by_amphoe',       (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (
                          select coalesce(work_amphoe, 'ไม่ระบุ') as k, count(*) as n
                          from public.members group by 1) s2)
  );
end; $function$
;

CREATE OR REPLACE FUNCTION public.get_my_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_m   public.members;
  v_app public.applications;
  v_pay public.payments;
  v_rec public.receipts;
  v_card public.cards;
begin
  if v_uid is null then
    raise exception 'ต้องเข้าสู่ระบบก่อน' using errcode = '28000';
  end if;

  select * into v_m from public.members m where m.user_id = v_uid;
  if v_m.id is null then
    return jsonb_build_object('has_member', false, 'is_admin', public.is_admin());
  end if;

  select * into v_app from public.applications a
   where a.member_id = v_m.id order by a.created_at desc limit 1;

  if v_app.id is not null then
    select * into v_pay from public.payments pm
     where pm.application_id = v_app.id order by pm.created_at desc limit 1;
    select * into v_rec from public.receipts r
     where r.application_id = v_app.id and r.voided_at is null order by r.issued_at desc limit 1;
  end if;

  select * into v_card from public.cards c
   where c.member_id = v_m.id and c.status = 'active'
   order by c.issued_at desc limit 1;

  return jsonb_build_object(
    'has_member', true,
    'is_admin',   public.is_admin(),
    'member', jsonb_build_object(
      'id', v_m.id, 'member_code', v_m.member_code, 'status', v_m.status,
      'title', v_m.title, 'title_other', v_m.title_other,
      'first_name', v_m.first_name, 'last_name', v_m.last_name,
      'first_name_en', v_m.first_name_en, 'last_name_en', v_m.last_name_en,
      'national_id', app_private.decrypt_pii(v_m.national_id_enc),
      'national_id_last4', v_m.national_id_last4,
      'phone', app_private.decrypt_pii(v_m.phone_enc),
      'addr_detail', app_private.decrypt_pii(v_m.addr_detail_enc),
      'birth_date', v_m.birth_date, 'gender', v_m.gender, 'email', v_m.email,
      'license_no', v_m.license_no, 'license_type', v_m.license_type,
      'license_issued_on', v_m.license_issued_on, 'license_expires_on', v_m.license_expires_on,
      'education_level', v_m.education_level, 'education_major', v_m.education_major,
      'org_type_code', v_m.org_type_code, 'org_type_other', v_m.org_type_other,
      'org_name', v_m.org_name, 'position_name', v_m.position_name,
      'work_tambon', v_m.work_tambon, 'work_amphoe', v_m.work_amphoe,
      'work_addr_detail', app_private.decrypt_pii(v_m.work_addr_detail_enc),
      'work_province', v_m.work_province, 'work_zip', v_m.work_zip, 'work_phone', v_m.work_phone,
      'addr_tambon', v_m.addr_tambon, 'addr_amphoe', v_m.addr_amphoe,
      'addr_province', v_m.addr_province, 'addr_zip', v_m.addr_zip,
      'photo_path', v_m.photo_path, 'signature_path', v_m.signature_path,
      'member_since', v_m.member_since, 'valid_from', v_m.valid_from, 'valid_to', v_m.valid_to
    ),
    'application', case when v_app.id is null then null else jsonb_build_object(
      'id', v_app.id, 'app_no', v_app.app_no, 'app_type', v_app.app_type,
      'status', v_app.status, 'fee_amount', v_app.fee_amount, 'term_years', v_app.term_years,
      'submitted_at', v_app.submitted_at, 'reviewed_at', v_app.reviewed_at,
      'review_note', v_app.review_note,
      'period_start', v_app.period_start, 'period_end', v_app.period_end
    ) end,
    'payment', case when v_pay.id is null then null else jsonb_build_object(
      'id', v_pay.id, 'amount', v_pay.amount, 'status', v_pay.status,
      'paid_at', v_pay.paid_at, 'bank_name', v_pay.bank_name, 'ref_no', v_pay.ref_no,
      'slip_path', v_pay.slip_path, 'check_score', v_pay.check_score,
      'check_result', v_pay.check_result, 'reject_reason', v_pay.reject_reason,
      'verified_at', v_pay.verified_at,
      'server_check_score', v_pay.server_check_score,
      'server_check_result', v_pay.server_check_result,
      'bank_verify_status', v_pay.bank_verify_status,
      'bank_verify_at', v_pay.bank_verify_at
    ) end,
    'receipt', case when v_rec.id is null then null else jsonb_build_object(
      'id', v_rec.id, 'receipt_no', v_rec.receipt_no, 'amount', v_rec.amount,
      'amount_text', v_rec.amount_text, 'issued_at', v_rec.issued_at,
      'payer_name', v_rec.payer_name, 'purpose', v_rec.purpose
    ) end,
    'card', case when v_card.id is null then null else jsonb_build_object(
      'id', v_card.id, 'card_no', v_card.card_no, 'verify_token', v_card.verify_token,
      'issued_at', v_card.issued_at, 'valid_from', v_card.valid_from,
      'valid_to', v_card.valid_to, 'status', v_card.status,
      'print_count', v_card.print_count,
      'is_expired', (v_card.valid_to < (now() at time zone 'Asia/Bangkok')::date)
    ) end
  );
end;
$function$
;

-- รันทุกวัน 00:05 น. เวลาประเทศไทย (pg_cron ใช้เวลา UTC) ชื่อเดิมจะถูกแทนที่ จึงรัน migration ซ้ำได้
select cron.schedule('club-expire-memberships', '5 17 * * *',
  $cron$select app_private.expire_memberships(true)$cron$);

-- ปรับรอบแรกทันที ไม่ต้องรอถึง 00:05 น. (บันทึกประวัติเฉพาะเมื่อมีรายการถูกปรับ)
-- คนเป็นผู้สั่งผ่าน migration จึงใช้ false ให้ประวัติบันทึกเป็น database ไม่ใช่งานอัตโนมัติ
select app_private.expire_memberships(false);
