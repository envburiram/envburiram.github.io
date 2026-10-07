/**
 * LINE bot บันทึกไฟล์ที่ส่งเข้ามาในแชตลง Google Drive แล้วตอบกลับด้วยลิงก์
 *
 * ตั้งค่าที่ Project Settings > Script properties ก่อนใช้งาน
 * (ห้ามเขียน token ไว้ในโค้ด เพราะใครเห็นซอร์สโค้ดก็สั่งบอทแทนเราได้):
 *   CHANNEL_TOKEN       Channel access token ของ LINE Messaging API
 *   WEBHOOK_KEY         รหัสลับสำหรับต่อท้าย Webhook URL (?key=...) รัน setupWebhookKey เพื่อสร้าง
 *   FOLDER_ID           ID ของโฟลเดอร์ Google Drive ที่เก็บไฟล์ ถ้าไม่ตั้งค่าจะเก็บที่ My Drive
 *   ALLOWED_SOURCE_IDS  (ไม่บังคับ) userId / groupId / roomId ที่อนุญาต คั่นด้วย , ถ้าไม่ตั้งค่าจะรับไฟล์จากทุกคน
 */

const LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply"
const LINE_CONTENT_URL = "https://api-data.line.me/v2/bot/message/"
// UrlFetchApp รับข้อมูลได้ไม่เกิน 50 MB ต่อครั้ง
const MAX_FILE_SIZE = 50 * 1024 * 1024
// จำ message id ที่บันทึกแล้วไว้ 6 ชั่วโมง (ค่าสูงสุดของ CacheService)
const SEEN_MESSAGE_SECONDS = 6 * 60 * 60

// ชนิดข้อความที่บันทึกลง Drive ลบ // หน้าบรรทัดเพื่อเปิดใช้ชนิดอื่น
const SAVE_TYPES = {
  file: "📂 ชื่อไฟล์",
  // image: "🖼️ ไฟล์รูปภาพ",
  // video: "🎞️ ไฟล์วิดีโอ",
  // audio: "🔊 ไฟล์เสียง",
}
// นามสกุลไฟล์ตามชนิดข้อมูลที่ LINE ส่งมา ใช้เมื่อข้อความไม่มีชื่อไฟล์ (รูป วิดีโอ เสียง)
const EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/mpeg": ".mp3",
}

function doPost(e) {
  try {
    const config = getLineConfig_()
    // Apps Script อ่าน header X-Line-Signature ไม่ได้ จึงใช้รหัสลับใน URL ยืนยันว่าคำขอมาจาก LINE แทน
    if (!safeEqual_(e && e.parameter && e.parameter.key, config.webhookKey)) {
      console.warn("ปฏิเสธคำขอที่ไม่มี key หรือ key ไม่ถูกต้อง")
      return jsonOutput_({ content: "forbidden" })
    }

    const body = JSON.parse((e.postData && e.postData.contents) || "{}")
    // LINE ส่งหลาย event มาในคำขอเดียวได้ และส่ง events ว่างตอนกด Verify
    const events = body && Array.isArray(body.events) ? body.events : []
    events.forEach(event => {
      try {
        handleEvent_(config, event)
      }
      catch (error) {
        console.error("event " + (event && event.webhookEventId) + ": " + (error && error.stack ? error.stack : error))
      }
    })
  }
  catch (error) {
    console.error("doPost: " + (error && error.stack ? error.stack : error))
  }
  return jsonOutput_({ content: "post ok" })
}

function doGet() {
  return jsonOutput_({ content: "get ok" })
}

// รันครั้งเดียวจาก editor เพื่อสร้าง WEBHOOK_KEY แบบสุ่ม แล้วนำค่าที่ log ไปต่อท้าย Webhook URL
// ถ้าต้องการเปลี่ยน key ให้ลบ WEBHOOK_KEY ใน Script properties แล้วรันใหม่
function setupWebhookKey() {
  const props = PropertiesService.getScriptProperties()
  let key = (props.getProperty("WEBHOOK_KEY") || "").trim()
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, "")
    props.setProperty("WEBHOOK_KEY", key)
  }
  console.log("ต่อท้าย Webhook URL ใน LINE Developers ด้วย ?key=" + key)
}

function getLineConfig_() {
  const props = PropertiesService.getScriptProperties()
  const get = key => (props.getProperty(key) || "").trim()
  const required = key => {
    const value = get(key)
    if (!value) throw new Error("ยังไม่ได้ตั้งค่า Script property: " + key)
    return value
  }
  return {
    channelToken: required("CHANNEL_TOKEN"),
    webhookKey: required("WEBHOOK_KEY"),
    folderId: get("FOLDER_ID"),
    allowedSourceIds: get("ALLOWED_SOURCE_IDS").split(",").map(id => id.trim()).filter(Boolean),
  }
}

function handleEvent_(config, event) {
  const message = event && event.type === "message" ? event.message : null
  // follow, join, postback ฯลฯ ไม่มี message และข้อความชนิดอื่นไม่ต้องบันทึก
  if (!message || !Object.prototype.hasOwnProperty.call(SAVE_TYPES, message.type)) return
  if (!/^\w+$/.test(String(message.id || ""))) throw new Error("message id ไม่ถูกต้อง: " + message.id)

  if (!isAllowedSource_(config, event.source)) {
    console.warn("ข้ามไฟล์จากผู้ส่งที่ไม่ได้รับอนุญาต: " + JSON.stringify(event.source))
    return
  }
  if (!markFirstSeen_(message.id)) {
    console.warn("ข้ามข้อความ " + message.id + " ที่บันทึกไปแล้ว (LINE ส่งซ้ำ)")
    return
  }

  const fileName = String(message.fileName || "").trim()
  const target = fileName ? "ไฟล์ " + fileName + " " : "ไฟล์นี้"
  let text
  if (message.contentProvider && message.contentProvider.type === "external") {
    text = "ไฟล์นี้อยู่บนเซิร์ฟเวอร์ภายนอก LINE จึงบันทึกลง Google Drive ไม่ได้"
  }
  else if (Number(message.fileSize) > MAX_FILE_SIZE) {
    text = target + "มีขนาดเกิน 50 MB จึงบันทึกลง Google Drive ไม่ได้"
  }
  else {
    try {
      const file = saveToDrive_(config, message, fileName)
      text = SAVE_TYPES[message.type] + ": " + file.name + "\n.\nลิงก์ Google Drive:\n" + file.url
      if (!file.shared) text += "\n(ลิงก์นี้เปิดได้เฉพาะผู้ที่ได้รับสิทธิ์ในไฟล์)"
    }
    catch (error) {
      // ไม่ส่งรายละเอียด error เข้าแชต เพราะอาจเปิดเผยข้อมูลภายในของระบบ ดูรายละเอียดได้ที่ Executions
      console.error("บันทึกไฟล์ " + message.id + " ไม่สำเร็จ: " + (error && error.stack ? error.stack : error))
      text = "บันทึก" + target + "ลง Google Drive ไม่สำเร็จ กรุณาลองส่งใหม่อีกครั้ง"
    }
  }
  replyText_(config, event.replyToken, text)
}

function saveToDrive_(config, message, fileName) {
  const response = UrlFetchApp.fetch(LINE_CONTENT_URL + message.id + "/content", {
    headers: { Authorization: "Bearer " + config.channelToken },
    muteHttpExceptions: true,
  })
  const code = response.getResponseCode()
  if (code !== 200) throw new Error("ดึงไฟล์จาก LINE ไม่สำเร็จ HTTP " + code)

  const blob = response.getBlob()
  const contentType = String(blob.getContentType() || "").split(";")[0].trim().toLowerCase()
  const name = fileName || message.type + "_" + message.id + (EXTENSIONS[contentType] || "")
  const folder = config.folderId ? DriveApp.getFolderById(config.folderId) : DriveApp.getRootFolder()
  const file = folder.createFile(blob.setName(name))

  // แชร์แบบ "ผู้ที่มีลิงก์" ไม่ใช่ ANYONE ซึ่งเปิดให้คนทั่วไปค้นหาไฟล์เจอได้
  // ถ้าตั้งค่าแชร์ไม่ได้ (โดเมนไม่อนุญาต) ยังส่งลิงก์ให้ ไม่ทิ้งไฟล์ที่บันทึกแล้ว
  let shared = true
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW)
  }
  catch (error) {
    shared = false
    console.warn("ตั้งค่าแชร์ไฟล์ " + file.getId() + " ไม่ได้: " + error.message)
  }
  return { name, url: file.getUrl(), shared }
}

function replyText_(config, replyToken, text) {
  // event ที่ไม่มี reply token (เช่น channel อยู่ในโหมด standby) ตอบกลับไม่ได้
  if (!replyToken) return
  const response = UrlFetchApp.fetch(LINE_REPLY_URL, {
    method: "post",
    contentType: "application/json; charset=UTF-8",
    headers: { Authorization: "Bearer " + config.channelToken },
    payload: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
    muteHttpExceptions: true,
  })
  const code = response.getResponseCode()
  if (code !== 200) throw new Error("ตอบกลับ LINE ไม่สำเร็จ HTTP " + code + ": " + response.getContentText())
}

function isAllowedSource_(config, source) {
  if (!config.allowedSourceIds.length) return true
  const ids = source ? [source.userId, source.groupId, source.roomId] : []
  return ids.some(id => id && config.allowedSourceIds.indexOf(id) !== -1)
}

// กันบันทึกไฟล์ซ้ำเมื่อ LINE ส่ง event เดิมมาอีกครั้ง (redelivery) หรือมีคนส่งคำขอเดิมซ้ำ
function markFirstSeen_(messageId) {
  const cache = CacheService.getScriptCache()
  const key = "line-message-" + messageId
  if (cache.get(key)) return false
  cache.put(key, "1", SEEN_MESSAGE_SECONDS)
  return true
}

// เทียบรหัสลับโดยใช้เวลาเท่ากันทุกกรณี ไม่ให้เดา key จากเวลาตอบสนองได้
function safeEqual_(actual, expected) {
  const a = String(actual || ""), b = String(expected || "")
  let diff = a.length ^ b.length
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return b.length > 0 && diff === 0
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON)
}
