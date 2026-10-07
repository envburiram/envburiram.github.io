/*************************************************************
 * ระบบรับสมัครสมาชิก ชมรมอนามัยสิ่งแวดล้อมจังหวัดบุรีรัมย์
 * Code.gs : ค่าคงที่ระบบ / ติดตั้งฐานข้อมูล / เส้นทางหน้าเว็บ
 *
 * ฐานข้อมูล : Google Sheets (เข้ารหัสข้อมูลส่วนบุคคลรายฟิลด์)
 * ประมวลผล  : Google Apps Script (V8)
 *************************************************************/

var APP = {
  NAME: 'ระบบสมาชิกชมรมอนามัยสิ่งแวดล้อมจังหวัดบุรีรัมย์',
  SHORT: 'ชมรมอนามัยสิ่งแวดล้อม จ.บุรีรัมย์',
  VERSION: '1.0.0',
  CONSENT_VERSION: '2569.1',   // เวอร์ชันหนังสือให้ความยินยอม (แก้แล้วต้องขอความยินยอมใหม่)
  TZ: 'Asia/Bangkok',
  SESSION_HOURS: 6,
  MAX_LOGIN_FAIL: 5,
  LOCK_MINUTES: 15,
  PAGE_SIZE: 25,
  CARD_YEARS: 3,               // อายุบัตรสมาชิก (ปี)
  RETENTION_YEARS: 10,         // ระยะเวลาเก็บข้อมูลหลังพ้นสมาชิกภาพ
  MAX_IMAGE_BYTES: 1500000,    // 1.5 MB ต่อรูป เมื่อผู้ดูแลอัปโหลด
  // หน้าสมัครสาธารณะ (ไม่ต้องล็อกอิน) : จำกัดขนาดและจำนวน กันการยิงคำขอจน Drive/สเปรดชีตของเจ้าของเต็ม
  MAX_PUBLIC_IMAGE_BYTES: 400000,  // หน้าเว็บย่อรูปก่อนส่งอยู่แล้ว ปกติไม่เกิน 200 KB
  REGISTER_PER_10MIN: 150,     // รองรับการสแกน QR สมัครพร้อมกันในที่ประชุม
  REGISTER_PER_DAY: 500,       // นับจากตาราง (ใบสมัครผ่านเว็บของวันนี้ เวลาไทย)
  MAX_PENDING: 1000,           // ใบสมัครรอตรวจสอบค้างได้ไม่เกินนี้
  LOGIN_FAIL_MIN_MS: 6000      // เข้าสู่ระบบไม่สำเร็จตอบช้าเท่ากันทุกกรณี ไม่ให้เดาชื่อผู้ใช้จากเวลาตอบ
};

var SHEETS = {
  MEMBERS: 'Members',
  ADMINS: 'Admins',
  LOG: 'AuditLog',
  SESSIONS: 'Sessions',
  SETTINGS: 'Settings',
  CONSENT: 'ConsentLog'
};

/** ลำดับคอลัมน์ตาราง Members (ห้ามสลับลำดับหลังใช้งานจริง) */
var M_COLS = [
  'id', 'member_code', 'status',
  'prefix', 'first_name', 'last_name', 'name_idx',
  'national_id', 'nid_idx', 'birthdate', 'gender',
  'position', 'organization', 'work_type', 'work_address',
  'phone', 'phone_idx', 'email', 'email_idx', 'line_id',
  'member_type', 'education', 'license_no',
  'photo_id', 'signature_id',
  'issue_date', 'expire_date',
  'consent_version', 'consent_at', 'consent_marketing',
  'verify_token', 'note',
  'created_at', 'created_by', 'updated_at', 'updated_by'
];

/** ฟิลด์ที่ต้องเข้ารหัสก่อนบันทึกลงชีต */
var M_ENCRYPTED = [
  'first_name', 'last_name', 'national_id', 'birthdate',
  'phone', 'email', 'line_id', 'work_address', 'note'
];

/** ฟิลด์อ่อนไหวสูง : ปกปิดค่าก่อนบันทึกลง AuditLog */
var M_SENSITIVE = ['national_id', 'birthdate', 'phone', 'email', 'line_id', 'work_address'];

/** ชื่อฟิลด์ภาษาไทย ใช้ทั้งใน log และไฟล์ Excel */
var M_LABELS = {
  id: 'รหัสระบบ', member_code: 'เลขสมาชิก', status: 'สถานะ',
  prefix: 'คำนำหน้า', first_name: 'ชื่อ', last_name: 'นามสกุล',
  national_id: 'เลขประจำตัวประชาชน', birthdate: 'วันเกิด', gender: 'เพศ',
  position: 'ตำแหน่ง', organization: 'หน่วยงาน', work_type: 'ประเภทหน่วยงาน',
  work_address: 'ที่อยู่หน่วยงาน', phone: 'โทรศัพท์', email: 'อีเมล', line_id: 'ไลน์ไอดี',
  member_type: 'ประเภทสมาชิก', education: 'วุฒิการศึกษา', license_no: 'เลขใบอนุญาต/เลขที่ ว.',
  photo_id: 'รูปถ่าย', signature_id: 'ลายเซ็น',
  issue_date: 'วันออกบัตร', expire_date: 'วันหมดอายุ',
  consent_version: 'เวอร์ชันความยินยอม', consent_at: 'วันที่ให้ความยินยอม',
  consent_marketing: 'ยินยอมรับข่าวสาร', verify_token: 'รหัสตรวจสอบ', note: 'หมายเหตุ',
  created_at: 'สร้างเมื่อ', created_by: 'สร้างโดย', updated_at: 'แก้ไขล่าสุด', updated_by: 'แก้ไขโดย'
};

var STATUS_LABELS = {
  pending: 'รอตรวจสอบ', active: 'สมาชิกปัจจุบัน', suspended: 'ระงับชั่วคราว',
  expired: 'หมดอายุ', revoked: 'พ้นสมาชิกภาพ', deleted: 'ลบแล้ว'
};

var ADMIN_COLS = ['username', 'display_name', 'email', 'role', 'pw_hash', 'pw_salt', 'pw_iter',
  'status', 'must_change', 'created_at', 'last_login', 'fail_count'];
var LOG_COLS = ['ts', 'actor', 'role', 'action', 'target_type', 'target_id', 'summary', 'detail_enc', 'client'];
var SESSION_COLS = ['token_hash', 'username', 'role', 'display_name', 'created_at', 'expire_at', 'client', 'must_change'];
var CONSENT_COLS = ['ts', 'member_id', 'member_code', 'consent_version', 'purposes', 'channel', 'client'];

/* =========================================================
 * เส้นทางหน้าเว็บ
 * =======================================================*/
function doGet(e) {
  var p = (e && e.parameter) || {};
  var page = p.page || 'register';
  try {
    switch (page) {
      case 'admin':
        return render_('Admin', 'ผู้ดูแลระบบ · ' + APP.SHORT, null, false);
      case 'verify':
        return render_('Verify', 'ตรวจสอบสมาชิก · ' + APP.SHORT, { t: cleanToken_(p.t) }, true);
      case 'card':
        return render_('Card', 'บัตรสมาชิก', { pt: cleanToken_(p.pt) }, false);
      case 'privacy':
        return render_('Privacy', 'ประกาศความเป็นส่วนตัว · ' + APP.SHORT, null, true);
      default:
        return render_('Register', 'สมัครสมาชิก · ' + APP.SHORT, null, true);
    }
  } catch (err) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:24px">เกิดข้อผิดพลาด: ' +
      escapeHtml_(err.message) + '</div>');
  }
}

/**
 * allowEmbed : ให้เว็บอื่นฝังหน้าใน iframe ได้ (เฉพาะหน้าสาธารณะ)
 * หน้าผู้ดูแลและหน้าบัตรห้ามฝัง เพื่อกัน clickjacking
 */
function render_(file, title, params, allowEmbed) {
  var t = HtmlService.createTemplateFromFile(file);
  t.APP = APP;
  t.PARAMS = params || {};
  t.WEBAPP_URL = getWebAppUrl_();
  t.SETTINGS = getPublicSettings();
  return t.evaluate()
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=5')
    .setXFrameOptionsMode(allowEmbed ? HtmlService.XFrameOptionsMode.ALLOWALL : HtmlService.XFrameOptionsMode.DEFAULT);
}

/** โทเคนในลิงก์เป็น base64 แบบ web-safe เท่านั้น ค่าอื่นทิ้งไป */
function cleanToken_(v) {
  v = String(v || '');
  return /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : '';
}

/**
 * แปลงค่าเป็น JSON สำหรับฝังใน <script> ของเทมเพลต
 * JSON.stringify อย่างเดียวไม่พอ เพราะข้อความ "</script>" จะปิดแท็กสคริปต์และเปิดช่องให้ฝังสคริปต์ได้
 */
function jsonForScript_(v) {
  return JSON.stringify(v === undefined ? null : v)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * ทุกฟังก์ชันที่ชื่อไม่ลงท้ายด้วย _ ถูกเรียกจากหน้าเว็บผ่าน google.script.run ได้ (รวมถึงคนที่ไม่ได้ล็อกอิน)
 * และทำงานด้วยสิทธิ์เจ้าของสคริปต์ ฟังก์ชันดูแลระบบที่ตั้งใจให้รันจากตัวแก้ไขสคริปต์จึงต้องเรียกฟังก์ชันนี้ก่อนเสมอ
 * คนที่เรียกผ่านเว็บจะได้ getActiveUser เป็นค่าว่าง หรือเป็นอีเมลที่ไม่ใช่เจ้าของ จึงถูกปฏิเสธ
 * (ต้องมี scope userinfo.email ใน appsscript.json)
 */
function requireEditor_() {
  var active = '', owner = '';
  try {
    active = Session.getActiveUser().getEmail();
    owner = Session.getEffectiveUser().getEmail();
  } catch (e) { /* ไม่มีสิทธิ์อ่านอีเมล ถือว่าไม่ใช่เจ้าของ */ }
  if (!active || active !== owner) throw new Error('ฟังก์ชันนี้เรียกได้จากตัวแก้ไขสคริปต์โดยเจ้าของระบบเท่านั้น');
}

/**
 * ตัวนับอัตราใน CacheService : คืน false เมื่อเกิน limit ครั้งต่อช่วง windowSec วินาที
 * (นับแบบประมาณ ไม่ atomic แต่พอสำหรับกันการยิงคำขอจำนวนมาก)
 */
function rateAllow_(name, limit, windowSec) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'RATE:' + name + ':' + Math.floor(new Date().getTime() / (windowSec * 1000));
    var n = Number(cache.get(key) || 0) + 1;
    cache.put(key, String(n), Math.min(21600, windowSec + 60));
    return n <= limit;
  } catch (e) {
    return true;
  }
}

/** ถูกเรียกจาก trigger ของโปรเจกต์นี้จริง (คนภายนอกไม่รู้ triggerUid จึงปลอมไม่ได้) */
function isOwnTrigger_(e) {
  var uid = e && e.triggerUid ? String(e.triggerUid) : '';
  if (!uid) return false;
  return ScriptApp.getProjectTriggers().some(function (t) { return String(t.getUniqueId()) === uid; });
}

function getWebAppUrl_() {
  var url = PropertiesService.getScriptProperties().getProperty('WEBAPP_URL');
  if (url) return url;
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

/* =========================================================
 * ตัวช่วยเข้าถึงสเปรดชีต
 * =======================================================*/
function ss_() {
  var cached = ss_._ss;
  if (cached) return cached;
  var id = PropertiesService.getScriptProperties().getProperty('SS_ID');
  var s = null;
  if (id) {
    s = SpreadsheetApp.openById(id);
  } else {
    s = SpreadsheetApp.getActiveSpreadsheet();
    if (!s) throw new Error('ยังไม่ได้ผูกฐานข้อมูล กรุณาเรียกใช้ฟังก์ชัน setup() หนึ่งครั้งก่อน');
    PropertiesService.getScriptProperties().setProperty('SS_ID', s.getId());
  }
  ss_._ss = s;
  return s;
}

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('ไม่พบตาราง ' + name + ' — กรุณาเรียก setup() อีกครั้ง');
  return sh;
}

/** ชีตที่สร้างใหม่มี 26 คอลัมน์ แต่บางตารางต้องใช้มากกว่านั้น จึงต้องขยายก่อนใช้งานเสมอ */
function ensureColumns_(sh, need) {
  var max = sh.getMaxColumns();
  if (max < need) sh.insertColumnsAfter(max, need - max);
  return sh;
}

/** ค่าที่อ่านจากชีตอาจกลายเป็นวันที่หรือตัวเลข แปลงกลับเป็นข้อความรูปแบบเดิมเสมอ */
function cellStr_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var hasTime = v.getHours() || v.getMinutes() || v.getSeconds();
    return Utilities.formatDate(v, APP.TZ, hasTime ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd');
  }
  return v;
}

function readTable_(name, cols) {
  var sh = ensureColumns_(sheet_(name), cols.length);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  return values.map(function (row, i) {
    var o = { _row: i + 2 };
    cols.forEach(function (c, j) { o[c] = cellStr_(row[j]); });
    return o;
  });
}

/**
 * เตรียมแถวว่างที่ตั้งรูปแบบเป็นข้อความ (@) ไว้ล่วงหน้าเสมอ
 * appendRow จะเขียนลงแถวเหล่านี้ ค่าที่ขึ้นต้นด้วย = + - @ จึงถูกเก็บเป็นข้อความ ไม่ถูกตีความเป็นสูตร
 * (กัน formula injection จากข้อมูลที่ผู้ใช้ภายนอกกรอก และกันโทเคน/แฮชที่ขึ้นต้นด้วย - หรือ + เพี้ยน)
 */
function ensureTextRows_(sh, width) {
  var max = sh.getMaxRows();
  // เหลือแถวว่างอย่างน้อย 1 แถวหลัง append เสมอ (deleteRowSafe_ อาศัยแถวนี้)
  if (sh.getLastRow() + 2 <= max) return;
  var add = 500;
  sh.insertRowsAfter(max, add);
  sh.getRange(max + 1, 1, add, width).setNumberFormat('@');
}

/** ลบแถว แต่ถ้าเป็นแถวสุดท้ายที่ไม่ถูกตรึง ให้ล้างค่าแทน (Sheets ไม่ยอมให้ลบแถวที่ไม่ถูกตรึงจนหมด) */
function deleteRowSafe_(sh, rowIndex) {
  if (sh.getMaxRows() - sh.getFrozenRows() <= 1) {
    sh.getRange(rowIndex, 1, 1, sh.getMaxColumns()).clearContent();
    return;
  }
  sh.deleteRow(rowIndex);
}

/** แก้เฉพาะบางช่องของแถว ไม่เขียนทับทั้งแถวด้วยข้อมูลที่อ่านไว้ก่อน (กันย้อนการแก้ไขของคนอื่น) */
function updateCells_(name, cols, rowIndex, patch) {
  var sh = sheet_(name);
  Object.keys(patch).forEach(function (k) {
    var c = cols.indexOf(k);
    if (c < 0) throw new Error('ไม่พบคอลัมน์ ' + k);
    var v = patch[k] === undefined || patch[k] === null ? '' : patch[k];
    sh.getRange(rowIndex, c + 1).setNumberFormat('@').setValue(v);
  });
}

function appendRow_(name, cols, obj) {
  var sh = ensureColumns_(sheet_(name), cols.length);
  ensureTextRows_(sh, cols.length);
  var row = cols.map(function (c) { return obj[c] === undefined || obj[c] === null ? '' : obj[c]; });
  sh.appendRow(row);
  return sh.getLastRow();
}

function updateRow_(name, cols, rowIndex, obj) {
  var sh = ensureColumns_(sheet_(name), cols.length);
  var row = cols.map(function (c) { return obj[c] === undefined || obj[c] === null ? '' : obj[c]; });
  sh.getRange(rowIndex, 1, 1, cols.length).setNumberFormat('@').setValues([row]);
}

/**
 * ทำงานภายใต้ script lock — งานที่อ่านแล้วเขียนกลับตามเลขแถว หรือลบแถว ต้องผ่านฟังก์ชันนี้
 * ไม่เช่นนั้นการลบแถวพร้อมกันจะทำให้เลขแถวเลื่อน แล้วเขียนทับข้อมูลของคนอื่น
 * เรียกซ้อนกันได้ (ถ้าถือ lock อยู่แล้วจะทำงานต่อทันที)
 */
function withScriptLock_(fn, waitMs) {
  if (withScriptLock_._held) return fn();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs || 20000)) throw new Error('ระบบกำลังทำงานอื่นอยู่ กรุณาลองใหม่อีกครั้ง');
  withScriptLock_._held = true;
  try {
    return fn();
  } finally {
    withScriptLock_._held = false;
    lock.releaseLock();
  }
}

/* =========================================================
 * การตั้งค่าชมรม
 * =======================================================*/
var DEFAULT_SETTINGS = {
  CLUB_NAME: 'ชมรมอนามัยสิ่งแวดล้อมจังหวัดบุรีรัมย์',
  CLUB_NAME_EN: 'BURIRAM ENVIRONMENTAL HEALTH CLUB',
  CLUB_ADDRESS: 'สำนักงานสาธารณสุขจังหวัดบุรีรัมย์ ถนนจิระ ตำบลในเมือง อำเภอเมืองบุรีรัมย์ จังหวัดบุรีรัมย์ 31000',
  CLUB_PHONE: '0 4461 1562',
  CLUB_EMAIL: 'ehclub.buriram@gmail.com',
  PRESIDENT_NAME: 'นายประธานชมรม  ตัวอย่าง',
  PRESIDENT_TITLE: 'ประธานชมรมอนามัยสิ่งแวดล้อมจังหวัดบุรีรัมย์',
  PRESIDENT_SIGN_ID: '',
  LOGO_ID: '',
  DPO_NAME: 'เลขานุการชมรมอนามัยสิ่งแวดล้อมจังหวัดบุรีรัมย์',
  DPO_EMAIL: 'privacy.ehclub.buriram@gmail.com',
  DPO_PHONE: '0 4461 1562',
  CARD_NOTE: 'บัตรนี้เป็นทรัพย์สินของชมรมฯ ผู้เก็บได้โปรดส่งคืนตามที่อยู่ด้านบน',
  OPEN_REGISTER: 'yes'
};

function getSettings_() {
  var out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { out[k] = DEFAULT_SETTINGS[k]; });
  try {
    var rows = sheet_(SHEETS.SETTINGS).getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      var k = String(rows[i][0] || '').trim();
      if (k) out[k] = rows[i][1] === '' || rows[i][1] === null ? out[k] : String(rows[i][1]);
    }
  } catch (e) { /* ยังไม่ติดตั้ง */ }
  return out;
}

/** ค่าที่เปิดเผยต่อหน้าเว็บสาธารณะได้ */
function getPublicSettings() {
  var s = getSettings_();
  return {
    CLUB_NAME: s.CLUB_NAME, CLUB_NAME_EN: s.CLUB_NAME_EN, CLUB_ADDRESS: s.CLUB_ADDRESS,
    CLUB_PHONE: s.CLUB_PHONE, CLUB_EMAIL: s.CLUB_EMAIL,
    DPO_NAME: s.DPO_NAME, DPO_EMAIL: s.DPO_EMAIL, DPO_PHONE: s.DPO_PHONE,
    OPEN_REGISTER: s.OPEN_REGISTER, CONSENT_VERSION: APP.CONSENT_VERSION,
    RETENTION_YEARS: APP.RETENTION_YEARS
  };
}

function apiGetSettings(token) {
  var sess = requireRole_(token, ['superadmin', 'admin']);
  return { ok: true, settings: getSettings_(), me: sess };
}

function apiSaveSettings(token, data) {
  var sess = requireRole_(token, ['superadmin']);
  var sh = sheet_(SHEETS.SETTINGS);
  var rows = sh.getDataRange().getValues();
  var map = {};
  for (var i = 1; i < rows.length; i++) map[String(rows[i][0])] = i + 1;
  var changed = [];
  Object.keys(data || {}).forEach(function (k) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k)) return;
    var v = String(data[k] === null || data[k] === undefined ? '' : data[k]).substring(0, 500);
    if (map[k]) {
      var old = String(sh.getRange(map[k], 2).getValue());
      if (old !== v) { sh.getRange(map[k], 2).setNumberFormat('@').setValue(v); changed.push(k); }
    } else {
      ensureTextRows_(sh, 3);
      sh.appendRow([k, v, '']); changed.push(k);
    }
  });
  writeLog_(sess, 'settings.update', 'settings', '-', 'แก้ไขการตั้งค่าระบบ ' + changed.length + ' รายการ',
    { fields: changed });
  return { ok: true, settings: getSettings_() };
}

/* =========================================================
 * ติดตั้งระบบ  — เรียกครั้งเดียวจากตัวแก้ไขสคริปต์
 * =======================================================*/
function setup() {
  requireEditor_();
  var props = PropertiesService.getScriptProperties();

  // 1) สเปรดชีตฐานข้อมูล
  var s = null;
  var id = props.getProperty('SS_ID');
  if (id) {
    s = SpreadsheetApp.openById(id);
  } else {
    s = SpreadsheetApp.getActiveSpreadsheet();
    if (!s) {
      s = SpreadsheetApp.create('ฐานข้อมูล-' + APP.NAME);
    }
    props.setProperty('SS_ID', s.getId());
  }
  s.setSpreadsheetTimeZone(APP.TZ);

  // 2) ตารางต่าง ๆ
  ensureSheet_(s, SHEETS.MEMBERS, M_COLS);
  ensureSheet_(s, SHEETS.ADMINS, ADMIN_COLS);
  ensureSheet_(s, SHEETS.LOG, LOG_COLS);
  ensureSheet_(s, SHEETS.SESSIONS, SESSION_COLS);
  ensureSheet_(s, SHEETS.CONSENT, CONSENT_COLS);

  var st = s.getSheetByName(SHEETS.SETTINGS);
  if (!st) {
    st = s.insertSheet(SHEETS.SETTINGS);
    st.getRange(1, 1, st.getMaxRows(), 3).setNumberFormat('@');   // เก็บเป็นข้อความ ไม่ตีความเป็นสูตร
    st.getRange(1, 1, 1, 3).setValues([['key', 'value', 'คำอธิบาย']]).setFontWeight('bold');
    var rows = Object.keys(DEFAULT_SETTINGS).map(function (k) { return [k, DEFAULT_SETTINGS[k], '']; });
    st.getRange(2, 1, rows.length, 3).setValues(rows);
    st.setFrozenRows(1);
    st.setColumnWidth(1, 190); st.setColumnWidth(2, 520);
  }
  var def = s.getSheetByName('Sheet1') || s.getSheetByName('ชีต1');
  if (def && s.getSheets().length > 1) s.deleteSheet(def);

  // 3) กุญแจเข้ารหัส (สร้างครั้งเดียว เก็บใน Script Properties)
  cryptoGetMasterKey_(true);

  // 4) โฟลเดอร์เก็บรูปถ่าย/ลายเซ็น (สิทธิ์เฉพาะเจ้าของ)
  ensureFolder_('MEDIA_FOLDER_ID', 'สื่อระบบสมาชิก-' + APP.SHORT);
  ensureFolder_('EXPORT_FOLDER_ID', 'ไฟล์ส่งออก-' + APP.SHORT);

  // 5) บัญชีผู้ดูแลสูงสุดเริ่มต้น
  var msg = '';
  // ไม่เก็บรหัสผ่านเริ่มต้นไว้ใน Script Properties (เวอร์ชันก่อนหน้าเคยเก็บไว้ ลบทิ้งถ้ายังค้างอยู่)
  props.deleteProperty('FIRST_LOGIN_HINT');
  if (readTable_(SHEETS.ADMINS, ADMIN_COLS).length === 0) {
    var tempPw = tempPassword_();
    createAdminRecord_('admin', 'ผู้ดูแลระบบสูงสุด', getSettings_().CLUB_EMAIL, 'superadmin', tempPw, true);
    msg ='\n\n>>> บัญชีผู้ดูแลเริ่มต้น\n    ชื่อผู้ใช้ : admin\n    รหัสผ่าน  : ' + tempPw +
      '\n    (ระบบจะบังคับเปลี่ยนรหัสผ่านเมื่อเข้าใช้ครั้งแรก)';
  }

  // 6) ทริกเกอร์งานประจำ (ปรับสถานะหมดอายุ + ล้างข้อมูลชั่วคราว)
  ensureTrigger_('dailyMaintenance', 3);

  var out = 'ติดตั้งเรียบร้อย\nฐานข้อมูล : ' + s.getUrl() + msg +
    '\n\nขั้นตอนถัดไป : Deploy > New deployment > Web app ' +
    '(Execute as: Me, Who has access: Anyone) แล้วนำ URL มาใส่ที่ Script Property ชื่อ WEBAPP_URL';
  Logger.log(out);
  // รหัสผ่านแสดงเฉพาะใน Execution log ไม่ส่งกลับเป็นค่าของฟังก์ชัน
  return 'ติดตั้งเรียบร้อย ดูรายละเอียดใน Execution log';
}

function ensureSheet_(s, name, cols) {
  var sh = s.getSheetByName(name);
  var created = false;
  if (!sh) { sh = s.insertSheet(name); created = true; }

  // ชีตใหม่มี 26 คอลัมน์ ตัดคอลัมน์ที่ไม่ใช้ทิ้ง เพราะเซลล์ว่างก็นับรวมในเพดาน 10 ล้านเซลล์ของสเปรดชีต
  if (created && sh.getMaxColumns() > cols.length) sh.deleteColumns(cols.length + 1, sh.getMaxColumns() - cols.length);
  ensureColumns_(sh, cols.length);   // ต้องทำก่อนแตะแถวหัวตารางเสมอ

  var head = sh.getRange(1, 1, 1, cols.length).getValues()[0];
  var broken = head.join('') === '' || head[0] !== cols[0] || head[cols.length - 1] !== cols[cols.length - 1];
  if (broken) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold').setBackground('#e8f0ec');
    sh.setFrozenRows(1);
    sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), cols.length).setNumberFormat('@'); // เก็บทุกค่าเป็นข้อความ
  }
  if (created) {
    try {
      sh.protect().setDescription('ข้อมูลระบบสมาชิก — ห้ามแก้ไขด้วยมือ').setWarningOnly(true);
    } catch (e) { /* บางบัญชีไม่มีสิทธิ์ตั้งการป้องกัน ข้ามไปได้ */ }
  }
  return sh;
}

/**
 * ตรวจสุขภาพระบบ — เรียกจากตัวแก้ไขสคริปต์เมื่อพบว่าหน้าเว็บแจ้งข้อผิดพลาด
 * รายงานว่าตารางไหนผิดปกติ และซ่อมโครงสร้างให้อัตโนมัติโดยไม่แตะข้อมูลเดิม
 */
function diagnose() {
  requireEditor_();
  var props = PropertiesService.getScriptProperties();
  var out = ['ผลตรวจระบบ ' + now_(), ''];
  var problems = 0;

  try { var s = ss_(); out.push('ฐานข้อมูล : ' + s.getUrl()); }
  catch (e) { return 'ไม่พบฐานข้อมูล กรุณาเรียก setup() ก่อน (' + e.message + ')'; }

  var tables = [
    [SHEETS.MEMBERS, M_COLS], [SHEETS.ADMINS, ADMIN_COLS], [SHEETS.LOG, LOG_COLS],
    [SHEETS.SESSIONS, SESSION_COLS], [SHEETS.CONSENT, CONSENT_COLS]
  ];
  tables.forEach(function (t) {
    var name = t[0], cols = t[1];
    var sh = ss_().getSheetByName(name);
    if (!sh) { out.push('✗ ไม่พบตาราง ' + name + ' — กำลังสร้างให้'); problems++; ensureSheet_(ss_(), name, cols); return; }
    var before = sh.getMaxColumns();
    var head = (before >= cols.length) ? sh.getRange(1, 1, 1, cols.length).getValues()[0] : [];
    var headOk = head.length && head[0] === cols[0] && head[cols.length - 1] === cols[cols.length - 1];
    if (before < cols.length || !headOk) {
      problems++;
      out.push('✗ ' + name + ' : ต้องการ ' + cols.length + ' คอลัมน์ แต่มี ' + before +
        (headOk ? '' : ' และหัวตารางไม่ถูกต้อง') + ' — กำลังซ่อม');
      ensureSheet_(ss_(), name, cols);
      out.push('  ซ่อมแล้ว : ตอนนี้มี ' + ss_().getSheetByName(name).getMaxColumns() + ' คอลัมน์');
    } else {
      out.push('✓ ' + name + ' : ' + cols.length + ' คอลัมน์ ข้อมูล ' + Math.max(sh.getLastRow() - 1, 0) + ' แถว');
    }
  });

  if (!ss_().getSheetByName(SHEETS.SETTINGS)) { out.push('✗ ไม่พบตาราง Settings'); problems++; }
  else out.push('✓ Settings');

  out.push('');
  out.push(props.getProperty('MASTER_KEY_B64') ? '✓ กุญแจเข้ารหัสพร้อมใช้งาน' : '✗ ยังไม่มีกุญแจเข้ารหัส');
  out.push(props.getProperty('WEBAPP_URL') ? '✓ ตั้งค่า WEBAPP_URL แล้ว'
    : '✗ ยังไม่ได้ตั้ง Script Property ชื่อ WEBAPP_URL — คิวอาร์โค้ดหลังบัตรจะใช้ไม่ได้');
  out.push(props.getProperty('MEDIA_FOLDER_ID') ? '✓ โฟลเดอร์เก็บรูปพร้อมใช้งาน' : '✗ ยังไม่มีโฟลเดอร์เก็บรูป');

  var admins = readTable_(SHEETS.ADMINS, ADMIN_COLS);
  out.push(admins.length ? '✓ บัญชีผู้ดูแล ' + admins.length + ' บัญชี' : '✗ ยังไม่มีบัญชีผู้ดูแล — เรียก setup()');

  try {
    var probe = 'ทดสอบเข้ารหัส';
    out.push(decryptField_(encryptField_(probe)) === probe ? '✓ ระบบเข้ารหัสทำงานปกติ' : '✗ ระบบเข้ารหัสผิดพลาด');
  } catch (e) { out.push('✗ ระบบเข้ารหัสผิดพลาด : ' + e.message); problems++; }

  try {
    var n = loadMembers_(false).length;
    out.push('✓ อ่านและถอดรหัสทะเบียนสมาชิกได้ ' + n + ' ราย');
  } catch (e) { out.push('✗ อ่านทะเบียนสมาชิกไม่ได้ : ' + e.message); problems++; }

  out.push('');
  out.push(problems ? 'พบปัญหา ' + problems + ' จุด และได้ซ่อมโครงสร้างให้แล้ว กรุณารีเฟรชหน้าเว็บอีกครั้ง'
                    : 'ระบบปกติทุกจุด');
  var text = out.join('\n');
  Logger.log(text);
  return text;
}

function ensureFolder_(propKey, name) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(propKey);
  if (id) {
    try { DriveApp.getFolderById(id); return id; } catch (e) { /* หายไป สร้างใหม่ */ }
  }
  var f = DriveApp.createFolder(name);
  f.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  props.setProperty(propKey, f.getId());
  return f.getId();
}

function ensureTrigger_(fn, hour) {
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === fn; });
  if (!exists) ScriptApp.newTrigger(fn).timeBased().atHour(hour).everyDays(1).create();
}

/** งานประจำวัน : ปรับสถานะบัตรหมดอายุ, ล้างเซสชันหมดอายุ, ล้างไฟล์ส่งออกเก่า */
function dailyMaintenance(e) {
  // รันได้จาก trigger รายวันของระบบ หรือจากตัวแก้ไขสคริปต์เท่านั้น
  if (!isOwnTrigger_(e)) requireEditor_();
  var today = fmtDate_(new Date());
  var sh = sheet_(SHEETS.MEMBERS);
  var idxStatus = M_COLS.indexOf('status') + 1;
  var n = withScriptLock_(function () {
    var count = 0;
    readTable_(SHEETS.MEMBERS, M_COLS).forEach(function (r) {
      if (r.status === 'active' && r.expire_date && String(r.expire_date) < today) {
        sh.getRange(r._row, idxStatus).setValue('expired');
        count++;
      }
    });
    return count;
  }, 60000);
  cleanupSessions_();
  cleanupExports_();
  if (n) writeLog_({ username: 'ระบบ', role: 'system' }, 'member.autoexpire', 'member', '-',
    'ปรับสถานะบัตรหมดอายุอัตโนมัติ ' + n + ' ราย', { count: n });
}

function cleanupExports_() {
  var id = PropertiesService.getScriptProperties().getProperty('EXPORT_FOLDER_ID');
  if (!id) return;
  var cutoff = new Date().getTime() - 24 * 3600 * 1000;
  try {
    var it = DriveApp.getFolderById(id).getFiles();
    while (it.hasNext()) {
      var f = it.next();
      if (f.getDateCreated().getTime() < cutoff) f.setTrashed(true);
    }
  } catch (e) { }
}

/* =========================================================
 * ตัวช่วยทั่วไป
 * =======================================================*/
function fmtDate_(d) { return Utilities.formatDate(d, APP.TZ, 'yyyy-MM-dd'); }
function fmtDateTime_(d) { return Utilities.formatDate(d, APP.TZ, 'yyyy-MM-dd HH:mm:ss'); }
function now_() { return fmtDateTime_(new Date()); }

function addYears_(dateStr, years) {
  var p = String(dateStr).split('-');
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  d.setFullYear(d.getFullYear() + years);
  d.setDate(d.getDate() - 1);
  return fmtDate_(d);
}

function escapeHtml_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function uuid_() { return Utilities.getUuid(); }

/** วันที่รูปแบบ yyyy-MM-dd (ค.ศ.) ที่มีอยู่จริง */
function isDateStr_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

/** รหัสผ่านชั่วคราวจากตัวสุ่มของระบบเข้ารหัส (ไม่ใช้ Math.random) มีทั้งตัวอักษรและตัวเลข */
function tempPassword_() {
  return 'Br' + randomToken_(12) + '7';
}

/** ตรวจเลขประจำตัวประชาชน 13 หลักตามสูตรตรวจสอบ */
function isValidThaiID_(id) {
  id = String(id || '').replace(/\D/g, '');
  if (id.length !== 13) return false;
  var sum = 0;
  for (var i = 0; i < 12; i++) sum += Number(id.charAt(i)) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(id.charAt(12));
}
