/*************************************************************
 * Export.gs : ส่งออกข้อมูลเป็นไฟล์ Excel (.xlsx) และ CSV
 *
 * ขั้นตอน : สร้างสเปรดชีตชั่วคราว > แปลงเป็น .xlsx ผ่าน Drive export
 *           > ส่งไฟล์กลับหน้าเว็บเป็น base64 > ลบไฟล์ชั่วคราวทันที
 *
 * ข้อกำหนดด้านความเป็นส่วนตัว
 *  - viewer ส่งออกไม่ได้
 *  - admin ส่งออกได้ แต่เลขประจำตัวประชาชนจะถูกปกปิด
 *  - superadmin เท่านั้นที่เลือก "รวมเลขประจำตัวประชาชนแบบเต็ม" ได้
 *    และทุกครั้งจะถูกบันทึกไว้ในประวัติการใช้งาน
 *************************************************************/

/**
 * กัน formula injection ในไฟล์ส่งออก : ข้อความที่ขึ้นต้นด้วย = + - @ แท็บ หรือขึ้นบรรทัด
 * จะถูกเติม ' ข้างหน้า ทั้งในสเปรดชีตชั่วคราว (Google Sheets ถือว่าเป็นข้อความ) และใน CSV (ตามแนวทาง OWASP)
 * ไม่เช่นนั้นข้อมูลที่ผู้สมัครกรอก เช่น =HYPERLINK(...) จะกลายเป็นสูตรในไฟล์ของผู้ดูแล
 */
function formulaSafe_(v) {
  return typeof v === 'string' && /^[=+\-@\t\r\n]/.test(v) ? "'" + v : v;
}

var EXPORT_FIELDS = [
  'member_code', 'status', 'prefix', 'first_name', 'last_name', 'national_id', 'birthdate', 'gender',
  'member_type', 'position', 'organization', 'work_type', 'work_address',
  'phone', 'email', 'line_id', 'education', 'license_no',
  'issue_date', 'expire_date', 'consent_version', 'consent_at', 'consent_marketing',
  'created_at', 'created_by', 'updated_at', 'updated_by'
];

function buildMemberRows_(role, opt) {
  opt = opt || {};
  var full = (role === 'superadmin') && opt.includeNationalId === true;
  var all = loadMembers_(false);

  var q = String(opt.q || '').trim().toLowerCase();
  var rows = all.filter(function (m) {
    if (opt.status && m.status !== opt.status) return false;
    if (opt.member_type && m.member_type !== opt.member_type) return false;
    if (opt.work_type && m.work_type !== opt.work_type) return false;
    if (q) {
      var hay = [m.member_code, m.first_name, m.last_name, m.position, m.organization].join(' ').toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  });

  rows.sort(function (a, b) { return String(a.member_code) > String(b.member_code) ? 1 : -1; });

  var header = ['ลำดับ'].concat(EXPORT_FIELDS.map(function (f) { return M_LABELS[f] || f; }));
  var data = rows.map(function (m, i) {
    return [i + 1].concat(EXPORT_FIELDS.map(function (f) {
      if (f === 'status') return STATUS_LABELS[m.status] || m.status;
      if (f === 'national_id') return full ? "'" + m.national_id : maskValue_('national_id', m.national_id);
      if (f === 'phone') return "'" + String(m.phone || '');
      if (f === 'consent_marketing') return m.consent_marketing === 'yes' ? 'ยินยอม' : 'ไม่ยินยอม';
      return m[f] === undefined || m[f] === null ? '' : String(m[f]);
    }));
  });
  return { header: header, data: data, count: rows.length, full: full };
}

function buildLogRows_(opt) {
  opt = opt || {};
  var rows = readTable_(SHEETS.LOG, LOG_COLS).filter(function (r) {
    if (opt.dateFrom && String(r.ts).substring(0, 10) < opt.dateFrom) return false;
    if (opt.dateTo && String(r.ts).substring(0, 10) > opt.dateTo) return false;
    if (opt.action && r.action !== opt.action) return false;
    return true;
  });
  var header = ['วันเวลา', 'ผู้ใช้งาน', 'สิทธิ์', 'เหตุการณ์', 'ประเภทเป้าหมาย', 'เป้าหมาย', 'รายละเอียด', 'ฟิลด์ที่แก้ไข'];
  var data = rows.map(function (r) {
    var d = {};
    try { d = JSON.parse(decryptField_(r.detail_enc) || '{}'); } catch (e) { }
    var changes = (d.changes || []).map(function (c) {
      return c.label + ': ' + c.from + ' → ' + c.to;
    }).join(' | ');
    return [r.ts, r.actor, r.role, ACTION_LABELS[r.action] || r.action,
      r.target_type, r.target_id, r.summary, changes];
  });
  return { header: header, data: data, count: rows.length };
}

/**
 * ส่งออก Excel
 * @param {string} token   โทเคนเซสชัน
 * @param {Object} opt     {type:'members'|'logs', filters..., includeNationalId:boolean}
 */
function apiExportExcel(token, opt, client) {
  var s = requireRole_(token, ['superadmin', 'admin']);
  opt = opt || {};
  var isLog = opt.type === 'logs';
  var built = isLog ? buildLogRows_(opt) : buildMemberRows_(s.role, opt);
  if (!built.count) return { ok: false, error: 'ไม่พบข้อมูลตามเงื่อนไขที่เลือก' };

  var stamp = Utilities.formatDate(new Date(), APP.TZ, 'yyyyMMdd-HHmm');
  var title = (isLog ? 'ประวัติการใช้งาน' : 'รายชื่อสมาชิก') + '-' + APP.SHORT + '-' + stamp;

  var tmp = SpreadsheetApp.create(title);
  var tmpId = tmp.getId();
  try {
    var sh = tmp.getSheets()[0];
    sh.setName(isLog ? 'ประวัติการใช้งาน' : 'รายชื่อสมาชิก');
    ensureColumns_(sh, built.header.length);   // ชีตใหม่มี 26 คอลัมน์ แต่รายงานสมาชิกใช้ 28

    // ส่วนหัวรายงาน
    var settings = getSettings_();
    sh.getRange(1, 1).setValue(formulaSafe_(settings.CLUB_NAME)).setFontSize(14).setFontWeight('bold');
    sh.getRange(2, 1).setValue(
      (isLog ? 'รายงานประวัติการใช้งานระบบ' : 'ทะเบียนสมาชิก') +
      '  ณ วันที่ ' + Utilities.formatDate(new Date(), APP.TZ, 'd MMM yyyy HH:mm') +
      '  จำนวน ' + built.count + ' รายการ');
    sh.getRange(3, 1).setValue('ผู้ส่งออก: ' + s.display_name + ' (' + s.username + ')' +
      (built.full ? '  |  รวมเลขประจำตัวประชาชนแบบเต็ม — เอกสารลับ ห้ามเผยแพร่' : '  |  เลขประจำตัวประชาชนถูกปกปิด'))
      .setFontColor(built.full ? '#b00020' : '#555555');

    var startRow = 5;
    sh.getRange(startRow, 1, 1, built.header.length).setValues([built.header])
      .setFontWeight('bold').setBackground('#0e5b4e').setFontColor('#ffffff');
    if (built.data.length) {
      sh.getRange(startRow + 1, 1, built.data.length, built.header.length)
        .setValues(built.data.map(function (row) { return row.map(formulaSafe_); }));
    }
    sh.setFrozenRows(startRow);
    sh.getRange(startRow, 1, built.data.length + 1, built.header.length)
      .setBorder(true, true, true, true, true, true, '#cccccc', SpreadsheetApp.BorderStyle.SOLID);
    for (var c = 1; c <= built.header.length; c++) sh.autoResizeColumn(c);
    SpreadsheetApp.flush();

    // แปลงเป็น xlsx
    var url = 'https://www.googleapis.com/drive/v3/files/' + tmpId +
      '/export?mimeType=application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet';
    var resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) throw new Error('แปลงไฟล์ไม่สำเร็จ (' + resp.getResponseCode() + ')');
    var bytes = resp.getBlob().getBytes();

    writeLog_(s, 'export.excel', isLog ? 'system' : 'member', '-',
      'ส่งออกไฟล์ Excel ' + (isLog ? 'ประวัติการใช้งาน' : 'รายชื่อสมาชิก') + ' จำนวน ' + built.count + ' รายการ' +
      (built.full ? ' (รวมเลขประจำตัวประชาชนแบบเต็ม)' : ' (ปกปิดเลขประจำตัวประชาชน)'),
      { count: built.count, filters: opt, full_id: built.full }, client);

    return {
      ok: true, filename: title + '.xlsx', count: built.count,
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: Utilities.base64Encode(bytes)
    };
  } finally {
    try { DriveApp.getFileById(tmpId).setTrashed(true); } catch (e) { }
  }
}

/** ส่งออก CSV (เปิดใน Excel ได้ ใส่ BOM ให้ภาษาไทยไม่เพี้ยน) */
function apiExportCsv(token, opt, client) {
  var s = requireRole_(token, ['superadmin', 'admin']);
  opt = opt || {};
  var isLog = opt.type === 'logs';
  var built = isLog ? buildLogRows_(opt) : buildMemberRows_(s.role, opt);
  if (!built.count) return { ok: false, error: 'ไม่พบข้อมูลตามเงื่อนไขที่เลือก' };

  var lines = [built.header].concat(built.data).map(function (row) {
    return row.map(function (v) {
      var t = formulaSafe_(String(v === null || v === undefined ? '' : v).replace(/^'/, ''));
      return '"' + t.replace(/"/g, '""') + '"';
    }).join(',');
  }).join('\r\n');

  var stamp = Utilities.formatDate(new Date(), APP.TZ, 'yyyyMMdd-HHmm');
  var name = (isLog ? 'ประวัติการใช้งาน' : 'รายชื่อสมาชิก') + '-' + stamp + '.csv';
  var bytes = Utilities.newBlob('\ufeff' + lines, 'text/csv', name).getBytes();

  writeLog_(s, 'export.csv', isLog ? 'system' : 'member', '-',
    'ส่งออกไฟล์ CSV จำนวน ' + built.count + ' รายการ', { count: built.count, filters: opt }, client);

  return { ok: true, filename: name, count: built.count, mime: 'text/csv', data: Utilities.base64Encode(bytes) };
}
