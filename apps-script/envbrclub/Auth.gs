/*************************************************************
 * Auth.gs : บัญชีผู้ดูแล / การเข้าสู่ระบบ / เซสชัน / สิทธิ์
 *
 * สิทธิ์การใช้งาน
 *   superadmin : ทุกอย่าง + จัดการบัญชีผู้ดูแล + ตั้งค่า + ส่งออกข้อมูลเต็ม + ลบถาวร
 *   admin      : เพิ่ม/แก้ไข/อนุมัติสมาชิก, พิมพ์บัตร, ส่งออกแบบปกปิดเลขบัตรประชาชน
 *   viewer     : ดูรายชื่อและสถานะเท่านั้น (ไม่เห็นเลขบัตรประชาชน)
 *************************************************************/

/* ---------- สร้าง/แก้ไขบัญชี ---------- */
function createAdminRecord_(username, displayName, email, role, password, mustChange) {
  var h = hashPassword_(password);
  appendRow_(SHEETS.ADMINS, ADMIN_COLS, {
    username: String(username).toLowerCase().trim(),
    display_name: displayName,
    email: email || '',
    role: role,
    pw_hash: h.hash, pw_salt: h.salt, pw_iter: h.iter,
    status: 'active',
    must_change: mustChange ? 'yes' : 'no',
    created_at: now_(),
    last_login: '',
    fail_count: 0
  });
}

function findAdmin_(username) {
  var u = String(username || '').toLowerCase().trim();
  var rows = readTable_(SHEETS.ADMINS, ADMIN_COLS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].username).toLowerCase() === u) return rows[i];
  }
  return null;
}

/* ---------- นโยบายรหัสผ่าน ---------- */
function checkPasswordPolicy_(pw) {
  pw = String(pw || '');
  if (pw.length < 10) return 'รหัสผ่านต้องยาวอย่างน้อย 10 ตัวอักษร';
  if (!/[A-Za-zก-๙]/.test(pw)) return 'รหัสผ่านต้องมีตัวอักษรอย่างน้อย 1 ตัว';
  if (!/[0-9]/.test(pw)) return 'รหัสผ่านต้องมีตัวเลขอย่างน้อย 1 ตัว';
  if (/^(123456|password|admin|qwerty)/i.test(pw)) return 'รหัสผ่านนี้เดาง่ายเกินไป';
  return '';
}

/* ---------- เข้าสู่ระบบ ---------- */
function apiLogin(username, password, client) {
  // ตัดความยาวไว้ กันคนภายนอกส่งชื่อผู้ใช้ยาวมากเข้าไปเต็มบันทึกประวัติ
  var u = String(username || '').toLowerCase().trim().substring(0, 64);
  var cache = CacheService.getScriptCache();
  var failKey = 'FAIL:' + u;
  var fails = Number(cache.get(failKey) || 0);

  if (fails >= APP.MAX_LOGIN_FAIL) {
    writeLog_({ username: u, role: '-' }, 'auth.locked', 'admin', u,
      'บัญชีถูกล็อกชั่วคราวจากการกรอกรหัสผ่านผิดเกินกำหนด', {}, client);
    return { ok: false, error: 'กรอกรหัสผ่านผิดเกิน ' + APP.MAX_LOGIN_FAIL + ' ครั้ง บัญชีถูกล็อก ' + APP.LOCK_MINUTES + ' นาที' };
  }

  var a = findAdmin_(u);
  var ok = false;
  if (a && a.status === 'active') {
    ok = verifyPassword_(String(password || ''), a.pw_hash, a.pw_salt, a.pw_iter);
  } else {
    // คำนวณ PBKDF2 ทิ้งไว้ ให้เวลาตอบสนองเท่ากับกรณีมีบัญชีจริง ไม่ให้เดาได้ว่าชื่อผู้ใช้ไหนมีอยู่
    pbkdf2_(String(password || ''), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], CRYPTO_CFG.PBKDF2_ITER);
  }

  if (!ok) {
    cache.put(failKey, String(fails + 1), APP.LOCK_MINUTES * 60);
    writeLog_({ username: u || '(ไม่ระบุ)', role: '-' }, 'auth.fail', 'admin', u,
      'เข้าสู่ระบบไม่สำเร็จ (ครั้งที่ ' + (fails + 1) + ')', {}, client);
    Utilities.sleep(600); // หน่วงเพื่อชะลอการเดารหัสผ่าน
    return { ok: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
  }

  cache.remove(failKey);
  var sess = createSession_(a, client);
  updateRow_(SHEETS.ADMINS, ADMIN_COLS, a._row,
    Object.assign({}, a, { last_login: now_(), fail_count: 0 }));

  writeLog_(sess, 'auth.login', 'admin', a.username, 'เข้าสู่ระบบสำเร็จ', {}, client);
  return {
    ok: true, token: sess.token,
    me: { username: a.username, name: a.display_name, role: a.role, mustChange: a.must_change === 'yes' }
  };
}

function apiLogout(token) {
  try {
    var s = getSession_(token);
    if (s) {
      destroySession_(token);
      writeLog_(s, 'auth.logout', 'admin', s.username, 'ออกจากระบบ', {});
    }
  } catch (e) { }
  return { ok: true };
}

function apiWhoAmI(token) {
  var s = getSession_(token);
  if (!s) return { ok: false, error: 'เซสชันหมดอายุ' };
  return { ok: true, me: { username: s.username, name: s.display_name, role: s.role, mustChange: s.must_change === 'yes' } };
}

/* ---------- เซสชัน ---------- */
function createSession_(admin, client) {
  var token = randomToken_(32);
  var hash = sha256b64_(token);
  var exp = new Date(new Date().getTime() + APP.SESSION_HOURS * 3600 * 1000);
  var mustChange = admin.must_change === 'yes' ? 'yes' : 'no';
  appendRow_(SHEETS.SESSIONS, SESSION_COLS, {
    token_hash: hash, username: admin.username, role: admin.role,
    display_name: admin.display_name, created_at: now_(),
    expire_at: fmtDateTime_(exp), client: String(client || '').substring(0, 200),
    must_change: mustChange
  });
  var payload = { username: admin.username, role: admin.role, display_name: admin.display_name,
    expire_at: fmtDateTime_(exp), must_change: mustChange };
  CacheService.getScriptCache().put('SESS:' + hash, JSON.stringify(payload), 21600);
  payload.token = token;
  return payload;
}

function getSession_(token) {
  if (!token) return null;
  var hash = sha256b64_(token);
  var cache = CacheService.getScriptCache();
  var raw = cache.get('SESS:' + hash);
  var s = null;
  if (raw) {
    s = JSON.parse(raw);
  } else {
    var rows = readTable_(SHEETS.SESSIONS, SESSION_COLS);
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].token_hash === hash) {
        s = { username: rows[i].username, role: rows[i].role, display_name: rows[i].display_name,
          expire_at: rows[i].expire_at, must_change: rows[i].must_change === 'no' ? 'no' : 'yes' };
        break;
      }
    }
    if (s) cache.put('SESS:' + hash, JSON.stringify(s), 3600);
  }
  if (!s) return null;
  if (String(s.expire_at) < now_()) { destroySession_(token); return null; }
  return s;
}

function destroySession_(token) {
  var hash = sha256b64_(token);
  CacheService.getScriptCache().remove('SESS:' + hash);
  withScriptLock_(function () {
    var sh = sheet_(SHEETS.SESSIONS);
    var rows = readTable_(SHEETS.SESSIONS, SESSION_COLS);
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].token_hash === hash) { sh.deleteRow(rows[i]._row); break; }
    }
  });
}

/** ยกเลิกทุกเซสชันของผู้ใช้ (เมื่อถูกระงับ เปลี่ยนสิทธิ์ หรือเปลี่ยนรหัสผ่าน) ยกเว้นเซสชัน keepHash */
function destroyUserSessions_(username, keepHash) {
  var u = String(username || '').toLowerCase();
  var cache = CacheService.getScriptCache();
  withScriptLock_(function () {
    var sh = sheet_(SHEETS.SESSIONS);
    var rows = readTable_(SHEETS.SESSIONS, SESSION_COLS);
    for (var i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i].username).toLowerCase() === u && rows[i].token_hash !== keepHash) {
        cache.remove('SESS:' + rows[i].token_hash);
        sh.deleteRow(rows[i]._row);
      }
    }
  });
}

/** ปลดสถานะ "ต้องเปลี่ยนรหัสผ่าน" ของเซสชันปัจจุบัน หลังเปลี่ยนรหัสผ่านสำเร็จ */
function clearSessionMustChange_(token) {
  var hash = sha256b64_(token);
  var cache = CacheService.getScriptCache();
  var raw = cache.get('SESS:' + hash);
  if (raw) {
    var s = JSON.parse(raw);
    s.must_change = 'no';
    cache.put('SESS:' + hash, JSON.stringify(s), 21600);
  }
  withScriptLock_(function () {
    var sh = sheet_(SHEETS.SESSIONS);
    var rows = readTable_(SHEETS.SESSIONS, SESSION_COLS);
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i].token_hash === hash) {
        sh.getRange(rows[i]._row, SESSION_COLS.indexOf('must_change') + 1).setValue('no');
        break;
      }
    }
  });
}

function cleanupSessions_() {
  withScriptLock_(function () {
    var sh = sheet_(SHEETS.SESSIONS);
    var rows = readTable_(SHEETS.SESSIONS, SESSION_COLS);
    var t = now_();
    for (var i = rows.length - 1; i >= 0; i--) {
      if (String(rows[i].expire_at) < t) sh.deleteRow(rows[i]._row);
    }
  });
}

/* ---------- ตรวจสิทธิ์ ---------- */
/** allowMustChange : ใช้เฉพาะการเปลี่ยนรหัสผ่าน ฟังก์ชันอื่นถูกปิดจนกว่าจะเปลี่ยนรหัสผ่านเริ่มต้น */
function requireAuth_(token, allowMustChange) {
  var s = getSession_(token);
  if (!s) throw new Error('AUTH:เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  if (s.must_change === 'yes' && !allowMustChange) {
    throw new Error('PWCHANGE:กรุณาเปลี่ยนรหัสผ่านก่อนใช้งานระบบ');
  }
  return s;
}

function requireRole_(token, roles) {
  var s = requireAuth_(token);
  if (roles.indexOf(s.role) < 0) throw new Error('PERM:บัญชีของคุณไม่มีสิทธิ์ดำเนินการนี้');
  return s;
}

function canSeeSensitive_(role) { return role === 'superadmin' || role === 'admin'; }

/* ---------- เปลี่ยนรหัสผ่าน ---------- */
function apiChangePassword(token, oldPw, newPw) {
  var s = requireAuth_(token, true);
  var a = findAdmin_(s.username);
  if (!a) return { ok: false, error: 'ไม่พบบัญชีผู้ใช้' };
  if (!verifyPassword_(String(oldPw || ''), a.pw_hash, a.pw_salt, a.pw_iter)) {
    writeLog_(s, 'auth.pwchange_fail', 'admin', a.username, 'เปลี่ยนรหัสผ่านไม่สำเร็จ (รหัสเดิมไม่ถูกต้อง)', {});
    return { ok: false, error: 'รหัสผ่านเดิมไม่ถูกต้อง' };
  }
  var err = checkPasswordPolicy_(newPw);
  if (err) return { ok: false, error: err };

  if (String(newPw) === String(oldPw || '')) return { ok: false, error: 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม' };

  var h = hashPassword_(newPw);
  updateRow_(SHEETS.ADMINS, ADMIN_COLS, a._row, Object.assign({}, a, {
    pw_hash: h.hash, pw_salt: h.salt, pw_iter: h.iter, must_change: 'no'
  }));
  // เซสชันอื่นที่ใช้รหัสผ่านเดิมถูกยกเลิก เหลือเฉพาะเซสชันที่ใช้เปลี่ยนรหัสผ่าน
  destroyUserSessions_(a.username, sha256b64_(token));
  clearSessionMustChange_(token);
  writeLog_(s, 'auth.pwchange', 'admin', a.username, 'เปลี่ยนรหัสผ่านสำเร็จ', {});
  return { ok: true };
}

/* ---------- จัดการบัญชีผู้ดูแล (เฉพาะ superadmin) ---------- */
function apiListAdmins(token) {
  requireRole_(token, ['superadmin']);
  var rows = readTable_(SHEETS.ADMINS, ADMIN_COLS);
  return {
    ok: true,
    admins: rows.map(function (r) {
      return {
        username: r.username, display_name: r.display_name, email: r.email, role: r.role,
        status: r.status, must_change: r.must_change, created_at: r.created_at, last_login: r.last_login
      };
    })
  };
}

function apiCreateAdmin(token, data) {
  var s = requireRole_(token, ['superadmin']);
  var u = String(data.username || '').toLowerCase().trim();
  if (!/^[a-z0-9._-]{4,32}$/.test(u)) return { ok: false, error: 'ชื่อผู้ใช้ต้องเป็น a-z 0-9 . _ - ยาว 4-32 ตัว' };
  if (findAdmin_(u)) return { ok: false, error: 'มีชื่อผู้ใช้นี้อยู่แล้ว' };
  if (['superadmin', 'admin', 'viewer'].indexOf(data.role) < 0) return { ok: false, error: 'ระดับสิทธิ์ไม่ถูกต้อง' };
  var err = checkPasswordPolicy_(data.password);
  if (err) return { ok: false, error: err };

  createAdminRecord_(u, String(data.display_name || u).substring(0, 120), String(data.email || '').substring(0, 120),
    data.role, data.password, true);
  writeLog_(s, 'admin.create', 'admin', u,
    'เพิ่มบัญชีผู้ดูแล ' + u + ' (สิทธิ์ ' + data.role + ')', { role: data.role, name: data.display_name });
  return { ok: true };
}

function apiUpdateAdmin(token, username, data) {
  var s = requireRole_(token, ['superadmin']);
  var a = findAdmin_(username);
  if (!a) return { ok: false, error: 'ไม่พบบัญชีผู้ใช้' };

  data = data || {};
  var changes = [];
  var next = Object.assign({}, a);
  var lastActiveSuper = a.role === 'superadmin' && a.status === 'active' && countSuperadmins_() <= 1;

  if (data.display_name !== undefined && data.display_name !== a.display_name) {
    next.display_name = String(data.display_name).substring(0, 120); changes.push('ชื่อผู้ใช้งาน');
  }
  if (data.email !== undefined && data.email !== a.email) {
    next.email = String(data.email).substring(0, 120); changes.push('อีเมล');
  }
  if (data.role && data.role !== a.role) {
    if (['superadmin', 'admin', 'viewer'].indexOf(data.role) < 0) return { ok: false, error: 'ระดับสิทธิ์ไม่ถูกต้อง' };
    if (lastActiveSuper) return { ok: false, error: 'ต้องมีผู้ดูแลสูงสุดอย่างน้อย 1 บัญชี' };
    next.role = data.role; changes.push('สิทธิ์: ' + a.role + ' → ' + data.role);
  }
  if (data.status && data.status !== a.status) {
    if (['active', 'disabled'].indexOf(data.status) < 0) return { ok: false, error: 'สถานะบัญชีไม่ถูกต้อง' };
    if (lastActiveSuper) return { ok: false, error: 'ต้องมีผู้ดูแลสูงสุดที่ใช้งานได้อย่างน้อย 1 บัญชี' };
    next.status = data.status; changes.push('สถานะ: ' + a.status + ' → ' + data.status);
  }
  if (data.password) {
    var err = checkPasswordPolicy_(data.password);
    if (err) return { ok: false, error: err };
    var h = hashPassword_(data.password);
    next.pw_hash = h.hash; next.pw_salt = h.salt; next.pw_iter = h.iter; next.must_change = 'yes';
    changes.push('ตั้งรหัสผ่านใหม่');
    CacheService.getScriptCache().remove('FAIL:' + a.username);
  }
  if (!changes.length) return { ok: true, note: 'ไม่มีการเปลี่ยนแปลง' };

  updateRow_(SHEETS.ADMINS, ADMIN_COLS, a._row, next);
  // ระงับบัญชี เปลี่ยนสิทธิ์ หรือตั้งรหัสผ่านใหม่ ต้องมีผลทันที ไม่รอเซสชันเดิมหมดอายุ (สูงสุด 6 ชั่วโมง)
  if (next.status !== a.status || next.role !== a.role || data.password) destroyUserSessions_(a.username);
  writeLog_(s, 'admin.update', 'admin', a.username,
    'แก้ไขบัญชีผู้ดูแล ' + a.username + ' : ' + changes.join(', '), { changes: changes });
  return { ok: true };
}

function countSuperadmins_() {
  return readTable_(SHEETS.ADMINS, ADMIN_COLS).filter(function (r) {
    return r.role === 'superadmin' && r.status === 'active';
  }).length;
}

/** ใช้กรณีลืมรหัสผ่านทั้งระบบ : เรียกจากตัวแก้ไขสคริปต์เท่านั้น */
function resetSuperadminPassword() {
  var a = readTable_(SHEETS.ADMINS, ADMIN_COLS).filter(function (r) { return r.role === 'superadmin'; })[0];
  if (!a) throw new Error('ไม่พบบัญชีผู้ดูแลสูงสุด');
  var pw = tempPassword_();
  var h = hashPassword_(pw);
  updateRow_(SHEETS.ADMINS, ADMIN_COLS, a._row, Object.assign({}, a, {
    pw_hash: h.hash, pw_salt: h.salt, pw_iter: h.iter, must_change: 'yes', status: 'active'
  }));
  CacheService.getScriptCache().remove('FAIL:' + a.username);
  destroyUserSessions_(a.username);
  writeLog_({ username: 'ระบบ', role: 'system' }, 'admin.reset_pw', 'admin', a.username,
    'ตั้งรหัสผ่านใหม่จากตัวแก้ไขสคริปต์', {});
  var msg = 'ชื่อผู้ใช้ : ' + a.username + '\nรหัสผ่านใหม่ : ' + pw;
  Logger.log(msg);
  return msg;
}
