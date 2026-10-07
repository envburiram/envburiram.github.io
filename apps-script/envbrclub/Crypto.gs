/*************************************************************
 * Crypto.gs : การเข้ารหัสข้อมูลส่วนบุคคล
 *
 * มาตรฐานที่ใช้
 *  - เข้ารหัสรายฟิลด์แบบ stream cipher จาก HMAC-SHA256 (โหมดนับ)
 *    แล้วผนวก MAC แบบ Encrypt-then-MAC (HMAC-SHA256 ตัด 128 บิต)
 *  - กุญแจหลัก 256 บิต เก็บใน Script Properties แยกจากฐานข้อมูล
 *    (ผู้ที่เห็นสเปรดชีตแต่ไม่มีสิทธิ์สคริปต์ จะอ่านข้อมูลไม่ได้)
 *  - แตกกุญแจย่อยด้วย HMAC (enc / mac / idx) ไม่ใช้กุญแจเดียวหลายหน้าที่
 *  - Blind index : HMAC ของค่าที่ปรับรูปแล้ว ใช้ค้นหา/กันซ้ำโดยไม่ต้องถอดรหัส
 *  - รหัสผ่านผู้ดูแล : PBKDF2-HMAC-SHA256 พร้อม salt เฉพาะบัญชี
 *
 * รูปแบบข้อความเข้ารหัส : v1:<iv b64>:<ciphertext b64>:<tag b64>
 *************************************************************/

var CRYPTO_CFG = { VERSION: 'v1', IV_LEN: 16, TAG_LEN: 16, PBKDF2_ITER: 12000 };

/* ---------- กุญแจ ---------- */
/**
 * สร้างกุญแจใหม่เฉพาะตอน setup() เท่านั้น
 * ถ้ากุญแจหายไปภายหลัง (เช่นมีคนลบ Script Property) ต้องหยุดทำงาน ไม่สร้างกุญแจใหม่เงียบ ๆ
 * เพราะข้อมูลเดิมจะถอดรหัสไม่ได้ และข้อมูลใหม่จะปนกับกุญแจคนละชุด
 */
function cryptoGetMasterKey_(createIfMissing) {
  if (cryptoGetMasterKey_._k) return cryptoGetMasterKey_._k;
  var props = PropertiesService.getScriptProperties();
  var b64 = props.getProperty('MASTER_KEY_B64');
  if (!b64) {
    if (!createIfMissing) {
      throw new Error('ไม่พบกุญแจเข้ารหัส (MASTER_KEY_B64) — ถ้าเพิ่งติดตั้งให้เรียก setup() ' +
        'ถ้าเคยใช้งานแล้วให้นำค่าที่สำรองไว้กลับมาใส่ใน Script Properties');
    }
    b64 = Utilities.base64Encode(cryptoRandomBytes_(32));
    props.setProperty('MASTER_KEY_B64', b64);
    props.setProperty('MASTER_KEY_CREATED', new Date().toISOString());
  }
  cryptoGetMasterKey_._k = Utilities.base64Decode(b64);
  return cryptoGetMasterKey_._k;
}

function cryptoSubKey_(label) {
  var c = cryptoSubKey_._c || (cryptoSubKey_._c = {});
  if (c[label]) return c[label];
  c[label] = Utilities.computeHmacSha256Signature(strBytes_('BREH-KDF|' + label), cryptoGetMasterKey_());
  return c[label];
}

/**
 * กุญแจสำรองสำหรับถอดรหัส (ไม่ใช้เข้ารหัส) :
 *   MASTER_KEY_PREV_B64 กุญแจชุดก่อนหลังหมุนกุญแจ (ข้อมูลที่ถูกเขียนระหว่างหมุนยังอ่านได้)
 *   MASTER_KEY_NEXT_B64 กุญแจใหม่ระหว่างที่การหมุนยังไม่เสร็จ (ถ้าหมุนค้างครึ่งทาง ข้อมูลที่เขียนไปแล้วยังอ่านได้)
 * คืนรายการ {mac, enc} ของกุญแจที่มีอยู่
 */
function cryptoAltKeys_() {
  if (cryptoAltKeys_._list) return cryptoAltKeys_._list;
  var props = PropertiesService.getScriptProperties();
  cryptoAltKeys_._list = ['MASTER_KEY_PREV_B64', 'MASTER_KEY_NEXT_B64']
    .map(function (k) { return props.getProperty(k); })
    .filter(Boolean)
    .map(function (b64) {
      var master = Utilities.base64Decode(b64);
      return {
        mac: Utilities.computeHmacSha256Signature(strBytes_('BREH-KDF|mac'), master),
        enc: Utilities.computeHmacSha256Signature(strBytes_('BREH-KDF|enc'), master)
      };
    });
  return cryptoAltKeys_._list;
}

/** ล้างกุญแจที่แคชไว้ในการทำงานรอบนี้ (หลังเปลี่ยน Script Properties ของกุญแจ) */
function cryptoResetCache_() {
  cryptoGetMasterKey_._k = null;
  cryptoSubKey_._c = null;
  cryptoAltKeys_._list = null;
}

/* ---------- ตัวช่วยระดับไบต์ ---------- */
function strBytes_(s) { return Utilities.newBlob(String(s)).getBytes(); }
function bytesStr_(b) { return Utilities.newBlob(b).getDataAsString('UTF-8'); }
function signed_(n) { n = n & 0xff; return n > 127 ? n - 256 : n; }

function cryptoRandomBytes_(n) {
  var out = [];
  while (out.length < n) {
    var seed = Utilities.getUuid() + '|' + Utilities.getUuid() + '|' +
      new Date().getTime() + '|' + Math.random();
    out = out.concat(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8));
  }
  return out.slice(0, n);
}

function intBytes_(i) {
  return [signed_((i >> 24) & 0xff), signed_((i >> 16) & 0xff), signed_((i >> 8) & 0xff), signed_(i & 0xff)];
}

function keystream_(key, iv, len) {
  var out = [], counter = 0;
  while (out.length < len) {
    out = out.concat(Utilities.computeHmacSha256Signature(iv.concat(intBytes_(counter)), key));
    counter++;
  }
  return out.slice(0, len);
}

function xorBytes_(a, b) {
  var out = new Array(a.length);
  for (var i = 0; i < a.length; i++) out[i] = signed_((a[i] & 0xff) ^ (b[i] & 0xff));
  return out;
}

/** เทียบไบต์แบบเวลาคงที่ ป้องกัน timing attack */
function constEq_(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= (a[i] & 0xff) ^ (b[i] & 0xff);
  return diff === 0;
}

/* ---------- เข้ารหัส / ถอดรหัส ---------- */
function encryptField_(plain) {
  if (plain === null || plain === undefined || plain === '') return '';
  var data = strBytes_(plain);
  var iv = cryptoRandomBytes_(CRYPTO_CFG.IV_LEN);
  var ct = xorBytes_(data, keystream_(cryptoSubKey_('enc'), iv, data.length));
  var tag = Utilities.computeHmacSha256Signature(iv.concat(ct), cryptoSubKey_('mac')).slice(0, CRYPTO_CFG.TAG_LEN);
  return CRYPTO_CFG.VERSION + ':' + Utilities.base64Encode(iv) + ':' +
    Utilities.base64Encode(ct) + ':' + Utilities.base64Encode(tag);
}

function decryptField_(cipher) {
  if (cipher === null || cipher === undefined || cipher === '') return '';
  var s = String(cipher);
  if (s.indexOf(CRYPTO_CFG.VERSION + ':') !== 0) return s;   // ข้อมูลเดิมที่ยังไม่เข้ารหัส
  var parts = s.split(':');
  if (parts.length !== 4) return '';
  try {
    var iv = Utilities.base64Decode(parts[1]);
    var ct = Utilities.base64Decode(parts[2]);
    var tag = Utilities.base64Decode(parts[3]);
    var expect = Utilities.computeHmacSha256Signature(iv.concat(ct), cryptoSubKey_('mac')).slice(0, CRYPTO_CFG.TAG_LEN);
    if (constEq_(tag, expect)) return bytesStr_(xorBytes_(ct, keystream_(cryptoSubKey_('enc'), iv, ct.length)));
    // ข้อมูลที่ยังเข้ารหัสด้วยกุญแจชุดก่อน หรือกุญแจใหม่ของการหมุนที่ยังไม่เสร็จ ยังอ่านได้
    var alt = cryptoAltKeys_();
    for (var i = 0; i < alt.length; i++) {
      var expectAlt = Utilities.computeHmacSha256Signature(iv.concat(ct), alt[i].mac).slice(0, CRYPTO_CFG.TAG_LEN);
      if (constEq_(tag, expectAlt)) return bytesStr_(xorBytes_(ct, keystream_(alt[i].enc, iv, ct.length)));
    }
    return '[ข้อมูลถูกแก้ไข]';
  } catch (e) {
    return '[ถอดรหัสไม่สำเร็จ]';
  }
}

/* ---------- Blind index : ค้นหา/กันซ้ำโดยไม่ถอดรหัส ---------- */
function normalizeForIndex_(kind, v) {
  v = String(v === null || v === undefined ? '' : v).trim();
  if (!v) return '';
  if (kind === 'nid' || kind === 'phone') return v.replace(/\D/g, '');
  if (kind === 'email') return v.toLowerCase();
  return v.toLowerCase().replace(/\s+/g, ' ');
}

function blindIndex_(kind, value) {
  var v = normalizeForIndex_(kind, value);
  if (!v) return '';
  return Utilities.base64Encode(
    Utilities.computeHmacSha256Signature(strBytes_(kind + '|' + v), cryptoSubKey_('idx'))
  ).substring(0, 24);
}

/* ---------- โทเคนสุ่มปลอดภัย ---------- */
function randomToken_(bytes) {
  return Utilities.base64EncodeWebSafe(cryptoRandomBytes_(bytes || 24)).replace(/=+$/, '');
}

function sha256b64_(s) {
  // ใช้รูปแบบ web-safe เพราะค่านี้ถูกใช้เป็นคีย์ของ CacheService ด้วย
  return Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)).replace(/=+$/, '');
}

/* ---------- รหัสผ่าน (PBKDF2-HMAC-SHA256) ---------- */
function pbkdf2_(password, saltBytes, iterations) {
  var pw = strBytes_(password);
  var u = Utilities.computeHmacSha256Signature(saltBytes.concat([0, 0, 0, 1]), pw);
  var out = u.slice();
  for (var i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, pw);
    for (var j = 0; j < out.length; j++) out[j] = signed_((out[j] & 0xff) ^ (u[j] & 0xff));
  }
  return out;
}

function hashPassword_(password, saltB64, iter) {
  iter = iter || CRYPTO_CFG.PBKDF2_ITER;
  var salt = saltB64 ? Utilities.base64Decode(saltB64) : cryptoRandomBytes_(16);
  var dk = pbkdf2_(password, salt, iter);
  return {
    hash: Utilities.base64Encode(dk),
    salt: Utilities.base64Encode(salt),
    iter: iter
  };
}

function verifyPassword_(password, hashB64, saltB64, iter) {
  var calc = pbkdf2_(password, Utilities.base64Decode(saltB64), Number(iter) || CRYPTO_CFG.PBKDF2_ITER);
  return constEq_(calc, Utilities.base64Decode(hashB64));
}

/* ---------- ตรวจสอบความถูกต้องของระบบเข้ารหัส ---------- */
function selfTestCrypto() {
  requireEditor_();
  var samples = ['1234567890123', 'สมชาย ใจดี', 'test@example.com', '', 'ที่อยู่ 99/1 ต.ในเมือง อ.เมือง จ.บุรีรัมย์'];
  var pass = true, report = [];
  samples.forEach(function (s) {
    var c = encryptField_(s);
    var d = decryptField_(c);
    var ok = d === s;
    pass = pass && ok;
    report.push((ok ? 'ผ่าน' : 'ไม่ผ่าน') + ' : "' + s + '" -> ' + (c ? c.substring(0, 28) + '…' : '(ว่าง)'));
  });
  var h = hashPassword_('P@ssw0rd-ทดสอบ');
  var okPw = verifyPassword_('P@ssw0rd-ทดสอบ', h.hash, h.salt, h.iter) &&
    !verifyPassword_('ผิด', h.hash, h.salt, h.iter);
  report.push((okPw ? 'ผ่าน' : 'ไม่ผ่าน') + ' : ตรวจรหัสผ่าน PBKDF2');
  report.push('blind index 1234567890123 = ' + blindIndex_('nid', '1-2345-67890-12-3'));
  var out = report.join('\n') + '\n\nสรุป : ' + (pass && okPw ? 'ระบบเข้ารหัสทำงานปกติ' : 'พบข้อผิดพลาด');
  Logger.log(out);
  return out;
}

/*************************************************************
 * การหมุนกุญแจ (Key rotation) — ใช้เมื่อสงสัยว่ากุญแจรั่วไหล
 * ขั้นตอน : สำรองสเปรดชีต > เรียก rotateEncryptionKey() จากตัวแก้ไขสคริปต์ > ตรวจข้อมูล
 *
 * ทำงานเป็นชุดและกลับมาทำต่อได้ :
 *  - กุญแจใหม่ถูกบันทึกเป็น MASTER_KEY_NEXT_B64 ก่อนเขียนข้อมูลใด ๆ (ถอดรหัสได้ทั้งกุญแจเดิมและกุญแจใหม่ระหว่างทาง)
 *  - AuditLog (ตารางใหญ่สุด) เข้ารหัสใหม่ทีละชุด และจำตำแหน่งไว้ใน ROTATE_LOG_ROW
 *    ถ้าใกล้ครบเวลา 6 นาที จะหยุดเองและแจ้งให้รันซ้ำ รอบถัดไปทำต่อจากตำแหน่งเดิม
 *  - Members ทำทั้งตารางในครั้งเดียว (ดัชนีค้นหาต้องเปลี่ยนพร้อมกัน) แล้วสลับกุญแจทันที
 *************************************************************/
var ROTATE_CFG = { BUDGET_MS: 270000, CHUNK: 2000 };

function rotateEncryptionKey() {
  requireEditor_();
  var started = new Date().getTime();
  var elapsed = function () { return new Date().getTime() - started; };
  return withScriptLock_(function () {
    var props = PropertiesService.getScriptProperties();
    var oldKeyB64 = props.getProperty('MASTER_KEY_B64');
    if (!oldKeyB64) throw new Error('ยังไม่มีกุญแจในระบบ');

    // 1) กุญแจใหม่ : ใช้ของรอบที่ค้างอยู่ (ถ้ามี) ไม่เช่นนั้นสร้างใหม่ แล้วบันทึกไว้ก่อนเขียนข้อมูลใด ๆ
    var resumed = !!props.getProperty('MASTER_KEY_NEXT_B64');
    var newKeyB64 = props.getProperty('MASTER_KEY_NEXT_B64') || Utilities.base64Encode(cryptoRandomBytes_(32));
    if (!resumed) props.setProperties({ MASTER_KEY_NEXT_B64: newKeyB64, ROTATE_LOG_ROW: '2' });
    cryptoResetCache_();
    var oldKey = Utilities.base64Decode(oldKeyB64), newKey = Utilities.base64Decode(newKeyB64);
    // ถอดรหัสด้วยกุญแจหลักปัจจุบัน (สำรองด้วยกุญแจชุดก่อน/กุญแจใหม่) แล้วเข้ารหัสด้วยกุญแจใหม่
    var useKey = function (k) { cryptoGetMasterKey_._k = k; cryptoSubKey_._c = null; };

    var BAD = ['[ข้อมูลถูกแก้ไข]', '[ถอดรหัสไม่สำเร็จ]'];
    var failed = 0;
    // ค่าที่ถอดรหัสไม่ได้คงข้อความเข้ารหัสเดิมไว้ ไม่เขียนทับด้วยข้อความแจ้งเตือน
    var ok = function (v) { if (BAD.indexOf(v) >= 0) { failed++; return false; } return true; };

    // 2) AuditLog ทีละชุด
    var lSh = ensureColumns_(sheet_(SHEETS.LOG), LOG_COLS.length);
    var lCol = LOG_COLS.indexOf('detail_enc') + 1;
    var lLast = lSh.getLastRow();
    var cursor = Math.max(2, Number(props.getProperty('ROTATE_LOG_ROW') || 2));
    while (cursor <= lLast) {
      if (elapsed() > ROTATE_CFG.BUDGET_MS) return notDone_(cursor, lLast);
      var n = Math.min(ROTATE_CFG.CHUNK, lLast - cursor + 1);
      var vals = lSh.getRange(cursor, lCol, n, 1).getValues();
      useKey(oldKey);
      var plain = vals.map(function (r) { return decryptField_(cellStr_(r[0])); });
      useKey(newKey);
      var out = plain.map(function (v, i) { return [ok(v) ? encryptField_(v) : cellStr_(vals[i][0])]; });
      lSh.getRange(cursor, lCol, n, 1).setNumberFormat('@').setValues(out);
      cursor += n;
      props.setProperty('ROTATE_LOG_ROW', String(cursor));
    }
    // เหลือเวลาไม่พอสำหรับทั้งตาราง Members ให้รันรอบใหม่ (จะข้าม AuditLog ที่ทำแล้ว)
    if (elapsed() > ROTATE_CFG.BUDGET_MS / 2) return notDone_(cursor, lLast);

    // 3) Members ทั้งตาราง
    var col = function (f) { return M_COLS.indexOf(f); };
    var mSh = ensureColumns_(sheet_(SHEETS.MEMBERS), M_COLS.length);
    var mLast = mSh.getLastRow();
    var mVals = mLast >= 2 ? mSh.getRange(2, 1, mLast - 1, M_COLS.length).getValues() : [];
    useKey(oldKey);
    var mPlain = mVals.map(function (row) {
      var o = {};
      M_ENCRYPTED.forEach(function (f) { o[f] = decryptField_(cellStr_(row[col(f)])); });
      return o;
    });
    useKey(newKey);
    var mOut = mVals.map(function (row, i) {
      var r = row.map(cellStr_);
      var p = mPlain[i];
      M_ENCRYPTED.forEach(function (f) { if (ok(p[f])) r[col(f)] = encryptField_(p[f]); });
      // blind index ต้องคำนวณใหม่ด้วยเพราะกุญแจ idx เปลี่ยน
      if (BAD.indexOf(p.national_id) < 0) r[col('nid_idx')] = blindIndex_('nid', p.national_id);
      if (BAD.indexOf(p.phone) < 0) r[col('phone_idx')] = blindIndex_('phone', p.phone);
      if (BAD.indexOf(p.email) < 0) r[col('email_idx')] = blindIndex_('email', p.email);
      if (BAD.indexOf(p.first_name) < 0 && BAD.indexOf(p.last_name) < 0) {
        r[col('name_idx')] = blindIndex_('name', String(p.first_name || '') + ' ' + String(p.last_name || ''));
      }
      return r;
    });
    if (mOut.length) mSh.getRange(2, 1, mOut.length, M_COLS.length).setNumberFormat('@').setValues(mOut);

    // 4) เขียนครบแล้วจึงสลับกุญแจ : กุญแจเดิมเก็บเป็นชุดก่อน (แถวที่ถูกเขียนระหว่างหมุนยังอ่านได้)
    props.setProperties({
      MASTER_KEY_PREV_B64: oldKeyB64,
      MASTER_KEY_B64: newKeyB64,
      MASTER_KEY_CREATED: new Date().toISOString()
    });
    props.deleteProperty('MASTER_KEY_NEXT_B64');
    props.deleteProperty('ROTATE_LOG_ROW');
    cryptoResetCache_();

    var msg = 'หมุนกุญแจสำเร็จ' + (resumed ? ' (ทำต่อจากรอบที่ค้าง)' : '') +
      ' สมาชิก ' + mOut.length + ' ระเบียน ประวัติ ' + Math.max(lLast - 1, 0) + ' รายการ' +
      (failed ? ' (ถอดรหัสไม่ได้ ' + failed + ' ช่อง คงค่าเดิมไว้)' : '');
    writeLog_({ username: 'ระบบ', role: 'system' }, 'security.key_rotate', 'system', '-', msg,
      { records: mOut.length, logs: Math.max(lLast - 1, 0), failed: failed, resumed: resumed });
    Logger.log(msg);
    return msg;
  }, 30000);
}

function notDone_(cursor, last) {
  var msg = 'หมุนกุญแจยังไม่เสร็จ (ทำประวัติไปแล้วถึงแถว ' + (cursor - 1) + ' จาก ' + last + ') ' +
    'กรุณารัน rotateEncryptionKey() อีกครั้งเพื่อทำต่อ ระหว่างนี้ระบบยังใช้งานได้ตามปกติ';
  Logger.log(msg);
  return msg;
}
