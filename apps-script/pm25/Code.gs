/**
 * รายงานค่าฝุ่น PM2.5 จังหวัดบุรีรัมย์ (แผนที่รายอำเภอ + สถานีตรวจวัด) และจังหวัดใกล้เคียง
 *
 * ตั้งค่าที่ Project Settings > Script properties ก่อนใช้งาน
 * (ไม่เก็บไว้ในโค้ด เพื่อไม่ให้ ID ไฟล์และอีเมลหลุดออกไปพร้อมซอร์สโค้ด):
 *   SPREADSHEET_ID  ID ของ Google Sheets ที่ใช้บันทึกข้อมูล
 *   SLIDE_ID        ID ของ Google Slides ต้นแบบแผนที่ ถ้าไม่ตั้งค่าจะไม่สร้างรูปแผนที่
 *   FOLDER_ID       ID ของโฟลเดอร์ Google Drive ที่เก็บรูปแผนที่ ถ้าไม่ตั้งค่าจะเก็บที่ My Drive
 *   NOTIFY_EMAIL    อีเมลผู้รับรายงาน (หลายคนคั่นด้วย ,) ถ้าไม่ตั้งค่าจะไม่ส่งอีเมล
 */

const TIME_ZONE = "Asia/Bangkok"
const THAI_MONTHS = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"]
const NO_DATA_TEXT = "ไม่มีข้อมูล"

const GISTDA_AMPHOE_URL = "https://pm25.gistda.or.th/rest/getPm25byAmphoePred3?pv_idn=31"
const AIR4THAI_URL = "https://air4thai.pcd.go.th/services/getNewAQI_JSON.php?stationID="

// sheet = ลำดับชีต (0 = ชีตแรก) หรือชื่อชีต
// แนะนำให้เปลี่ยนเป็นชื่อชีต เพื่อไม่ให้ข้อมูลลงผิดชีตเมื่อมีการสลับลำดับแท็บ
const STATION_BR = { stationId: "101t", province: "บุรีรัมย์", sheet: 2 }
const OTHER_STATIONS = [
  { stationId: "47t", province: "นครราชสีมา", sheet: 0 },
  { stationId: "108t", province: "ชัยภูมิ", sheet: 1 },
  { stationId: "111t", province: "สุรินทร์", sheet: 3 },
]

// ชื่ออำเภอจาก GISTDA -> [objectId ของรูปอำเภอบนสไลด์, ข้อความที่จะแทนที่ด้วยค่า PM2.5]
const AMPHOE_SHAPES = {
  "นาโพธิ์": ["g2d5fc68aed0_1_169", "{1}"],
  "บ้านใหม่ไชยพจน์": ["g2d5fc68aed0_1_168", "{2}"],
  "พุทไธสง": ["g2d5fc68aed0_1_170", "{3}"],
  "คูเมือง": ["g2d5fc68aed0_1_171", "{4}"],
  "แคนดง": ["g2d5fc68aed0_1_172", "{5}"],
  "สตึก": ["g2d5fc68aed0_1_173", "{6}"],
  "บ้านด่าน": ["g2d5fc68aed0_1_189", "{7}"],
  "ลำปลายมาศ": ["g2d5fc68aed0_1_167", "{8}"],
  "เมืองบุรีรัมย์": ["g2d5fc68aed0_1_176", "{9}"],
  "ห้วยราช": ["g2d5fc68aed0_1_174", "{10}"],
  "กระสัง": ["g2d5fc68aed0_1_175", "{11}"],
  "หนองหงส์": ["g2d5fc68aed0_1_183", "{12}"],
  "ชำนิ": ["g2d5fc68aed0_1_187", "{13}"],
  "พลับพลาชัย": ["g2d5fc68aed0_1_177", "{14}"],
  "หนองกี่": ["g2d5fc68aed0_1_184", "{15}"],
  "โนนสุวรรณ": ["g2d5fc68aed0_1_185", "{16}"],
  "นางรอง": ["g2d5fc68aed0_1_186", "{17}"],
  "เฉลิมพระเกียรติ": ["g2d5fc68aed0_1_188", "{18}"],
  "ประโคนชัย": ["g2d5fc68aed0_1_178", "{19}"],
  "ปะคำ": ["g2d5fc68aed0_1_182", "{20}"],
  "โนนดินแดง": ["g2d5fc68aed0_1_181", "{21}"],
  "ละหานทราย": ["g2d5fc68aed0_1_180", "{22}"],
  "บ้านกรวด": ["g2d5fc68aed0_1_179", "{23}"],
}
// ค่าจากสถานีตรวจวัดบุรีรัมย์ (air4thai)
const STATION_SHAPE = ["g323bf7bfd42_0_0", "{pm25}"]

function getDataPM25() {
  // กันไม่ให้ trigger ทำงานซ้อนกันจนได้แถวและอีเมลซ้ำ
  const lock = LockService.getScriptLock()
  if (!lock.tryLock(10 * 1000)) {
    console.warn("การทำงานรอบก่อนหน้ายังไม่เสร็จ ข้ามรอบนี้")
    return
  }

  const errors = []
  const attempt = (label, fn) => {
    try {
      return fn()
    }
    catch (error) {
      console.error(label + ": " + (error && error.stack ? error.stack : error))
      errors.push(label + ": " + (error && error.message ? error.message : error))
      return null
    }
  }

  try {
    const config = getConfig_()
    const spreadsheet = SpreadsheetApp.openById(config.spreadsheetId)
    const now = new Date()

    // dataBR
    const amphoe = attempt("GISTDA รายอำเภอ", fetchAmphoePM25_) || []
    const br = attempt("air4thai " + STATION_BR.stationId, () => fetchStation_(STATION_BR))
    if (amphoe.length || br) {
      const imageUrl = attempt("สร้างรูปแผนที่", () => createMapImage_(config, amphoe, br, now))
      attempt("บันทึกชีตบุรีรัมย์", () => appendRowSafe_(getSheet_(spreadsheet, STATION_BR.sheet), buriramRow_(br, imageUrl, now)))
      attempt("ส่งอีเมล", () => sendReportMail_(config, br, imageUrl, now))
    }
    else {
      console.warn("ไม่มีข้อมูล PM2.5 ของบุรีรัมย์ ข้ามการสร้างแผนที่")
    }
    // dataBR

    // dataNM, dataCY, dataSR
    OTHER_STATIONS.forEach(station => attempt("air4thai " + station.stationId, () => {
      const data = fetchStation_(station)
      if (data) appendRowSafe_(getSheet_(spreadsheet, station.sheet), stationRow_(data))
    }))
  }
  finally {
    lock.releaseLock()
  }

  // ให้การทำงานขึ้นสถานะล้มเหลว (และ trigger แจ้งเตือนเจ้าของสคริปต์) แทนการกลืน error เงียบ ๆ
  if (errors.length) throw new Error("ทำงานไม่สำเร็จ " + errors.length + " รายการ:\n" + errors.join("\n"))
}

function getConfig_() {
  const props = PropertiesService.getScriptProperties()
  const required = key => {
    const value = (props.getProperty(key) || "").trim()
    if (!value) throw new Error("ยังไม่ได้ตั้งค่า Script property: " + key)
    return value
  }
  return {
    spreadsheetId: required("SPREADSHEET_ID"),
    slideId: (props.getProperty("SLIDE_ID") || "").trim(),
    folderId: (props.getProperty("FOLDER_ID") || "").trim(),
    notifyEmail: (props.getProperty("NOTIFY_EMAIL") || "").trim(),
  }
}

function fetchJson_(url) {
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true })
  const code = response.getResponseCode()
  if (code !== 200) throw new Error("HTTP " + code + " จาก " + url)
  return JSON.parse(response.getContentText())
}

// แปลงค่าจาก API เป็นตัวเลข ค่าว่าง, "N/A" หรือค่าติดลบ (air4thai ใช้ -1 แทนไม่มีข้อมูล) คืนค่า null
function toPM25_(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null
  const number = Number(value)
  return isFinite(number) && number >= 0 ? number : null
}

function fetchAmphoePM25_() {
  const json = fetchJson_(GISTDA_AMPHOE_URL)
  if (!json || !Array.isArray(json.data)) throw new Error("รูปแบบข้อมูลจาก GISTDA ไม่ถูกต้อง")

  const result = []
  json.data.forEach(row => {
    const name = row && row.ap_tn ? String(row.ap_tn).trim() : ""
    const pm25 = toPM25_(row && row.pm25Avg24hr)
    // ข้ามเฉพาะแถวที่ข้อมูลไม่ครบ ไม่ให้แถวเดียวทำให้อำเภอที่เหลือหายทั้งหมด
    if (!name || pm25 === null) {
      console.warn("ข้ามข้อมูลอำเภอที่ไม่สมบูรณ์: " + JSON.stringify(row))
      return
    }
    const text = pm25.toFixed(1)
    result.push({ name, value: Number(text), text })
  })
  console.log("GISTDA: " + result.map(r => r.name + "=" + r.text).join(", "))
  return result
}

// คืนค่า null ถ้าสถานีไม่มีข้อมูล PM2.5 ในชั่วโมงล่าสุด
function fetchStation_(station) {
  const json = fetchJson_(AIR4THAI_URL + encodeURIComponent(station.stationId))
  const last = json && json.AQILast
  if (!last || !last.PM25) throw new Error("รูปแบบข้อมูลจาก air4thai ไม่ถูกต้อง")

  const pm25 = toPM25_(last.PM25.value)
  if (pm25 === null) {
    console.warn("สถานี " + station.stationId + " ไม่มีข้อมูล PM2.5 (value = " + last.PM25.value + ")")
    return null
  }

  const detail = detail_(pm25)
  const fullDate = thaiDate_(last.date)
  const time = String(last.time || "")
  const location = [json.nameTH, json.areaTH].filter(Boolean).join(" ")
  const people = detail.getPeopleRegular + detail.getPeopleRisk
  const message = "วันที่ " + fullDate + " เวลา " + time + " น." + "\n\n" +
    "จังหวัด" + station.province + " (" + location + ")" + "\n\n" +
    "PM2.5 = " + pm25 + " ไมโครกรัมต่อลูกบาศก์เมตร (µg/m³)" + "\n\n" +
    detail.getLevel + "(" + detail.getDescription + ")" + "\n\n" + people
  console.log(message)

  return { date: last.date, time, location, pm25, detail, people, fullDate, message }
}

function stationRow_(data) {
  return [data.date, data.time, data.location, data.pm25, data.detail.getLevel, data.detail.getDescription, data.people, data.fullDate, data.message]
}

function buriramRow_(br, imageUrl, now) {
  if (br) return stationRow_(br).concat(imageUrl || "")
  // สถานีไม่มีข้อมูล แต่ยังบันทึกลิงก์แผนที่รายอำเภอไว้
  return [
    Utilities.formatDate(now, TIME_ZONE, "yyyy-MM-dd"), Utilities.formatDate(now, TIME_ZONE, "HH:mm"),
    "", "", NO_DATA_TEXT + "จากสถานีตรวจวัด", "", "", thaiDate_(now), "", imageUrl || "",
  ]
}

function createMapImage_(config, amphoe, br, now) {
  if (!config.slideId) {
    console.warn("ไม่ได้ตั้งค่า SLIDE_ID ข้ามการสร้างรูปแผนที่")
    return
  }

  const year = Number(Utilities.formatDate(now, TIME_ZONE, "yyyy")) + 543
  const name = Utilities.formatDate(now, TIME_ZONE, "d/M/") + year + Utilities.formatDate(now, TIME_ZONE, " HH:mm:ss")
  const copy = DriveApp.getFileById(config.slideId).makeCopy(name)

  try {
    const presentation = SlidesApp.openById(copy.getId())
    const slide = presentation.getSlides()[0]
    const pageId = slide.getObjectId()
    const shapes = {}
    slide.getShapes().forEach(shape => { shapes[shape.getObjectId()] = shape })

    const paint = (target, value, text) => {
      const shape = shapes[target[0]]
      if (shape) shape.getFill().setSolidFill(detail_(value).color)
      else console.warn("ไม่พบรูป " + target[0] + " บนสไลด์ต้นแบบ")
      slide.replaceAllText(target[1], text)
    }

    amphoe.forEach(item => {
      const target = AMPHOE_SHAPES[item.name]
      if (target) paint(target, item.value, item.text)
      else console.warn("ไม่พบอำเภอ \"" + item.name + "\" บนแผนที่")
    })
    if (br) paint(STATION_SHAPE, br.pm25, String(br.pm25))

    // ช่องที่ไม่ได้รับข้อมูล ไม่ให้เหลือ {n} ค้างอยู่บนรูป
    Object.keys(AMPHOE_SHAPES).map(key => AMPHOE_SHAPES[key]).concat([STATION_SHAPE])
      .forEach(target => slide.replaceAllText(target[1], "-"))

    slide.replaceAllText("{date}", thaiDate_(now))
    slide.replaceAllText("{time}", Utilities.formatDate(now, TIME_ZONE, "HH:mm"))

    presentation.saveAndClose()

    const response = UrlFetchApp.fetch(
      "https://docs.google.com/presentation/d/" + copy.getId() + "/export/jpeg?id=" + copy.getId() + "&pageid=" + encodeURIComponent(pageId),
      { headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() }, muteHttpExceptions: true }
    )
    if (response.getResponseCode() !== 200) throw new Error("ส่งออกรูปแผนที่ไม่สำเร็จ HTTP " + response.getResponseCode())

    const file = config.folderId ? DriveApp.getFolderById(config.folderId).createFile(response.getAs("image/jpeg").setName(name + ".jpg")) : DriveApp.createFile(response.getAs("image/jpeg").setName(name + ".jpg"))
    try {
      // ANYONE_WITH_LINK: ดูได้เฉพาะคนที่มีลิงก์ ไม่ถูกค้นเจอแบบ ANYONE
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW)
    }
    catch (error) {
      console.warn("ตั้งค่าแชร์รูปแผนที่ไม่ได้ (โดเมนอาจไม่อนุญาต): " + error.message)
    }
    console.log("แผนที่: " + file.getUrl())
    return file.getUrl()
  }
  finally {
    // ลบสำเนาสไลด์ทุกครั้ง แม้ขั้นตอนก่อนหน้าจะล้มเหลว
    // ห้าม throw จาก finally เพราะจะทับลิงก์รูปที่สร้างเสร็จแล้ว หรือทับ error จริงของขั้นตอนก่อนหน้า
    try {
      copy.setTrashed(true)
    }
    catch (error) {
      console.error("ลบสำเนาสไลด์ " + copy.getId() + " ไม่ได้: " + (error && error.stack ? error.stack : error))
    }
  }
}

function sendReportMail_(config, br, imageUrl, now) {
  if (!config.notifyEmail) {
    console.warn("ไม่ได้ตั้งค่า NOTIFY_EMAIL ข้ามการส่งอีเมล")
    return
  }

  const fullDate = br ? br.fullDate : thaiDate_(now)
  let htmlBody, body
  if (br) {
    htmlBody = "วันที่ " + escapeHtml_(fullDate) + " เวลา " + escapeHtml_(br.time) + " น." + "<br><br>" +
      "จังหวัดบุรีรัมย์ (" + escapeHtml_(br.location) + ")" + "<br><br>" +
      "PM2.5 = " + escapeHtml_(br.pm25) + " ไมโครกรัมต่อลูกบาศก์เมตร (µg/m³)" + "<br><br>" +
      escapeHtml_(br.detail.getLevel) + "(" + escapeHtml_(br.detail.getDescription) + ")" + "<br><br>" +
      escapeHtml_(br.people).replace(/\n/g, "<br>")
    body = br.message
  }
  else {
    htmlBody = "วันที่ " + escapeHtml_(fullDate) + "<br><br>สถานีตรวจวัดจังหวัดบุรีรัมย์" + NO_DATA_TEXT + " PM2.5"
    body = "วันที่ " + fullDate + "\n\nสถานีตรวจวัดจังหวัดบุรีรัมย์" + NO_DATA_TEXT + " PM2.5"
  }
  if (imageUrl) {
    htmlBody += "<br><br><a href=\"" + escapeHtml_(imageUrl) + "\">" + escapeHtml_(imageUrl) + "</a>"
    body += "\n\n" + imageUrl
  }

  MailApp.sendEmail({ to: config.notifyEmail, subject: "PM2.5 วันที่ " + fullDate, body, htmlBody })
}

function getSheet_(spreadsheet, ref) {
  const sheet = typeof ref === "number" ? spreadsheet.getSheets()[ref] : spreadsheet.getSheetByName(ref)
  if (!sheet) throw new Error("ไม่พบชีต: " + ref)
  return sheet
}

// กัน formula injection: ข้อความจาก API ที่ขึ้นต้นด้วย = + - @ จะไม่ถูกตีความเป็นสูตร
function appendRowSafe_(sheet, row) {
  sheet.appendRow(row.map(value => typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? "'" + value : value))
}

function escapeHtml_(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }
  return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, c => entities[c])
}

// รับ Date หรือข้อความ "yyyy-MM-dd" คืนค่าเช่น "6 ตุลาคม 2569"
// อ่านตัวเลขจากข้อความตรง ๆ เพราะ new Date("yyyy-MM-dd") ตีความเป็นเวลา UTC ทำให้วันที่เพี้ยนได้ตาม time zone ของสคริปต์
function thaiDate_(value) {
  const text = value instanceof Date ? Utilities.formatDate(value, TIME_ZONE, "yyyy-MM-dd") : String(value || "")
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text)
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return text
  return Number(match[3]) + " " + THAI_MONTHS[Number(match[2]) - 1] + " " + (Number(match[1]) + 543)
}

// เกณฑ์เดียวกันทั้งข้อความและสีบนแผนที่
function detail_(pm25) {
  let getLevel = "", getDescription = "", getPeopleRegular = "", getPeopleRisk = "", color = ""
  if(pm25 > 75.0){
    color = "#ff0000"
    getLevel = "คุณภาพอากาศอยู่ในเกณฑ์มีผลกระทบต่อสุขภาพ (สีแดง)"
    getDescription = "75.1 ไมโครกรัมต่อลูกบาศก์เมตร (µg/m³) ขึ้นไป"
    getPeopleRegular = "ประชาชนทุกคน\n - งดกิจกรรมกลางแจ้ง\n - หากมีความจำเป็นต้องทำกิจกรรมกลางแจ้งให้ใช้อุปกรณ์ป้องกันตนเองทุกครั้ง เช่น หน้ากากป้องกัน PM2.5\n - หากมีอาการผิดปกติให้รีบไปพบแพทย์\n - ผู้ที่มีโรคประจำตัว ควรอยู่ในพื้นที่ปลอดภัยจากมลพิษทางอากาศ ให้เตรียมยาและอุปกรณ์ที่จำเป็นให้พร้อมและปฏิบัติตามคำแนะนำของแพทย์อย่างเคร่งครัด"
    getPeopleRisk = ""
  }
  else if(pm25 > 37.5){
    color = "#ff6600"
    getLevel = "คุณภาพอากาศอยู่ในเกณฑ์เริ่มมีผลกระทบต่อสุขภาพ (สีส้ม)"
    getDescription = "37.6 - 75.0 ไมโครกรัมต่อลูกบาศก์เมตร (µg/m³)"
    getPeopleRegular = "ประชาชนทั่วไป :\n - ใช้อุปกรณ์ป้องกันตนเอง เช่น หน้ากากป้องกัน PM2.5 ทุกครั้งที่ออกนอกอาคาร\n - จำกัดระยะเวลาในการทำกิจกรรมหรือการออกกำลังกายกลางแจ้งที่ใช้แรงมาก\n - ควรสังเกตอาการผิดปกติ เช่น ไอ หายใจลำบาก ระคายเคืองตา\n\n"
    getPeopleRisk = "ประชาชนกลุ่มเสี่ยง :\n - ใช้อุปกรณ์ป้องกันตนเอง เช่น หน้ากากป้องกัน PM2.5 ทุกครั้งที่ออกนอกอาคาร\n - เลี่ยงการทำกิจกรรมหรือการออกกำลังกายกลางแจ้งที่ใช้แรงมาก\n - ให้ปฏิบัติตามคำแนะนำของแพทย์ หากมีอาการผิดปกติให้รีบไปพบแพทย์"
  }
  else if(pm25 > 25.0){
    color = "#ffff00"
    getLevel = "คุณภาพอากาศอยู่ในเกณฑ์ปานกลาง (สีเหลือง)"
    getDescription = "25.1 - 37.5 ไมโครกรัมต่อลูกบาศก์เมตร (µg/m³)"
    getPeopleRegular = "ประชาชนทั่วไป :\n ลดระยะเวลาการทำกิจกรรมหรือการออกกำลังกายกลางแจ้งที่ใช้แรงมาก\n\n"
    getPeopleRisk = "ประชาชนกลุ่มเสี่ยง :\n - ใช้อุปกรณ์ป้องกันตนเอง เช่น หน้ากากป้องกัน PM2.5 ทุกครั้ง ที่ออกนอกอาคาร\n - ลดระยะเวลาการทำกิจกรรมหรือการออกกำลังกายกลางแจ้งที่ใช้แรงมาก\n - หากมีอาการผิดปกติให้รีบปรึกษาแพทย์"
  }
  else if(pm25 > 15.0){
    color = "#548135"
    getLevel = "คุณภาพอากาศอยู่ในเกณฑ์ดี (สีเขียว)"
    getDescription = "15.1 - 25.0 ไมโครกรัมต่อลูกบาศก์เมตร (µg/m³)"
    getPeopleRegular = "ประชาชนทั่วไป :\n สามารถทำกิจกรรมกลางแจ้งได้ตามปกติ\n\n"
    getPeopleRisk = "ประชาชนกลุ่มเสี่ยง :\n ควรสังเกตอาการผิดปกติ เช่น ไอบ่อย หายใจลำบาก หายใจถี่ หายใจไม่ออก หายใจมีเสียงวี้ด แน่นหน้าอก เจ็บหน้าอก ใจสั่น คลื่นไส้ เมื่อยล้าผิดปกติ หรือ วิงเวียนศีรษะ"
  }
  else {
    color = "#3bacf4"
    getLevel = "คุณภาพอากาศอยู่ในเกณฑ์ดีมาก (สีฟ้า)"
    getDescription = "0 - 15.0 ไมโครกรัมต่อลูกบาศก์เมตร (µg/m³)"
    getPeopleRegular = "ประชาชนทุกคนสามารถดำเนินชีวิตได้ตามปกติ"
    getPeopleRisk = ""
  }
  return { pm25, getLevel, getDescription, getPeopleRegular, getPeopleRisk, color }
}
