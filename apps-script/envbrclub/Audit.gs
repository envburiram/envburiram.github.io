/*************************************************************
 * Audit.gs : บันทึกประวัติ (Audit trail)
 *
 * บันทึกทุกเหตุการณ์ว่า "ใคร ทำอะไร กับข้อมูลของใคร เมื่อไร"
 * รายละเอียดการแก้ไขเก็บเป็น JSON ที่เข้ารหัสไว้ และค่าของฟิลด์
 * อ่อนไหวจะถูกปกปิดบางส่วนก่อนบันทึก (data minimisation)
 *
 * เหตุการณ์ที่บันทึก
 *   auth.login / auth.fail / auth.logout / auth.locked / auth.pwchange
 *   member.create / member.update / member.status / member.delete / member.purge
 *   member.view_sensitive / member.card_print / member.card_verify
 *   export.excel / export.csv
 *   admin.create / admin.update / settings.update / security.key_rotate
 *************************************************************/

var ACTION_LABELS = {
  'auth.login': 'เข้าสู่ระบบ', 'auth.logout': 'ออกจากระบบ', 'auth.fail': 'เข้าสู่ระบบไม่สำเร็จ',
  'auth.locked': 'บัญชีถูกล็อก', 'auth.pwchange': 'เปลี่ยนรหัสผ่าน', 'auth.pwchange_fail': 'เปลี่ยนรหัสผ่านไม่สำเร็จ',
  'member.register': 'สมัครสมาชิกผ่านหน้าเว็บ', 'member.create': 'เพิ่มสมาชิก', 'member.update': 'แก้ไขข้อมูลสมาชิก',
  'member.status': 'เปลี่ยนสถานะสมาชิก', 'member.delete': 'ลบสมาชิก (ลบเชิงตรรกะ)', 'member.purge': 'ลบข้อมูลถาวร',
  'member.view_sensitive': 'เปิดดูข้อมูลอ่อนไหว', 'member.card_print': 'พิมพ์บัตรสมาชิก',
  'member.card_verify': 'ตรวจสอบบัตรผ่าน QR', 'member.autoexpire': 'ปรับสถานะหมดอายุอัตโนมัติ',
  'export.excel': 'ส่งออกไฟล์ Excel', 'export.csv': 'ส่งออกไฟล์ CSV',
  'admin.create': 'เพิ่มบัญชีผู้ดูแล', 'admin.update': 'แก้ไขบัญชีผู้ดูแล', 'admin.reset_pw': 'ตั้งรหัสผ่านใหม่',
  'settings.update': 'แก้ไขการตั้งค่า', 'security.key_rotate': 'หมุนกุญแจเข้ารหัส',
  'consent.withdraw': 'ถอนความยินยอม'
};

/** ปกปิดค่าอ่อนไหวก่อนเก็บลงบันทึก */
function maskValue_(field, v) {
  v = (v === null || v === undefined) ? '' : String(v);
  if (!v) return '(ว่าง)';
  if (M_SENSITIVE.indexOf(field) >= 0) {
    if (v.length <= 4) return '****';
    return v.substring(0, 2) + new Array(Math.max(4, v.length - 3)).join('*') + v.substring(v.length - 2);
  }
  return v.length > 150 ? v.substring(0, 150) + '…' : v;
}

/**
 * เขียนบันทึกประวัติ
 * @param {Object} actor   เซสชันผู้กระทำ {username, role, display_name}
 * @param {string} action  รหัสเหตุการณ์
 * @param {string} tType   ประเภทเป้าหมาย member/admin/system/settings
 * @param {string} tId     รหัสเป้าหมาย
 * @param {string} summary ข้อความสรุปที่ไม่มีข้อมูลอ่อนไหว
 * @param {Object} detail  รายละเอียด (จะถูกเข้ารหัสก่อนบันทึก)
 * @param {string} client  ข้อมูลเบราว์เซอร์ที่ผู้ใช้ส่งมา
 */
function writeLog_(actor, action, tType, tId, summary, detail, client) {
  try {
    var who = actor && actor.username ? actor.username : '(ไม่ระบุ)';
    var name = actor && actor.display_name ? ' (' + actor.display_name + ')' : '';
    appendRow_(SHEETS.LOG, LOG_COLS, {
      ts: now_(),
      actor: who + name,
      role: (actor && actor.role) || '-',
      action: action,
      target_type: tType,
      target_id: tId,
      summary: summary,
      detail_enc: encryptField_(JSON.stringify(detail || {})),
      client: String(client || '').substring(0, 250)
    });
  } catch (e) {
    // ห้ามให้การเขียน log ล้มเหลวไปกระทบธุรกรรมหลัก แต่ต้องเห็นใน execution log
    console.error('เขียนบันทึกประวัติไม่สำเร็จ: ' + e.message);
  }
}

/** สร้างรายการความแตกต่างของข้อมูลสมาชิก (ค่าเดิม → ค่าใหม่) */
function diffMember_(oldObj, newObj, fields) {
  var diff = [];
  fields.forEach(function (f) {
    var a = (oldObj[f] === undefined || oldObj[f] === null) ? '' : String(oldObj[f]);
    var b = (newObj[f] === undefined || newObj[f] === null) ? '' : String(newObj[f]);
    if (a !== b) {
      diff.push({
        field: f,
        label: M_LABELS[f] || f,
        from: maskValue_(f, a),
        to: maskValue_(f, b)
      });
    }
  });
  return diff;
}

/* ---------- อ่านบันทึกประวัติ ---------- */
function apiListLogs(token, opt) {
  var s = requireRole_(token, ['superadmin', 'admin', 'viewer']);
  opt = opt || {};
  var page = Math.max(1, Number(opt.page) || 1);
  var size = Math.min(200, Number(opt.pageSize) || 50);

  var rows = readTable_(SHEETS.LOG, LOG_COLS);
  rows.reverse(); // ใหม่สุดขึ้นก่อน

  var q = String(opt.q || '').toLowerCase().trim();
  var filtered = rows.filter(function (r) {
    if (opt.action && r.action !== opt.action) return false;
    if (opt.actor && String(r.actor).toLowerCase().indexOf(String(opt.actor).toLowerCase()) < 0) return false;
    if (opt.targetId && String(r.target_id) !== String(opt.targetId)) return false;
    if (opt.dateFrom && String(r.ts).substring(0, 10) < opt.dateFrom) return false;
    if (opt.dateTo && String(r.ts).substring(0, 10) > opt.dateTo) return false;
    if (q) {
      var hay = [r.actor, r.action, ACTION_LABELS[r.action] || '', r.summary, r.target_id].join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });

  var total = filtered.length;
  var slice = filtered.slice((page - 1) * size, page * size);

  // viewer ไม่เห็นรายละเอียดเชิงลึก
  var showDetail = s.role !== 'viewer';
  var items = slice.map(function (r) {
    var detail = {};
    if (showDetail) {
      try { detail = JSON.parse(decryptField_(r.detail_enc) || '{}'); } catch (e) { detail = {}; }
    }
    return {
      ts: r.ts, actor: r.actor, role: r.role, action: r.action,
      action_label: ACTION_LABELS[r.action] || r.action,
      target_type: r.target_type, target_id: r.target_id,
      summary: r.summary, detail: detail, client: showDetail ? r.client : ''
    };
  });

  return { ok: true, total: total, page: page, pageSize: size, items: items, actions: ACTION_LABELS };
}

/** สรุปกิจกรรมล่าสุดสำหรับหน้าแรกของผู้ดูแล */
function apiLogSummary(token) {
  requireAuth_(token);
  var rows = readTable_(SHEETS.LOG, LOG_COLS);
  var today = fmtDate_(new Date());
  var byAction = {};
  var todayCount = 0;
  rows.forEach(function (r) {
    byAction[r.action] = (byAction[r.action] || 0) + 1;
    if (String(r.ts).substring(0, 10) === today) todayCount++;
  });
  return { ok: true, total: rows.length, today: todayCount, byAction: byAction };
}
