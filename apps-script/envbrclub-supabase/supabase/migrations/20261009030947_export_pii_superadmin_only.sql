-- ส่งออกข้อมูลสมาชิกแบบรวมข้อมูลส่วนบุคคล (เลขประจำตัวประชาชนเต็ม เบอร์โทรศัพท์ ที่อยู่) ได้เฉพาะผู้ดูแลระดับสูงสุด
-- ---------------------------------------------------------------------------
-- เดิมผู้ที่มีพื้นที่ members ทุกบทบาท (admin registrar treasurer registrar_treasurer)
-- ส่งออกไฟล์ที่มีข้อมูลส่วนบุคคลของสมาชิกทุกรายได้ ซึ่งกว้างเกินความจำเป็นของงานประจำ
-- ระบบ envbrclub ใช้หลักให้เฉพาะ superadmin ขอไฟล์แบบเต็มได้ ส่วนบทบาทอื่นได้ไฟล์แบบปิดบัง
-- จึงนำหลักเดียวกันมาใช้ที่นี่ (หลักการเก็บและเปิดเผยข้อมูลเท่าที่จำเป็น)
--
-- พื้นที่ export_pii ไม่อยู่ในรายการของ admin_can() โดยเจตนา (แบบเดียวกับ admin_accounts และ slip_override)
-- admin_can('export_pii') จึงเป็นจริงเฉพาะผู้ดูแลระดับสูงสุด
-- admin_menu() ส่งค่า export_pii ให้หน้าเว็บซ่อนปุ่ม ส่วนการกันจริงอยู่ใน admin_export_members()
-- การส่งออกแบบปิดบัง (p_include_pii = false) ยังทำได้ทุกบทบาทที่มีพื้นที่ members เหมือนเดิม
--
-- คงค่าเริ่มต้นของ p_include_pii เป็น true ไว้ เพื่อไม่เปลี่ยนพฤติกรรมของผู้เรียกเดิม (หน้าเว็บส่งค่า true/false ทุกครั้ง)
-- ผู้ที่ไม่ใช่ผู้ดูแลระดับสูงสุดแล้วเรียกแบบไม่ส่งค่าจะถูกปฏิเสธด้วย 42501 จึงไม่รั่ว
-- ค่าว่าง (null) ส่งออกแบบปิดบังเหมือนเดิม และบันทึกประวัติเป็น false ให้ชัดว่าได้ไฟล์แบบใด
--
-- ขอบเขต: กันการส่งออกทั้งทะเบียนในครั้งเดียว ส่วนการเปิดดูข้อมูลส่วนบุคคลทีละรายในหน้าแก้ไขสมาชิก
-- (get_member_pii) ยังเปิดให้บทบาทที่มีพื้นที่ members ตามหน้าที่งานทะเบียน และทุกครั้งถูกบันทึกเป็น read_pii

CREATE OR REPLACE FUNCTION public.admin_export_members(p_include_pii boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare v_rows jsonb; v_n int;
begin
  perform app_private.require_area('members');

  -- ค่าว่าง = แบบปิดบัง (เหมือนเดิม) ทำให้ชัดก่อนใช้ ประวัติจะได้บันทึก true/false เสมอ
  p_include_pii := coalesce(p_include_pii, false);

  -- ข้อมูลส่วนบุคคลแบบเต็มเป็นสิทธิ์ของผู้ดูแลระดับสูงสุดเท่านั้น
  if p_include_pii and not public.admin_can('export_pii') then
    raise exception 'การส่งออกแบบรวมข้อมูลส่วนบุคคล (เลขประจำตัวประชาชน เบอร์โทรศัพท์ ที่อยู่) ทำได้เฉพาะผู้ดูแลระดับสูงสุด กรุณาเลือกส่งออกแบบปิดบังข้อมูลอ่อนไหว'
      using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at), '[]'::jsonb), count(*)
    into v_rows, v_n
  from (
    select
      m.member_code, m.status,
      coalesce(nullif(m.title, 'อื่นๆ'), m.title_other) as title,
      m.first_name, m.last_name, m.first_name_en, m.last_name_en,
      case when p_include_pii then app_private.decrypt_pii(m.national_id_enc)
           else 'xxxxxxxxx' || coalesce(m.national_id_last4, '') end as national_id,
      m.birth_date, m.gender, m.email,
      case when p_include_pii then app_private.decrypt_pii(m.phone_enc) else null end as phone,
      m.license_no, m.license_type, m.license_issued_on, m.license_expires_on,
      m.education_level, m.education_major,
      o.name as org_type_name, m.org_type_other, m.org_name, m.position_name,
      m.work_tambon, m.work_amphoe, m.work_province, m.work_zip, m.work_phone,
      case when p_include_pii then app_private.decrypt_pii(m.addr_detail_enc) else null end as addr_detail,
      m.addr_tambon, m.addr_amphoe, m.addr_province, m.addr_zip,
      m.member_since, m.valid_from, m.valid_to,
      c.card_no, c.issued_at as card_issued_at, c.status as card_status,
      r.receipt_no, r.amount as fee_paid, r.issued_at as receipt_issued_at,
      m.created_at
    from public.members m
    left join public.org_types o on o.code = m.org_type_code
    left join lateral (
      select c2.* from public.cards c2
       where c2.member_id = m.id and c2.status = 'active'
       order by c2.issued_at desc limit 1
    ) c on true
    left join lateral (
      select r2.* from public.receipts r2
       where r2.member_id = m.id order by r2.issued_at desc limit 1
    ) r on true
  ) t;

  perform app_private.log_audit('export_excel', 'members', null, null,
    jsonb_build_object('rows', v_n, 'include_pii', p_include_pii),
    'ส่งออกข้อมูลสมาชิกเป็นไฟล์ Excel');

  return jsonb_build_object('rows', v_rows, 'count', v_n, 'exported_at', now());
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_menu()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select jsonb_build_object(
    'role',           public.admin_role(),
    'dashboard',      public.admin_can('dashboard'),
    'applications',   public.admin_can('applications'),
    'payments',       public.admin_can('payments'),
    'members',        public.admin_can('members'),
    'audit',          public.admin_can('audit'),
    'announcements',  public.admin_can('announcements'),
    'signatories',         public.admin_can('signatories'),
    'signatory_president', public.admin_can('signatory_president'),
    'signatory_receipt',   public.admin_can('signatory_receipt'),
    'settings',       public.admin_can('settings'),
    'admin_accounts', public.admin_can('admin_accounts'),
    'slip_override',  public.admin_can('slip_override'),
    'slip_auto_approve',  public.admin_can('slip_auto_approve'),
    'bank_verify_switch', public.admin_can('bank_verify_switch'),
    'export_pii',     public.admin_can('export_pii')
  );
$function$
;

-- คำอธิบายในฐานข้อมูลให้ตรงกับสิทธิ์จริง
comment on function public.admin_can(p_area text) is 'บัญชีผู้ดูแลที่ล็อกอินอยู่ เข้าพื้นที่งานที่ระบุได้หรือไม่ พื้นที่: dashboard, applications, payments, members, audit, announcements, signatories, signatory_president, signatory_receipt, settings, slip_auto_approve และพื้นที่เฉพาะผู้ดูแลระดับสูงสุด: admin_accounts, slip_override, bank_verify_switch, export_pii';
comment on column public.admins.role is 'superadmin=ผู้ดูแลระดับสูงสุด (จัดการผู้ดูแลและดูได้ทั้งหมด), admin=ผู้ดูแลระบบ (ทุกเมนู ยกเว้นบัญชีผู้ดูแล การลบสมาชิก การแนบสลิปแทนสมาชิก สวิตช์ยืนยันสลิปกับธนาคาร และการส่งออกแบบรวมข้อมูลส่วนบุคคล), registrar=เจ้าหน้าที่ทะเบียน (ตรวจใบสมัคร/ทะเบียนสมาชิก/ประวัติ), treasurer=เจ้าหน้าที่การเงิน (ตรวจสลิป/ทะเบียนสมาชิก/ประวัติ), registrar_treasurer=เจ้าหน้าที่ทะเบียนและการเงิน (ตรวจใบสมัคร+ตรวจสลิป/ทะเบียนสมาชิก/ประวัติ)';
