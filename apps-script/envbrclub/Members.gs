/*************************************************************
 * Members.gs : ข้อมูลสมาชิก
 *  - รับสมัครผ่านหน้าเว็บสาธารณะ (สถานะ "รอตรวจสอบ") ได้เลขที่ใบสมัคร APP-ปีพ.ศ.-ลำดับ
 *  - เลขสมาชิก MEM-ปีพ.ศ.-ลำดับ ออกเมื่ออนุมัติ (แบบเดียวกับระบบ envbrclub-supabase)
 *  - เพิ่ม / แก้ไข (ต้องระบุเหตุผล) / ต่ออายุ / ออกบัตรใหม่ / ลบ โดยผู้ดูแล
 *  - รูปถ่ายและลายเซ็นเก็บใน Google Drive โฟลเดอร์ส่วนตัวของระบบ
 *  - บัตรสมาชิก + QR ตรวจสอบสถานะ
 *************************************************************/

var MEMBER_TYPES = ['สามัญ', 'วิสามัญ', 'สมทบ', 'กิตติมศักดิ์'];
/* ประเภทหน่วยงาน : ชุดเดียวกับตาราง org_types ของระบบ envbrclub-supabase */
var WORK_TYPES = ['สำนักงานสาธารณสุขจังหวัด', 'สำนักงานสาธารณสุขอำเภอ', 'โรงพยาบาล',
  'โรงพยาบาลส่งเสริมสุขภาพตำบล', 'สถานีอนามัยเฉลิมพระเกียรติ 60 พรรษา นวมินทราชินี',
  'องค์กรปกครองส่วนท้องถิ่น', 'สถานศึกษา', 'ภาคเอกชน', 'อื่นๆ'];
/* ค่าเดิมที่เคยบันทึกไว้ แปลงเป็นค่าปัจจุบันเมื่ออ่านและเมื่อบันทึก */
var LEGACY_WORK_TYPES = { 'อื่น ๆ': 'อื่นๆ' };
/* คำนำหน้า : ชุดเดียวกับหน้าใบสมัครของระบบ envbrclub-supabase เลือก "อื่นๆ" แล้วพิมพ์เองได้ (ไม่เกิน 40 ตัวอักษร) */
var PREFIXES = ['นาย', 'นาง', 'นางสาว', 'ว่าที่ ร.ต.', 'ดร.', 'นพ.', 'พญ.', 'ทพ.', 'ภก.', 'ภญ.'];
var GENDERS = ['ชาย', 'หญิง', 'ไม่ระบุ'];

/** ตัวเลือกในฟอร์มของหน้าเว็บ (หน้าสมัครและหน้าผู้ดูแล) */
function formLists_() {
  return { member_types: MEMBER_TYPES, work_types: WORK_TYPES, prefixes: PREFIXES, genders: GENDERS };
}

/* ความยาวสูงสุดของแต่ละช่อง ตรงกับ maxlength ในฟอร์ม (ชื่อและหน่วยงานจำกัดตามพื้นที่บนบัตร) */
var FIELD_MAX = {
  prefix: 40, first_name: 60, last_name: 60, position: 80, organization: 120, work_address: 300,
  phone: 15, email: 80, line_id: 40, education: 80, license_no: 40, note: 300
};

/* =========================================================
 * แปลงข้อมูลเข้า/ออกจากตาราง
 * =======================================================*/
function encodeMember_(m) {
  var row = {};
  M_COLS.forEach(function (c) { row[c] = m[c] === undefined || m[c] === null ? '' : m[c]; });
  M_ENCRYPTED.forEach(function (f) { row[f] = encryptField_(m[f]); });
  row.nid_idx = blindIndex_('nid', m.national_id);
  row.phone_idx = blindIndex_('phone', m.phone);
  row.email_idx = blindIndex_('email', m.email);
  row.name_idx = blindIndex_('name', String(m.first_name || '') + ' ' + String(m.last_name || ''));
  return row;
}

function decodeMember_(row) {
  var m = { _row: row._row };
  M_COLS.forEach(function (c) { m[c] = row[c]; });
  M_ENCRYPTED.forEach(function (f) { m[f] = decryptField_(row[f]); });
  m.work_type = normalizeWorkType_(m.work_type);
  return m;
}

function normalizeWorkType_(v) {
  return Object.prototype.hasOwnProperty.call(LEGACY_WORK_TYPES, v) ? LEGACY_WORK_TYPES[v] : v;
}

/** เลขที่ใช้อ้างอิงสมาชิกรายนี้ : เลขสมาชิกถ้าอนุมัติแล้ว ไม่เช่นนั้นเลขที่ใบสมัคร */
function memberRef_(m) {
  return m.member_code || m.app_no || '-';
}

function loadMembers_(includeDeleted) {
  return readTable_(SHEETS.MEMBERS, M_COLS)
    .filter(function (r) { return includeDeleted || r.status !== 'deleted'; })
    .map(decodeMember_);
}

function findMemberById_(id, includeDeleted) {
  var rows = readTable_(SHEETS.MEMBERS, M_COLS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(id)) {
      if (!includeDeleted && rows[i].status === 'deleted') return null;
      return decodeMember_(rows[i]);
    }
  }
  return null;
}

/* =========================================================
 * เลขเอกสาร  รูปแบบ <คำนำ>-<ปี พ.ศ. 4 หลัก>-<ลำดับ 4 หลัก> แบบเดียวกับ gen_code ของระบบ envbrclub-supabase
 *   APP-2569-0001 เลขที่ใบสมัคร ออกเมื่อรับใบสมัคร
 *   MEM-2569-0001 เลขสมาชิก ออกเมื่ออนุมัติ (ผู้สมัครที่ไม่ผ่านจึงไม่ทำให้เลขสมาชิกขาดช่วง)
 * เลขสมาชิกรูปแบบเดิม BR-69-0001 ที่ออกไปแล้วยังใช้ได้ตามเดิม
 * =======================================================*/
/**
 * ลำดับเดินหน้าเสมอ : จำเลขล่าสุดไว้ใน Script Properties และเทียบกับเลขสูงสุดที่มีในตาราง
 * เลขที่ออกไปแล้วจึงไม่ถูกนำกลับมาใช้ซ้ำ แม้แถวนั้นจะถูกลบภายหลัง
 * ต้องเรียกภายใต้ withScriptLock_ เท่านั้น
 */
function nextCode_(prefix, field, rows) {
  var year = String(beYear_());
  var re = new RegExp('^' + prefix + '-' + year + '-(\\d{4,})$');
  rows = rows || readTable_(SHEETS.MEMBERS, M_COLS);
  var max = 0;
  rows.forEach(function (r) {
    var m = re.exec(String(r[field] || ''));
    if (m) max = Math.max(max, Number(m[1]));
  });
  var props = PropertiesService.getScriptProperties();
  var key = 'SEQ_' + prefix + '_' + year;
  max = Math.max(max, Number(props.getProperty(key) || 0));
  var n = max + 1;
  props.setProperty(key, String(n));
  var digits = String(n);
  return prefix + '-' + year + '-' + (digits.length >= 4 ? digits : ('0000' + digits).slice(-4));
}

/** ออกเลขสมาชิกให้ถ้ายังไม่มี (เรียกเมื่อสถานะไม่ใช่ "รอตรวจสอบ") คืน true ถ้าออกเลขใหม่ */
function ensureMemberCode_(m) {
  if (m.member_code || m.status === 'pending') return false;
  m.member_code = nextCode_('MEM', 'member_code');
  return true;
}

/* =========================================================
 * ตรวจสอบข้อมูลนำเข้า
 * =======================================================*/
function cleanInput_(d) {
  var out = {};
  ['prefix', 'first_name', 'last_name', 'national_id', 'birthdate', 'gender', 'position',
    'organization', 'work_type', 'work_address', 'phone', 'email', 'line_id', 'member_type',
    'education', 'license_no', 'note', 'status', 'issue_date', 'expire_date'
  ].forEach(function (k) {
    if (d[k] !== undefined && d[k] !== null) out[k] = String(d[k]).trim().substring(0, 500);
  });
  if (out.national_id) out.national_id = out.national_id.replace(/\D/g, '');
  if (out.phone) out.phone = out.phone.replace(/[^\d+]/g, '');
  if (out.email) out.email = out.email.toLowerCase();
  if (out.work_type) out.work_type = normalizeWorkType_(out.work_type);
  return out;
}

/**
 * isPublic : มาจากหน้าสมัครสาธารณะ — ห้ามบอกข้อมูลของสมาชิกที่มีอยู่แล้ว
 * rows : ตารางสมาชิกที่อ่านไว้แล้ว (ไม่ส่งมาจะอ่านใหม่)
 */
function validateMember_(d, existingId, isPublic, rows) {
  var e = [];
  if (!d.prefix) e.push('กรุณาเลือกคำนำหน้า');
  if (!d.first_name) e.push('กรุณากรอกชื่อ');
  if (!d.last_name) e.push('กรุณากรอกนามสกุล');
  // ตรวจความยาวที่เซิร์ฟเวอร์ด้วย maxlength ในฟอร์มกันได้แค่ผู้ที่ใช้หน้าเว็บตามปกติ
  var FIELD_TH = { prefix: 'คำนำหน้า', first_name: 'ชื่อ', last_name: 'นามสกุล', position: 'ตำแหน่ง',
    organization: 'ชื่อหน่วยงาน', work_address: 'ที่อยู่หน่วยงาน', phone: 'โทรศัพท์', email: 'อีเมล',
    line_id: 'ไลน์ไอดี', education: 'วุฒิการศึกษา', license_no: 'เลขใบอนุญาต', note: 'หมายเหตุ' };
  Object.keys(FIELD_MAX).forEach(function (f) {
    if (String(d[f] || '').length > FIELD_MAX[f]) e.push(FIELD_TH[f] + 'ยาวเกิน ' + FIELD_MAX[f] + ' ตัวอักษร');
  });
  if (d.gender && GENDERS.indexOf(d.gender) < 0) e.push('เพศไม่ถูกต้อง');
  if (!d.national_id) e.push('กรุณากรอกเลขประจำตัวประชาชน');
  else if (!isValidThaiID_(d.national_id)) e.push('เลขประจำตัวประชาชนไม่ถูกต้อง');
  if (!d.phone || d.phone.replace(/\D/g, '').length < 9) e.push('เบอร์โทรศัพท์ไม่ถูกต้อง');
  if (d.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) e.push('รูปแบบอีเมลไม่ถูกต้อง');
  if (!d.position) e.push('กรุณากรอกตำแหน่ง');
  if (!d.organization) e.push('กรุณากรอกหน่วยงาน');
  if (d.member_type && MEMBER_TYPES.indexOf(d.member_type) < 0) e.push('ประเภทสมาชิกไม่ถูกต้อง');
  if (d.birthdate && !isDateStr_(d.birthdate)) e.push('รูปแบบวันเกิดไม่ถูกต้อง');
  if (d.issue_date && !isDateStr_(d.issue_date)) e.push('รูปแบบวันออกบัตรไม่ถูกต้อง');
  if (d.expire_date && !isDateStr_(d.expire_date)) e.push('รูปแบบวันหมดอายุบัตรไม่ถูกต้อง');
  if (d.status && (!Object.prototype.hasOwnProperty.call(STATUS_LABELS, d.status) || d.status === 'deleted')) {
    e.push('สถานะสมาชิกไม่ถูกต้อง');
  }
  if (d.work_type && WORK_TYPES.indexOf(d.work_type) < 0) e.push('ประเภทหน่วยงานไม่ถูกต้อง');

  // กันเลขบัตรประชาชนซ้ำ โดยไม่ต้องถอดรหัสทั้งตาราง
  var dup = d.national_id ? nidTaken_(d.national_id, existingId, rows) : null;
  if (dup) e.push(dupNidMessage_(dup, isPublic));
  return e;
}

/** แถวสมาชิก (ที่ยังไม่ถูกลบ) ที่ใช้เลขบัตรประชาชนนี้อยู่แล้ว หรือ null */
function nidTaken_(nid, existingId, rows) {
  var idx = blindIndex_('nid', nid);
  rows = rows || readTable_(SHEETS.MEMBERS, M_COLS);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].nid_idx === idx && rows[i].status !== 'deleted' &&
      String(rows[i].id) !== String(existingId || '')) return rows[i];
  }
  return null;
}

/** เพดานจากข้อมูลจริงในตาราง : ใบสมัครรอตรวจสอบค้าง และใบสมัครผ่านเว็บของวันนี้ (เวลาไทย) */
function registerLimitReason_(rows) {
  var today = fmtDate_(new Date());
  var pending = 0, todayCount = 0;
  rows.forEach(function (r) {
    if (r.status === 'pending') pending++;
    if (r.created_by === 'สมัครผ่านเว็บ' && String(r.created_at).substring(0, 10) === today) todayCount++;
  });
  if (pending >= APP.MAX_PENDING) return 'ขณะนี้มีใบสมัครรอตรวจสอบจำนวนมาก กรุณาติดต่อชมรม';
  if (todayCount >= APP.REGISTER_PER_DAY) return 'วันนี้รับสมัครครบจำนวนแล้ว กรุณาสมัครใหม่พรุ่งนี้ หรือติดต่อชมรม';
  return '';
}

/** แจ้งในประวัติ 1 ครั้งต่อ 10 นาทีเมื่อการรับสมัครถูกจำกัด ผู้ดูแลจะได้รู้ว่ามีการปิดรับอยู่ */
function noteRegisterLimited_(reason) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'REGLIMIT:' + Math.floor(new Date().getTime() / 600000);
    if (cache.get(key)) return;
    cache.put(key, '1', 900);
    writeLog_({ username: 'ระบบ', role: 'system' }, 'security.register_limited', 'system', '-',
      'ปฏิเสธใบสมัครจากหน้าเว็บเพราะถึงเพดาน : ' + reason, { reason: reason });
  } catch (e) { }
}

/** หน้าสาธารณะไม่บอกเลขสมาชิก เพราะใครก็ใช้เลขบัตรประชาชนของคนอื่นสอบถามได้ */
function dupNidMessage_(row, isPublic) {
  return isPublic ? 'เลขประจำตัวประชาชนนี้สมัครไว้แล้ว หากต้องการแก้ไขข้อมูลกรุณาติดต่อชมรม'
    : 'เลขประจำตัวประชาชนนี้มีในระบบแล้ว (' + (row.member_code ? 'เลขสมาชิก ' + row.member_code
      : 'เลขที่ใบสมัคร ' + (row.app_no || '-')) + ')';
}

/* =========================================================
 * ไฟล์รูปถ่าย / ลายเซ็น
 * =======================================================*/
function saveMedia_(dataUrl, prefix, memberCode, maxBytes) {
  if (!dataUrl) return '';
  maxBytes = maxBytes || APP.MAX_IMAGE_BYTES;
  var m = String(dataUrl).match(/^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/);
  if (!m) throw new Error('ไฟล์รูปต้องเป็น PNG, JPG หรือ WEBP เท่านั้น');
  if (m[3].length > Math.ceil(maxBytes * 4 / 3) + 4) throw new Error('ไฟล์รูปใหญ่เกิน ' + Math.round(maxBytes / 1000) + ' KB');
  var bytes = Utilities.base64Decode(m[3]);
  if (bytes.length > maxBytes) throw new Error('ไฟล์รูปใหญ่เกิน ' + Math.round(maxBytes / 1000) + ' KB');
  var folderId = PropertiesService.getScriptProperties().getProperty('MEDIA_FOLDER_ID');
  var folder = DriveApp.getFolderById(folderId);
  var ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  var blob = Utilities.newBlob(bytes, m[1], prefix + '_' + memberCode + '_' + new Date().getTime() + '.' + ext);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  return file.getId();
}

/** ลบรูปถ่าย/ลายเซ็นถาวร (ไม่ค้างในถังขยะของเจ้าของ 30 วัน) */
function deleteMedia_(fileId) {
  if (!fileId) return;
  deleteFilePermanently_(fileId);
}

function mediaDataUrl_(fileId) {
  if (!fileId) return '';
  try {
    var f = DriveApp.getFileById(fileId);
    // ส่งออกเฉพาะไฟล์รูปภาพ (ไม่รวม SVG) กันการใส่รหัสไฟล์อื่นใน Drive ของเจ้าของระบบ (เช่นช่องตราชมรม) เพื่อดึงเนื้อหาออกไป
    var type = String(f.getMimeType() || '').toLowerCase();
    if (!/^image\/(png|jpeg|jpg|webp|gif)$/.test(type)) return '';
    var bytes = f.getBlob().getBytes();
    if (bytes.length > 5 * 1024 * 1024) return '';
    return 'data:' + type + ';base64,' + Utilities.base64Encode(bytes);
  } catch (e) { return ''; }
}

/* =========================================================
 * สมัครสมาชิกผ่านหน้าเว็บ (สาธารณะ)
 * =======================================================*/
function apiRegister(payload, client) {
  var s = getSettings_();
  if (s.OPEN_REGISTER !== 'yes') return { ok: false, error: 'ขณะนี้ปิดรับสมัครสมาชิกชั่วคราว' };

  var d = cleanInput_(payload || {});
  // ผู้สมัครกำหนดสถานะ วันออกบัตร และหมายเหตุของผู้ดูแลเองไม่ได้
  delete d.status; delete d.issue_date; delete d.expire_date; delete d.note;
  if (!payload || payload.consent !== true) {
    return { ok: false, error: 'กรุณายอมรับข้อตกลงการเก็บและใช้ข้อมูลส่วนบุคคลก่อนส่งใบสมัคร' };
  }
  var rows0 = readTable_(SHEETS.MEMBERS, M_COLS);
  var errs = validateMember_(d, null, true, rows0);
  if (errs.length) return { ok: false, error: errs.join('\n') };

  // จำกัดจำนวนใบสมัครจากหน้าสาธารณะ ก่อนอัปโหลดรูปลง Drive ของเจ้าของระบบ
  // (Apps Script ไม่รู้ IP ผู้ส่ง จึงเป็นเพดานรวม : กัน Drive/สเปรดชีตเต็ม แลกกับการที่ผู้ยิงสแปมทำให้ปิดรับชั่วคราวได้)
  var limited = registerLimitReason_(rows0) || (!rateAllow_('register10m', APP.REGISTER_PER_10MIN, 600)
    ? 'มีผู้สมัครจำนวนมากในขณะนี้ กรุณาลองใหม่ในอีกสักครู่' : '');
  if (limited) { noteRegisterLimited_(limited); return { ok: false, error: limited }; }

  // งานที่ช้า (บันทึกรูปลง Drive, เข้ารหัส) ทำก่อนเข้า lock ให้ถือ lock สั้นที่สุด
  // ผู้สมัครหลายคนส่งพร้อมกัน (เช่นสแกน QR ในที่ประชุม) จะได้ไม่ล้มเพราะรอ lock นาน
  var tag = uuid_().substring(0, 8);
  var photoId = '', signId = '';
  try {
    photoId = saveMedia_(payload.photo_data, 'photo', tag, APP.MAX_PUBLIC_IMAGE_BYTES);
    signId = saveMedia_(payload.signature_data, 'sign', tag, APP.MAX_PUBLIC_IMAGE_BYTES);
  } catch (err) {
    deleteMedia_(photoId); deleteMedia_(signId);
    return { ok: false, error: err.message };
  }

  var m = Object.assign({}, d, {
    id: uuid_(),
    member_code: '',
    status: 'pending',
    member_type: d.member_type || 'สามัญ',
    photo_id: photoId,
    signature_id: signId,
    issue_date: '',
    expire_date: '',
    consent_version: APP.CONSENT_VERSION,
    consent_at: now_(),
    consent_marketing: payload.consent_marketing ? 'yes' : 'no',
    verify_token: randomToken_(18),
    created_at: now_(), created_by: 'สมัครผ่านเว็บ',
    updated_at: now_(), updated_by: 'สมัครผ่านเว็บ'
  });
  var res;
  try {
    res = withScriptLock_(function () {
      // อ่านกุญแจใหม่ภายใน lock : ถ้าเพิ่งหมุนกุญแจเสร็จระหว่างรอ lock ต้องเข้ารหัสและทำดัชนีด้วยกุญแจใหม่
      cryptoResetCache_();
      var rows = readTable_(SHEETS.MEMBERS, M_COLS);
      var why = registerLimitReason_(rows);
      if (why) { noteRegisterLimited_(why); return { ok: false, error: why }; }
      // ตรวจเลขบัตรซ้ำอีกครั้งภายใน lock กันสองคำขอที่ส่งเลขเดียวกันพร้อมกัน แล้วจึงออกเลขที่ใบสมัคร
      // (เลขสมาชิกออกเมื่อผู้ดูแลอนุมัติ แบบเดียวกับระบบ envbrclub-supabase)
      var dup = nidTaken_(d.national_id, null, rows);
      if (dup) return { ok: false, error: dupNidMessage_(dup, true) };
      m.app_no = nextCode_('APP', 'app_no', rows);
      appendRow_(SHEETS.MEMBERS, M_COLS, encodeMember_(m));
      return { ok: true, app_no: m.app_no, message: 'ส่งใบสมัครเรียบร้อย' };
    }, 30000);
  } catch (err) {
    deleteMedia_(photoId); deleteMedia_(signId);
    throw err;
  }
  if (!res.ok) { deleteMedia_(photoId); deleteMedia_(signId); return res; }

  var code = res.app_no;
  appendRow_(SHEETS.CONSENT, CONSENT_COLS, {
    // ช่อง member_code ของบันทึกความยินยอมเก็บเลขอ้างอิงที่ผู้สมัครถืออยู่ขณะยินยอม (เลขที่ใบสมัคร)
    ts: now_(), member_id: m.id, member_code: code, consent_version: APP.CONSENT_VERSION,
    purposes: 'การเป็นสมาชิก, การออกบัตร, การติดต่อ' + (m.consent_marketing === 'yes' ? ', ข่าวสาร/กิจกรรม' : ''),
    channel: 'เว็บไซต์รับสมัคร', client: String(client || '').substring(0, 250)
  });
  if (allowPublicLog_('register')) {
    writeLog_({ username: 'ผู้สมัคร', role: 'public' }, 'member.register', 'member', code,
      'มีผู้สมัครสมาชิกใหม่ เลขที่ใบสมัคร ' + code + ' หน่วยงาน ' + (d.organization || '-'),
      { app_no: code, organization: d.organization, position: d.position }, client);
  }
  return res;
}

/* =========================================================
 * รายชื่อสมาชิก (ผู้ดูแล)
 * =======================================================*/
function apiListMembers(token, opt) {
  var s = requireAuth_(token);
  opt = opt || {};
  var page = Math.max(1, Number(opt.page) || 1);
  var size = Math.min(200, Number(opt.pageSize) || APP.PAGE_SIZE);
  var all = loadMembers_(opt.includeDeleted && s.role === 'superadmin');

  var q = String(opt.q || '').trim().toLowerCase();
  // ค้นได้เฉพาะฟิลด์ที่บทบาทนั้นเห็นค่าเต็ม ไม่เช่นนั้นจะใช้การค้นหาเดาค่าที่ถูกปกปิดทีละหลักได้
  var sensitive = canSeeSensitive_(s.role);
  var filtered = all.filter(function (m) {
    if (opt.status && m.status !== opt.status) return false;
    if (opt.member_type && m.member_type !== opt.member_type) return false;
    if (opt.work_type && m.work_type !== opt.work_type) return false;
    if (q) {
      var parts = [m.member_code, m.app_no, m.prefix + m.first_name + ' ' + m.last_name, m.position, m.organization];
      if (sensitive) parts.push(m.phone, m.email);
      if (s.role === 'superadmin') parts.push(m.national_id);
      if (parts.join(' ').toLowerCase().indexOf(q) < 0) return false;
    }
    return true;
  });

  var SORTABLE = ['created_at', 'updated_at', 'member_code', 'status', 'member_type', 'organization', 'expire_date'];
  filtered.sort(function (a, b) {
    var f = SORTABLE.indexOf(opt.sort) >= 0 ? opt.sort : 'created_at';
    var x = String(a[f] || ''), y = String(b[f] || '');
    return opt.desc === false ? (x < y ? -1 : x > y ? 1 : 0) : (x > y ? -1 : x < y ? 1 : 0);
  });

  var total = filtered.length;
  var items = filtered.slice((page - 1) * size, page * size).map(function (m) {
    return {
      id: m.id, member_code: m.member_code, app_no: m.app_no, status: m.status,
      status_label: STATUS_LABELS[m.status] || m.status,
      full_name: (m.prefix || '') + m.first_name + ' ' + m.last_name,
      position: m.position, organization: m.organization, work_type: m.work_type,
      member_type: m.member_type,
      phone: canSeeSensitive_(s.role) ? m.phone : maskValue_('phone', m.phone),
      email: canSeeSensitive_(s.role) ? m.email : maskValue_('email', m.email),
      national_id: s.role === 'superadmin' ? m.national_id : maskValue_('national_id', m.national_id),
      issue_date: m.issue_date, expire_date: m.expire_date,
      has_photo: !!m.photo_id, has_sign: !!m.signature_id,
      updated_at: m.updated_at, updated_by: m.updated_by
    };
  });

  return { ok: true, total: total, page: page, pageSize: size, items: items, role: s.role };
}

function apiStats(token) {
  requireAuth_(token);
  // ใช้เฉพาะฟิลด์ที่ไม่เข้ารหัส จึงอ่านตารางตรง ๆ ไม่ต้องถอดรหัสทุกคน
  var all = readTable_(SHEETS.MEMBERS, M_COLS).filter(function (r) { return r.status !== 'deleted'; });
  var byStatus = {}, byType = {}, byWork = {};
  all.forEach(function (m) {
    byStatus[m.status] = (byStatus[m.status] || 0) + 1;
    byType[m.member_type || 'ไม่ระบุ'] = (byType[m.member_type || 'ไม่ระบุ'] || 0) + 1;
    var w = normalizeWorkType_(m.work_type) || 'ไม่ระบุ';
    byWork[w] = (byWork[w] || 0) + 1;
  });
  var soon = fmtDate_(new Date(new Date().getTime() + 60 * 86400000));
  var expiring = all.filter(function (m) {
    return m.status === 'active' && m.expire_date && m.expire_date <= soon;
  }).length;
  return {
    ok: true, total: all.length, byStatus: byStatus, byType: byType, byWork: byWork,
    expiringSoon: expiring, statusLabels: STATUS_LABELS
  };
}

/* =========================================================
 * ดูรายละเอียดสมาชิก
 * =======================================================*/
function apiGetMember(token, id) {
  var s = requireAuth_(token);
  var m = findMemberById_(id, s.role === 'superadmin');
  if (!m) return { ok: false, error: 'ไม่พบข้อมูลสมาชิก' };

  if (canSeeSensitive_(s.role)) {
    writeLog_(s, 'member.view_sensitive', 'member', memberRef_(m),
      'เปิดดูข้อมูลส่วนบุคคลของสมาชิก ' + memberRef_(m), { id: m.id });
  }

  var out = {};
  // ดัชนีค้นหาและรหัสตรวจสอบบัตรไม่ต้องส่งไปหน้าเว็บ
  var hidden = ['name_idx', 'nid_idx', 'phone_idx', 'email_idx', 'verify_token'];
  M_COLS.forEach(function (c) { if (hidden.indexOf(c) < 0) out[c] = m[c]; });
  if (!canSeeSensitive_(s.role)) {
    out.national_id = maskValue_('national_id', m.national_id);
    out.birthdate = ''; out.work_address = ''; out.line_id = ''; out.note = '';
    out.phone = maskValue_('phone', m.phone);
    out.email = maskValue_('email', m.email);
  } else if (s.role !== 'superadmin') {
    out.national_id = maskValue_('national_id', m.national_id);
  }
  out.status_label = STATUS_LABELS[m.status] || m.status;
  out.photo_url = m.photo_id ? mediaDataUrl_(m.photo_id) : '';
  out.signature_url = m.signature_id ? mediaDataUrl_(m.signature_id) : '';
  return { ok: true, member: out, role: s.role, meta: { types: MEMBER_TYPES, works: WORK_TYPES, statuses: STATUS_LABELS,
    term_years: termYears_() } };
}

/* =========================================================
 * เพิ่มสมาชิกโดยผู้ดูแล
 * =======================================================*/
function apiCreateMember(token, data, client) {
  var s = requireRole_(token, ['superadmin', 'admin']);
  data = data || {};
  return withScriptLock_(function () {
    var d = cleanInput_(data);
    var errs = validateMember_(d, null);
    if (errs.length) return { ok: false, error: errs.join('\n') };

    var tag = uuid_().substring(0, 8);
    var photoId = '', signId = '';
    try {
      photoId = saveMedia_(data.photo_data, 'photo', tag);
      signId = saveMedia_(data.signature_data, 'sign', tag);
    } catch (err) {
      deleteMedia_(photoId); deleteMedia_(signId);
      return { ok: false, error: err.message };
    }

    var status = (d.status && STATUS_LABELS[d.status] && d.status !== 'deleted') ? d.status : 'active';
    var issue = d.issue_date || fmtDate_(new Date());
    var m = Object.assign({}, d, {
      id: uuid_(), member_code: '', status: status,
      member_type: d.member_type || 'สามัญ',
      photo_id: photoId, signature_id: signId,
      issue_date: status === 'active' ? issue : '',
      expire_date: status === 'active' ? (d.expire_date || addYears_(issue, termYears_())) : '',
      consent_version: APP.CONSENT_VERSION,
      consent_at: now_(),
      consent_marketing: data.consent_marketing ? 'yes' : 'no',
      verify_token: randomToken_(18),
      created_at: now_(), created_by: s.username,
      updated_at: now_(), updated_by: s.username
    });
    try {
      // ทุกระเบียนมีเลขที่ใบสมัคร ส่วนเลขสมาชิกออกเฉพาะเมื่อสถานะไม่ใช่ "รอตรวจสอบ"
      m.app_no = nextCode_('APP', 'app_no');
      ensureMemberCode_(m);
      appendRow_(SHEETS.MEMBERS, M_COLS, encodeMember_(m));
    } catch (err) {
      deleteMedia_(photoId); deleteMedia_(signId);
      throw err;
    }
    var ref = memberRef_(m);
    appendRow_(SHEETS.CONSENT, CONSENT_COLS, {
      ts: now_(), member_id: m.id, member_code: ref, consent_version: APP.CONSENT_VERSION,
      purposes: 'บันทึกโดยเจ้าหน้าที่จากใบสมัครกระดาษ', channel: 'เจ้าหน้าที่บันทึก (' + s.username + ')',
      client: String(client || '').substring(0, 250)
    });
    writeLog_(s, 'member.create', 'member', ref,
      'เพิ่มสมาชิกใหม่ ' + ref + ' สถานะ ' + (STATUS_LABELS[status] || status),
      { id: m.id, member_code: m.member_code, app_no: m.app_no, organization: d.organization }, client);
    return { ok: true, id: m.id, member_code: m.member_code, app_no: m.app_no };
  });
}

/** เหตุผลประกอบการเปลี่ยนแปลง : บังคับกรอก บันทึกลงประวัติ (แบบเดียวกับระบบ envbrclub-supabase) */
function cleanReason_(reason) {
  return String(reason === null || reason === undefined ? '' : reason).trim().substring(0, 300);
}

/* =========================================================
 * แก้ไขข้อมูลสมาชิก  (บันทึกทุกฟิลด์ที่เปลี่ยนลงประวัติ พร้อมเหตุผล)
 * =======================================================*/
function apiUpdateMember(token, id, data, client) {
  var s = requireRole_(token, ['superadmin', 'admin']);
  data = data || {};
  var reason = cleanReason_(data.reason);
  if (!reason) return { ok: false, error: 'กรุณาระบุเหตุผลในการแก้ไข เพื่อบันทึกไว้ในประวัติ' };
  return withScriptLock_(function () {
    var cur = findMemberById_(id, false);
    if (!cur) return { ok: false, error: 'ไม่พบข้อมูลสมาชิก' };

    var d = cleanInput_(data);
    // ผู้ดูแลระดับ admin แก้เลขบัตรประชาชนไม่ได้ (ป้องกันแก้ค่าที่ถูกปกปิดทับของจริง)
    if (s.role !== 'superadmin') delete d.national_id;
    var merged = Object.assign({}, cur, d);

    var errs = validateMember_(merged, cur.id);
    if (errs.length) return { ok: false, error: errs.join('\n') };

    // ไฟล์รูป : บันทึกไฟล์ใหม่ก่อน ส่วนไฟล์เดิมลบ (ถาวร) หลังบันทึกแถวสำเร็จเท่านั้น
    // ถ้าขั้นใดล้มกลางทาง ให้ลบเฉพาะไฟล์ใหม่ ไฟล์เดิมของสมาชิกยังอยู่ครบ
    var mediaChanges = [], created = [], toDelete = [];
    var tag = memberRef_(cur);
    try {
      if (data.photo_data) {
        merged.photo_id = saveMedia_(data.photo_data, 'photo', tag);
        created.push(merged.photo_id); toDelete.push(cur.photo_id); mediaChanges.push('เปลี่ยนรูปถ่าย');
      } else if (data.remove_photo && cur.photo_id) {
        merged.photo_id = ''; toDelete.push(cur.photo_id); mediaChanges.push('ลบรูปถ่าย');
      }
      if (data.signature_data) {
        merged.signature_id = saveMedia_(data.signature_data, 'sign', tag);
        created.push(merged.signature_id); toDelete.push(cur.signature_id); mediaChanges.push('เปลี่ยนลายเซ็น');
      } else if (data.remove_signature && cur.signature_id) {
        merged.signature_id = ''; toDelete.push(cur.signature_id); mediaChanges.push('ลบลายเซ็น');
      }
    } catch (err) {
      created.forEach(deleteMedia_);
      return { ok: false, error: err.message };
    }

    // อนุมัติ (เปลี่ยนเป็นสมาชิกปัจจุบันครั้งแรก) : ออกวันบัตรตามอายุบัตรในค่าตั้งค่า
    if (merged.status === 'active' && !merged.issue_date) {
      merged.issue_date = fmtDate_(new Date());
      merged.expire_date = merged.expire_date || addYears_(merged.issue_date, termYears_());
    }

    var diffFields = ['prefix', 'first_name', 'last_name', 'national_id', 'birthdate', 'gender',
      'position', 'organization', 'work_type', 'work_address', 'phone', 'email', 'line_id',
      'member_type', 'education', 'license_no', 'status', 'issue_date', 'expire_date', 'note'];
    var diff = diffMember_(cur, merged, diffFields);

    if (!diff.length && !mediaChanges.length) return { ok: true, note: 'ไม่มีการเปลี่ยนแปลง' };

    try {
      // ออกเลขสมาชิกเมื่ออนุมัติ ทำหลังตรวจว่ามีการเปลี่ยนแปลงจริง เลขจึงไม่ถูกใช้ไปเปล่า ๆ
      if (ensureMemberCode_(merged)) diff = diff.concat(diffMember_(cur, merged, ['member_code']));
      merged.updated_at = now_();
      merged.updated_by = s.username;
      updateRow_(SHEETS.MEMBERS, M_COLS, cur._row, encodeMember_(merged));
    } catch (err) {
      created.forEach(deleteMedia_);
      throw err;
    }
    toDelete.forEach(deleteMedia_);

    var parts = diff.map(function (x) { return x.label; }).concat(mediaChanges);
    writeLog_(s, 'member.update', 'member', memberRef_(merged),
      'แก้ไขข้อมูลสมาชิก ' + memberRef_(merged) + ' : ' + parts.join(', ') + ' เหตุผล: ' + reason,
      { id: cur.id, changes: diff, media: mediaChanges, reason: reason }, client);

    return { ok: true, changed: parts, member_code: merged.member_code };
  });
}

/* =========================================================
 * เปลี่ยนสถานะ (เรียกจากสคริปต์อื่นได้ หน้าเว็บใช้การแก้ไขข้อมูลแทน)
 * =======================================================*/
function apiSetStatus(token, id, status, reason, client) {
  var s = requireRole_(token, ['superadmin', 'admin']);
  if (!Object.prototype.hasOwnProperty.call(STATUS_LABELS, status) || status === 'deleted') {
    return { ok: false, error: 'สถานะไม่ถูกต้อง' };
  }
  reason = cleanReason_(reason);
  if (!reason) return { ok: false, error: 'กรุณาระบุเหตุผลในการเปลี่ยนสถานะ' };
  return withScriptLock_(function () {
    var cur = findMemberById_(id, false);
    if (!cur) return { ok: false, error: 'ไม่พบข้อมูลสมาชิก' };
    if (cur.status === status) return { ok: true, note: 'สถานะเดิมอยู่แล้ว' };

    var next = Object.assign({}, cur, { status: status, updated_at: now_(), updated_by: s.username });
    if (status === 'active' && !cur.issue_date) {
      next.issue_date = fmtDate_(new Date());
      next.expire_date = addYears_(next.issue_date, termYears_());
    }
    ensureMemberCode_(next);
    updateRow_(SHEETS.MEMBERS, M_COLS, cur._row, encodeMember_(next));
    writeLog_(s, 'member.status', 'member', memberRef_(next),
      'เปลี่ยนสถานะ ' + memberRef_(next) + ' จาก "' + (STATUS_LABELS[cur.status] || cur.status) +
      '" เป็น "' + STATUS_LABELS[status] + '" เหตุผล: ' + reason,
      { id: cur.id, from: cur.status, to: status, reason: reason, member_code: next.member_code }, client);
    return { ok: true, member_code: next.member_code };
  });
}

/* =========================================================
 * ต่ออายุสมาชิก
 * ใช้กติกาเดียวกับระบบ envbrclub-supabase (admin_decide_application) :
 *   ต่อก่อนหมดอายุ  = ช่วงใหม่เริ่มวันถัดจากวันหมดอายุเดิม สมาชิกภาพจึงต่อเนื่องไม่เสียวันที่เหลือ
 *   หมดอายุแล้ว     = ช่วงใหม่เริ่มวันนี้
 * วันออกบัตรเป็นวันที่ต่ออายุ (วันที่พิมพ์บัตรใบใหม่) บัตรใบเดิมจึงไม่ขาดช่วงระหว่างรอช่วงใหม่
 * =======================================================*/
function apiRenewMember(token, id, reason, client) {
  var s = requireRole_(token, ['superadmin', 'admin']);
  reason = cleanReason_(reason);
  if (!reason) return { ok: false, error: 'กรุณาระบุเหตุผล/หลักฐานการต่ออายุ' };
  return withScriptLock_(function () {
    var cur = findMemberById_(id, false);
    if (!cur) return { ok: false, error: 'ไม่พบข้อมูลสมาชิก' };
    if (cur.status !== 'active' && cur.status !== 'expired') {
      return { ok: false, error: 'ต่ออายุได้เฉพาะสมาชิกปัจจุบันหรือสมาชิกที่หมดอายุ (สถานะปัจจุบัน: ' +
        (STATUS_LABELS[cur.status] || cur.status) + ')' };
    }
    var today = fmtDate_(new Date());
    var years = termYears_();
    var from = cur.expire_date && isDateStr_(cur.expire_date) && cur.expire_date >= today
      ? addDays_(cur.expire_date, 1) : today;
    var to = addYears_(from, years);

    var next = Object.assign({}, cur, {
      status: 'active', issue_date: today, expire_date: to, updated_at: now_(), updated_by: s.username
    });
    ensureMemberCode_(next);
    var diff = diffMember_(cur, next, ['status', 'issue_date', 'expire_date', 'member_code']);
    updateRow_(SHEETS.MEMBERS, M_COLS, cur._row, encodeMember_(next));
    writeLog_(s, 'member.renew', 'member', memberRef_(next),
      'ต่ออายุสมาชิก ' + memberRef_(next) + ' ' + years + ' ปี ถึง ' + to + ' เหตุผล: ' + reason,
      { id: cur.id, changes: diff, period_start: from, period_end: to, reason: reason }, client);
    return { ok: true, period_start: from, expire_date: to, member_code: next.member_code };
  });
}

/* =========================================================
 * ลบข้อมูลสมาชิก (ลบถาวร พร้อมรูปถ่ายและลายเซ็นใน Drive)
 * กติกาเดียวกับระบบ envbrclub-supabase (admin_delete_member) :
 *  - เฉพาะผู้ดูแลระดับสูงสุด ต้องระบุเหตุผล และพิมพ์ชื่อ-นามสกุลให้ตรงเพื่อยืนยัน (กันการกดพลาด)
 *  - ผู้ที่เคยได้รับบัตรสมาชิกแล้ว ลบไม่ได้ ให้เปลี่ยนสถานะเป็น "พ้นสมาชิกภาพ" แทนเพื่อคงประวัติไว้
 *    ยกเว้นพ้นสมาชิกภาพหรือหมดอายุมาแล้วเกินระยะเก็บรักษา (RETENTION_YEARS) ซึ่งต้องทำลายตามนโยบาย
 *  - บันทึกความยินยอม (ConsentLog) และบันทึกประวัติยังคงอยู่เป็นหลักฐาน
 * =======================================================*/
function apiDeleteMember(token, id, reason, confirmName, client) {
  var s = requireRole_(token, ['superadmin']);
  reason = cleanReason_(reason);
  if (!reason) return { ok: false, error: 'กรุณาระบุเหตุผลในการลบข้อมูลสมาชิก' };
  // ลบแถวทำให้เลขแถวของคนอื่นเลื่อน ต้องถือ lock กันการแก้ไขที่กำลังเขียนตามเลขแถวเดิม
  return withScriptLock_(function () {
    var m = findMemberById_(id, true);
    if (!m) return { ok: false, error: 'ไม่พบข้อมูลสมาชิก' };

    var norm = function (v) { return String(v || '').replace(/\s/g, '').toLowerCase(); };
    if (!norm(confirmName) || norm(confirmName) !== norm(m.first_name + m.last_name)) {
      return { ok: false, error: 'การลบต้องพิมพ์ชื่อ-นามสกุลของสมาชิกให้ตรงเพื่อยืนยัน (ต้องพิมพ์ว่า "' +
        m.first_name + ' ' + m.last_name + '")' };
    }

    if (m.issue_date) {
      var ended = ['revoked', 'expired', 'deleted'].indexOf(m.status) >= 0;
      var endDate = m.expire_date && isDateStr_(m.expire_date) ? m.expire_date : String(m.updated_at).substring(0, 10);
      var purgeAfter = isDateStr_(endDate) ? addYears_(addDays_(endDate, 1), APP.RETENTION_YEARS) : '';
      if (!ended || !purgeAfter || purgeAfter >= fmtDate_(new Date())) {
        return { ok: false, error: 'สมาชิกรายนี้เคยได้รับบัตรสมาชิกแล้ว จึงลบไม่ได้ ' +
          'หากต้องการยุติสมาชิกภาพ ให้แก้ไขสถานะเป็น "พ้นสมาชิกภาพ" แทน เพื่อคงประวัติไว้ตรวจสอบได้ ' +
          '(ลบได้เมื่อพ้นสมาชิกภาพหรือหมดอายุมาแล้วเกิน ' + APP.RETENTION_YEARS + ' ปี ตามระยะเก็บรักษา)' };
      }
    }

    deleteMedia_(m.photo_id); deleteMedia_(m.signature_id);
    deleteRowSafe_(sheet_(SHEETS.MEMBERS), m._row);
    var ref = memberRef_(m);
    writeLog_(s, 'member.delete', 'member', ref,
      'ลบข้อมูลสมาชิกถาวร ' + ref + ' เหตุผล: ' + reason,
      { id: m.id, member_code: m.member_code, app_no: m.app_no, status: m.status, reason: reason }, client);
    return { ok: true };
  });
}

/**
 * ลบข้อมูลตามคำขอใช้สิทธิของเจ้าของข้อมูล (มาตรา 33 PDPA) กรณีที่หน้าเว็บไม่อนุญาต (เคยได้รับบัตรแล้ว)
 * เรียกจากตัวแก้ไขสคริปต์โดยเจ้าของระบบเท่านั้น แบบเดียวกับระบบ envbrclub-supabase ที่ทำได้เฉพาะผู้ดูแลฐานข้อมูล
 * วิธีใช้ : Project Settings > Script Properties เพิ่ม ERASE_REQUEST = <เลขสมาชิกหรือเลขที่ใบสมัคร> | <เหตุผล/เลขที่คำขอ>
 *          แล้วเลือกฟังก์ชันนี้กด Run ระบบลบค่า ERASE_REQUEST ทิ้งเมื่อทำเสร็จ
 */
function eraseMemberOnRequest() {
  requireEditor_();
  var props = PropertiesService.getScriptProperties();
  var raw = String(props.getProperty('ERASE_REQUEST') || '');
  var cut = raw.indexOf('|');
  var ref = (cut >= 0 ? raw.substring(0, cut) : raw).trim();
  var reason = cleanReason_(cut >= 0 ? raw.substring(cut + 1) : '');
  if (!ref || !reason) throw new Error('ตั้ง Script Property ERASE_REQUEST เป็น "เลขสมาชิกหรือเลขที่ใบสมัคร | เหตุผล" ก่อน');
  var msg = withScriptLock_(function () {
    var rows = readTable_(SHEETS.MEMBERS, M_COLS).filter(function (r) {
      return r.member_code === ref || r.app_no === ref;
    });
    if (rows.length !== 1) throw new Error(rows.length ? 'พบมากกว่า 1 รายการ กรุณาตรวจเลขอ้างอิง' : 'ไม่พบสมาชิก ' + ref);
    var m = decodeMember_(rows[0]);
    deleteMedia_(m.photo_id); deleteMedia_(m.signature_id);
    deleteRowSafe_(sheet_(SHEETS.MEMBERS), m._row);
    writeLog_({ username: 'เจ้าของระบบ', role: 'system' }, 'member.delete', 'member', ref,
      'ลบข้อมูลสมาชิกถาวรตามคำขอของเจ้าของข้อมูล (มาตรา 33) ' + ref + ' เหตุผล: ' + reason,
      { id: m.id, member_code: m.member_code, app_no: m.app_no, status: m.status, reason: reason, pdpa_request: true });
    return 'ลบข้อมูล ' + ref + ' แล้ว (บันทึกความยินยอมและประวัติยังเก็บไว้เป็นหลักฐาน)';
  });
  props.deleteProperty('ERASE_REQUEST');
  Logger.log(msg);
  return msg;
}

/* =========================================================
 * ออกบัตรใบใหม่ (บัตรหาย / ข้อมูลบนบัตรเปลี่ยน)
 * เปลี่ยนรหัสตรวจสอบ QR ทันที บัตรใบเดิมสแกนแล้วจะไม่พบในระบบอีก (แบบเดียวกับ admin_reissue_card)
 * =======================================================*/
function apiReissueCard(token, id, reason, client) {
  var s = requireRole_(token, ['superadmin', 'admin']);
  reason = cleanReason_(reason);
  if (!reason) return { ok: false, error: 'กรุณาระบุเหตุผลในการออกบัตรใบใหม่ (เช่น บัตรหาย ข้อมูลเปลี่ยน)' };
  return withScriptLock_(function () {
    var cur = findMemberById_(id, false);
    if (!cur) return { ok: false, error: 'ไม่พบข้อมูลสมาชิก' };
    if (cur.status !== 'active') {
      return { ok: false, error: 'ออกบัตรใบใหม่ได้เฉพาะสมาชิกที่มีสถานะ "สมาชิกปัจจุบัน"' };
    }
    var next = Object.assign({}, cur, { verify_token: randomToken_(18), updated_at: now_(), updated_by: s.username });
    ensureMemberCode_(next);
    updateRow_(SHEETS.MEMBERS, M_COLS, cur._row, encodeMember_(next));
    writeLog_(s, 'member.card_reissue', 'member', memberRef_(next),
      'ออกบัตรใบใหม่ให้ ' + memberRef_(next) + ' (QR ของบัตรใบเดิมใช้ไม่ได้แล้ว) เหตุผล: ' + reason,
      { id: cur.id, reason: reason }, client);
    return { ok: true };
  });
}

/* =========================================================
 * บัตรสมาชิก
 * =======================================================*/
/** ผู้ดูแลขอโทเคนพิมพ์บัตร (อายุ 10 นาที ใช้เปิดหน้าบัตรในแท็บใหม่) */
function apiIssuePrintToken(token, id, client) {
  var s = requireRole_(token, ['superadmin', 'admin']);
  var m = findMemberById_(id, false);
  if (!m) return { ok: false, error: 'ไม่พบข้อมูลสมาชิก' };
  if (m.status !== 'active' || !m.member_code) {
    return { ok: false, error: 'พิมพ์บัตรได้เฉพาะสมาชิกที่มีสถานะ "สมาชิกปัจจุบัน" — กรุณาอนุมัติสมาชิกก่อน' };
  }
  var pt = randomToken_(24);
  CacheService.getScriptCache().put('PRINT:' + sha256b64_(pt),
    JSON.stringify({ id: m.id, by: s.username, role: s.role, name: s.display_name }), 600);
  writeLog_(s, 'member.card_print', 'member', m.member_code,
    'เปิดพิมพ์บัตรสมาชิก ' + m.member_code, { id: m.id }, client);
  return { ok: true, print_token: pt, url: getWebAppUrl_() + '?page=card&pt=' + encodeURIComponent(pt) };
}

/** ข้อมูลสำหรับหน้าบัตร (เรียกจากหน้า Card ด้วย print token) */
function apiGetCardData(printToken) {
  var raw = CacheService.getScriptCache().get('PRINT:' + sha256b64_(printToken || ''));
  if (!raw) return { ok: false, error: 'ลิงก์พิมพ์บัตรหมดอายุแล้ว กรุณากดพิมพ์บัตรใหม่จากหน้าผู้ดูแล' };
  var ctx = JSON.parse(raw);
  var m = findMemberById_(ctx.id, false);
  if (!m) return { ok: false, error: 'ไม่พบข้อมูลสมาชิก' };
  // สถานะอาจเปลี่ยนระหว่างที่ลิงก์ยังไม่หมดอายุ (เช่นถูกยกเลิก) ต้องตรวจซ้ำตอนเปิดหน้าบัตร
  if (m.status !== 'active' || !m.member_code) {
    return { ok: false, error: 'สมาชิกรายนี้ไม่ได้อยู่ในสถานะ "สมาชิกปัจจุบัน" แล้ว จึงพิมพ์บัตรไม่ได้' };
  }
  var s = getSettings_();
  return {
    ok: true,
    card: {
      member_code: m.member_code,
      prefix: m.prefix, first_name: m.first_name, last_name: m.last_name,
      full_name: (m.prefix || '') + m.first_name + ' ' + m.last_name,
      position: m.position, organization: m.organization,
      member_type: m.member_type,
      issue_date: m.issue_date, expire_date: m.expire_date,
      photo: mediaDataUrl_(m.photo_id),
      signature: mediaDataUrl_(m.signature_id),
      verify_url: getWebAppUrl_() + '?page=verify&t=' + encodeURIComponent(m.verify_token)
    },
    club: {
      name: s.CLUB_NAME, name_en: s.CLUB_NAME_EN, address: s.CLUB_ADDRESS,
      phone: s.CLUB_PHONE, email: s.CLUB_EMAIL, note: s.CARD_NOTE,
      president: s.PRESIDENT_NAME, president_title: s.PRESIDENT_TITLE,
      president_sign: s.PRESIDENT_SIGN_ID ? mediaDataUrl_(s.PRESIDENT_SIGN_ID) : '',
      logo: s.LOGO_ID ? mediaDataUrl_(s.LOGO_ID) : ''
    },
    printed_by: ctx.name || ctx.by
  };
}

/* =========================================================
 * ตรวจสอบสมาชิกผ่าน QR (สาธารณะ — เปิดเผยเท่าที่จำเป็น)
 * =======================================================*/
function apiVerify(t, client) {
  var token = String(t || '').trim();
  if (!token) return { ok: false, error: 'ไม่พบรหัสตรวจสอบ' };

  var rows = readTable_(SHEETS.MEMBERS, M_COLS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].verify_token) === token) {
      var m = decodeMember_(rows[i]);
      // ยังไม่เคยออกบัตร (ใบสมัครรอตรวจสอบ) ถือว่าไม่พบบัตร แบบเดียวกับระบบ envbrclub-supabase ที่ตรวจจากบัตรที่ออกแล้วเท่านั้น
      if (m.status === 'deleted' || !m.issue_date) break;
      var today = fmtDate_(new Date());
      var expired = m.expire_date && m.expire_date < today;
      var status = expired && m.status === 'active' ? 'expired' : m.status;
      // ใช้ได้เมื่อสถานะเป็นสมาชิกปัจจุบัน และวันนี้อยู่ในช่วงวันออกบัตรถึงวันหมดอายุ
      var notStarted = status === 'active' && m.issue_date > today;
      if (allowPublicLog_('verify')) {
        writeLog_({ username: 'ผู้ตรวจสอบ', role: 'public' }, 'member.card_verify', 'member', m.member_code,
          'ตรวจสอบบัตรสมาชิก ' + m.member_code + ' ผลลัพธ์ ' + (STATUS_LABELS[status] || status),
          { member_code: m.member_code, status: status }, client);
      }
      return {
        ok: true,
        valid: status === 'active' && !notStarted,
        not_started: notStarted,
        data: {
          member_code: m.member_code,
          full_name: (m.prefix || '') + m.first_name + ' ' + m.last_name,
          organization: m.organization,
          position: m.position,
          member_type: m.member_type,
          status: status,
          status_label: STATUS_LABELS[status] || status,
          issue_date: m.issue_date,
          expire_date: m.expire_date,
          photo: m.photo_id ? mediaDataUrl_(m.photo_id) : ''
        }
      };
    }
  }
  if (allowPublicLog_('verify')) {
    writeLog_({ username: 'ผู้ตรวจสอบ', role: 'public' }, 'member.card_verify', 'member', '-',
      'ตรวจสอบบัตรด้วยรหัสที่ไม่มีในระบบ', {}, client);
  }
  return { ok: true, valid: false, notfound: true };
}
