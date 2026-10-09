-- ตรวจบัตร: บัตรจากการต่ออายุล่วงหน้าใช้ได้ทันที และนับวันตามเวลาประเทศไทย
-- ---------------------------------------------------------------------------
-- admin_decide_application ต่ออายุก่อนหมดอายุโดยให้บัตรใบใหม่เริ่มใช้วันถัดจากวันหมดอายุเดิม
-- และเปลี่ยนบัตรใบเดิมเป็น "ถูกแทนที่" ทันที ช่วงระหว่างนั้น verify_card จึงตอบว่าใช้ไม่ได้ทั้งสองใบ
-- ทั้งที่สมาชิกภาพต่อเนื่องไม่ขาดช่วง
--
-- 1) verify_card : บัตรที่ยังไม่ถึงวันเริ่มใช้นับว่าใช้ได้ เมื่อไล่ย้อนบัตรใบก่อน ๆ ของสมาชิกคนเดียวกัน
--    ที่สถานะ "ถูกแทนที่" และต่อเนื่องกันไม่มีช่วงขาด ไปถึงใบที่ครอบคลุมวันนี้ได้
--    (รองรับการออกบัตรใหม่ระหว่างรอ และการต่ออายุล่วงหน้าซ้อนกันหลายงวด)
--    และต้องไม่มีบัตรใบใดของสมาชิกถูกยกเลิก (revoked) หลังจากออกบัตรใบที่ครอบคลุมวันนี้
--    ส่ง renewed_early ให้หน้าเว็บแจ้งเหตุผล และ not_yet_valid ที่ฐานข้อมูลตัดสินตามเวลาไทย
--    ให้หน้าเว็บใช้แทนการคำนวณจากนาฬิกาของเครื่องผู้ตรวจ
-- 2) admin_decide_application :
--    - นับวันตามเวลาประเทศไทย อนุมัติช่วง 00:00-06:59 น. เดิมได้วันเริ่มเป็นเมื่อวาน (อายุสมาชิกขาดไป 1 วัน)
--    - ใบสมัครต่ออายุที่ยื่นไว้ก่อนสมาชิกถูกยกเลิกสมาชิกภาพ อนุมัติไม่ได้
--      (มิฉะนั้นงวดใหม่จะนับต่อและบัตรใหม่ใช้ได้ต่อเนื่องจากช่วงที่ถูกยกเลิกไปแล้ว)
--      การรับกลับทำได้ทางใบสมัครใหม่ (submit_application ตั้งเป็น new ให้สมาชิกที่ถูกยกเลิกอยู่แล้ว)
--
-- วันที่ใช้เวลาประเทศไทย ฐานข้อมูลตั้งเขตเวลาเป็น UTC ค่า current_date จึงช้ากว่าวันในประเทศไทย
-- ในช่วง 00:00-06:59 น. ทำให้บัตรที่หมดอายุเมื่อวานยังตอบว่าใช้ได้อีก 7 ชั่วโมง

CREATE OR REPLACE FUNCTION public.verify_card(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_c public.cards; v_m public.members; v_org text;
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
  v_bridge boolean := false;
begin
  if p_token is null or btrim(p_token) = '' then
    return jsonb_build_object('found', false, 'reason', 'ไม่พบรหัสตรวจสอบ');
  end if;
  select * into v_c from public.cards c where c.verify_token = btrim(p_token);
  if v_c.id is null then
    return jsonb_build_object('found', false, 'reason', 'ไม่พบบัตรสมาชิกที่ตรงกับรหัสนี้');
  end if;
  select * into v_m from public.members m where m.id = v_c.member_id;
  v_org := case
    when v_m.org_type_code = 'other' then coalesce(v_m.org_name, v_m.org_type_other)
    else coalesce(v_m.org_name, (select o.name from public.org_types o where o.code = v_m.org_type_code))
  end;

  -- บัตรจากการต่ออายุล่วงหน้า : ไล่ย้อนบัตรใบก่อนที่ถูกแทนที่และต่อเนื่องกัน จนถึงใบที่ครอบคลุมวันนี้
  -- ทุกขั้นวันเริ่มต้องน้อยลง จึงไม่วนซ้ำ และจำกัดไว้ 10 ขั้น
  if v_c.status = 'active' and v_m.status = 'active' and v_today < v_c.valid_from then
    with recursive chain (valid_from, issued_at, depth) as (
      select v_c.valid_from, v_c.issued_at, 0
      union all
      select c2.valid_from, c2.issued_at, ch.depth + 1
        from chain ch
        join public.cards c2
          on c2.member_id = v_c.member_id
         and c2.status = 'replaced'
         and c2.valid_from < ch.valid_from
         and c2.valid_to >= ch.valid_from - 1
       where ch.valid_from > v_today
         and ch.depth < 10
    )
    select exists (
      select 1 from chain ch
       where ch.depth > 0
         and ch.valid_from <= v_today
         -- มีการยกเลิกบัตรหลังจากออกบัตรใบที่ครอบคลุมวันนี้ = สมาชิกภาพช่วงนี้ถูกยกเลิกแล้ว
         and not exists (
           select 1 from public.cards c3
            where c3.member_id = v_c.member_id
              and c3.status = 'revoked'
              and c3.issued_at > ch.issued_at)
    ) into v_bridge;
  end if;

  return jsonb_build_object(
    'found', true,
    'member_code', v_m.member_code,
    'full_name', btrim(coalesce(nullif(v_m.title, 'อื่นๆ'), v_m.title_other, '') || ' ' ||
                       v_m.first_name || ' ' || v_m.last_name),
    'position_name', v_m.position_name,
    'org_name', v_org,
    'card_no', v_c.card_no,
    'issued_at', v_c.issued_at,
    'valid_from', v_c.valid_from,
    'valid_to', v_c.valid_to,
    'card_status', v_c.status,
    'member_status', v_m.status,
    'is_valid', (v_c.status = 'active'
                 and v_m.status = 'active'
                 and v_today <= v_c.valid_to
                 and (v_today >= v_c.valid_from or v_bridge)),
    'renewed_early', v_bridge,
    'not_yet_valid', (v_today < v_c.valid_from),
    'checked_at', now());
end; $function$
;

CREATE OR REPLACE FUNCTION public.admin_decide_application(p_app_id uuid, p_approve boolean, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app_private', 'pg_temp'
AS $function$
declare
  v_app public.applications; v_m public.members; v_card public.cards;
  v_from date; v_to date; v_code text; v_years int;
  -- วันที่ตามเวลาประเทศไทย (ฐานข้อมูลเป็น UTC current_date ช้ากว่าวันในไทยช่วง 00:00-06:59 น.)
  v_today date := (now() at time zone 'Asia/Bangkok')::date;
begin
  perform app_private.require_area('applications');

  select * into v_app from public.applications a where a.id = p_app_id;
  if v_app.id is null then
    raise exception 'ไม่พบใบสมัคร' using errcode = 'P0002';
  end if;
  select * into v_m from public.members m where m.id = v_app.member_id;

  if not p_approve then
    if nullif(btrim(coalesce(p_note, '')), '') is null then
      raise exception 'กรุณาระบุเหตุผลที่ไม่อนุมัติ' using errcode = '22023';
    end if;
    update public.applications a
       set status = 'rejected', reviewed_at = now(), reviewed_by = auth.uid(),
           review_note = btrim(p_note)
     where a.id = p_app_id;
    perform app_private.log_audit('reject_application', 'applications', p_app_id::text,
      v_app.app_no, null, 'ไม่อนุมัติใบสมัคร: ' || btrim(p_note));
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;

  if v_app.status <> 'payment_verified' then
    raise exception 'ต้องตรวจสอบการชำระเงินให้ผ่านก่อนอนุมัติใบสมัคร (สถานะปัจจุบัน: %)', v_app.status
      using errcode = '55000';
  end if;

  -- ใบสมัครต่ออายุที่ยื่นไว้ก่อนสมาชิกถูกยกเลิกสมาชิกภาพ ห้ามนับต่อจากงวดเดิม
  -- (มิฉะนั้นบัตรใบใหม่จะต่อเนื่องจากช่วงที่ถูกยกเลิกไปแล้ว) รับกลับได้ทางใบสมัครใหม่เท่านั้น
  if v_app.app_type = 'renew' and v_m.status = 'revoked' then
    raise exception 'สมาชิกรายนี้ถูกยกเลิกสมาชิกภาพแล้ว จึงอนุมัติใบสมัครต่ออายุนี้ไม่ได้ กรุณาบันทึกไม่อนุมัติพร้อมเหตุผล หากจะรับกลับเป็นสมาชิก ให้ยื่นใบสมัครใหม่'
      using errcode = '55000';
  end if;

  v_years := greatest(coalesce(v_app.term_years, 1), 1);

  -- ต่ออายุก่อนหมดอายุ: นับต่อจากวันหมดอายุเดิม
  if v_app.app_type = 'renew' and v_m.valid_to is not null and v_m.valid_to >= v_today then
    v_from := v_m.valid_to + 1;
  else
    v_from := v_today;
  end if;
  v_to := (v_from + (v_years || ' years')::interval)::date - 1;

  v_code := coalesce(v_m.member_code, app_private.gen_code('MEM'));

  update public.members m
     set member_code  = v_code,
         status       = 'active',
         member_since = coalesce(m.member_since, v_from),
         valid_from   = v_from,
         valid_to     = v_to,
         updated_by   = auth.uid()
   where m.id = v_m.id;

  -- บัตรใบเดิมถือว่าถูกแทนที่
  update public.cards c set status = 'replaced'
   where c.member_id = v_m.id and c.status = 'active';

  insert into public.cards
    (member_id, application_id, card_no, verify_token, valid_from, valid_to, status)
  values
    (v_m.id, v_app.id, app_private.gen_code('CARD'),
     encode(extensions.gen_random_bytes(16), 'hex'), v_from, v_to, 'active')
  returning * into v_card;

  update public.applications a
     set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid(),
         review_note = nullif(btrim(coalesce(p_note, '')), ''),
         period_start = v_from, period_end = v_to
   where a.id = p_app_id;

  perform app_private.log_audit('approve_application', 'applications', p_app_id::text,
    v_app.app_no, jsonb_build_object('member_code', v_code, 'card_no', v_card.card_no,
                                     'valid_from', v_from, 'valid_to', v_to),
    'อนุมัติใบสมัครและออกบัตรสมาชิก');

  return jsonb_build_object('ok', true, 'status', 'approved', 'member_code', v_code,
    'card_no', v_card.card_no, 'card_id', v_card.id,
    'valid_from', v_from, 'valid_to', v_to);
end; $function$
;
