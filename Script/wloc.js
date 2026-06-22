// 拦截 Apple WLOC 网络定位响应，将经纬度替换为指定坐标。
//
// 结构顺序：注释 → VERSION → 配置 → 读参数 → Env → 主流程 → 工具函数
// （工具函数放最后，靠函数声明提升被主流程调用）

var VERSION = "1.0";

// ── 默认目标坐标（可在 App 的参数 UI 中覆盖）────────────────────
var TARGET_LONGITUDE = 112.562000;  // 经度（longitude）在前
var TARGET_LATITUDE  = 23.142000;   // 纬度（latitude）在后
var TARGET_ACCURACY  = 10;          // 定位精度（米），默认10，值越小系统越信任
var SPREAD_METERS    = 0;           // 多 Wi-Fi 散布半径基数(米)：0=不散布，>0 散开提升置信度
var NOTIFY           = true;        // 改坐标成功后是否发系统通知

// 参数：coordinate="经度,纬度"、accuracy="精度"、spread="散布米数"、notify=true/false
if (typeof $argument !== "undefined" && $argument) {
  if ($argument.coordinate) {
    var _c = String($argument.coordinate).replace(/，/g, ",").split(",");
    var _lon = parseFloat(_c[0]);
    var _lat = parseFloat(_c[1]);
    if (!isNaN(_lon)) TARGET_LONGITUDE = _lon;
    if (!isNaN(_lat)) TARGET_LATITUDE  = _lat;
  }
  var _acc = parseInt($argument.accuracy, 10);
  if (!isNaN(_acc)) TARGET_ACCURACY = _acc;
  var _spd = parseFloat($argument.spread);
  if (!isNaN(_spd)) SPREAD_METERS = _spd;
  if (typeof $argument.notify !== "undefined") NOTIFY = (String($argument.notify) !== "false");
}

// ============================================================
// 跨平台兼容层（Env 风格）：抹平 通知 / 结束回调 的差异
// ============================================================
var Env = {
  msg: function (title, subtitle, body) {
    try {
      if (typeof $notification !== "undefined" && $notification.post) $notification.post(title, subtitle, body);
      else if (typeof $notify !== "undefined") $notify(title, subtitle, body);
    } catch (e) {}
  },
  done: function (obj) {
    if (typeof $done !== "undefined") $done(obj || {});
  }
};

// ============================================================
// 主流程入口（只在 http-response 阶段改坐标；工具函数见文件末尾）
// ============================================================
if (!/gs-loc(-cn)?\.apple\.com\/clls\/wloc/.test($request.url || "") || typeof $response === "undefined") {
  Env.done({});
} else {
  var stats = { wifi: 0, cell: 0, locations: 0, skipped: 0 };
  var respHeaders = Object.assign({}, $response.headers || {});
  respHeaders["wloc-version"]       = "v" + VERSION;
  respHeaders["wloc-origin-status"] = String($response.status || "");

  try {
    var body = byteArray($response.body);
    respHeaders["wloc-input-len"] = String(body.length);

    var patched = patchFrame(body, stats);
    respHeaders["wloc-patched-locations"] = String(stats.locations);
    respHeaders["wloc-patched-wifi"]      = String(stats.wifi);
    respHeaders["wloc-patched-cell"]      = String(stats.cell);
    respHeaders["wloc-skipped"]           = String(stats.skipped);
    respHeaders["wloc-target"]            = TARGET_LONGITUDE + "," + TARGET_LATITUDE;
    delete respHeaders["Content-Encoding"];
    delete respHeaders["content-encoding"];

    if (NOTIFY && stats.locations > 0) {
      Env.msg(
        "定位成功",
        "经纬度 " + TARGET_LONGITUDE + "," + TARGET_LATITUDE,
        "精度 " + TARGET_ACCURACY + " 米 · 散布 " + SPREAD_METERS + " 米"
      );
    }

    Env.done({ status: 200, headers: respHeaders, body: new Uint8Array(patched) });
  } catch (err) {
    respHeaders["wloc-error"] = String(err && err.message ? err.message : err);
    Env.done({ headers: respHeaders });
  }
}

// ============================================================
// 工具函数区（protobuf 解析 + 改坐标）——函数声明提升，故可置于末尾
// ============================================================
function byteArray(v) {
  if (!v || typeof v.length !== "number") return [];
  var out = [];
  for (var i = 0; i < v.length; i++) out.push(v[i] & 255);
  return out;
}
function concat(parts) {
  var out = [];
  for (var i = 0; i < parts.length; i++)
    for (var j = 0; j < parts[i].length; j++)
      out.push(parts[i][j] & 255);
  return out;
}
function readVarint(data, offset) {
  var value = 0, mul = 1, shift = 0;
  while (offset < data.length) {
    var b = data[offset++] & 255;
    value += (b & 127) * mul;
    if ((b & 128) === 0) return [value, offset];
    mul *= 128; shift += 7;
    if (shift >= 56) throw new Error("varint too long at " + offset);
  }
  throw new Error("truncated varint");
}
function writeVarint(value) {
  var v = Math.floor(value), out = [];
  if (v < 0) throw new Error("negative varint");
  while (v >= 128) { out.push((v % 128) | 128); v = Math.floor(v / 128); }
  out.push(v);
  return out;
}
function skipValue(data, offset, wireType) {
  if (wireType === 0) return readVarint(data, offset)[1];
  if (wireType === 1) return offset + 8;
  if (wireType === 2) { var r = readVarint(data, offset); return r[1] + r[0]; }
  if (wireType === 5) return offset + 4;
  throw new Error("unsupported wire type " + wireType);
}
function parseFields(data) {
  var out = [], offset = 0;
  while (offset < data.length) {
    var start = offset;
    var tr = readVarint(data, offset); var tag = tr[0]; offset = tr[1];
    var fieldNo = Math.floor(tag / 8), wireType = tag & 7;
    if (fieldNo === 0) throw new Error("invalid protobuf field 0 at " + start);
    var valueStart = offset, value;
    if (wireType === 0) {
      var vr = readVarint(data, offset); value = vr[0]; offset = vr[1];
    } else if (wireType === 1) {
      offset = skipValue(data, offset, wireType); value = data.slice(valueStart, offset);
    } else if (wireType === 2) {
      var lr = readVarint(data, offset); var len = lr[0]; offset = lr[1];
      value = data.slice(offset, offset + len); offset += len;
    } else if (wireType === 5) {
      offset = skipValue(data, offset, wireType); value = data.slice(valueStart, offset);
    } else { throw new Error("unsupported wire type " + wireType); }
    out.push({ fieldNo: fieldNo, wireType: wireType, value: value, raw: data.slice(start, offset) });
  }
  return out;
}
function encodeField(fieldNo, wireType, value) {
  var head = writeVarint(fieldNo * 8 + wireType);
  if (wireType === 0) return concat([head, writeVarint(value)]);
  if (wireType === 1 || wireType === 5) return concat([head, value]);
  if (wireType === 2) return concat([head, writeVarint(value.length), value]);
  throw new Error("cannot encode wire type " + wireType);
}
function spreadOffset(i) {
  if (SPREAD_METERS <= 0 || i <= 0) return { dLat: 0, dLon: 0 };
  var golden = 2.399963229728653;
  var ang = i * golden;
  var r = SPREAD_METERS * Math.sqrt(i);
  var cosLat = Math.cos(TARGET_LATITUDE * Math.PI / 180) || 1;
  return {
    dLat: (r * Math.cos(ang)) / 111320,
    dLon: (r * Math.sin(ang)) / (111320 * cosLat)
  };
}
function patchLocationMessage(data, stats) {
  var fields = parseFields(data);
  var hasLat = false, hasLon = false;
  for (var i = 0; i < fields.length; i++) {
    if (fields[i].fieldNo === 1 && fields[i].wireType === 0) hasLat = true;
    if (fields[i].fieldNo === 2 && fields[i].wireType === 0) hasLon = true;
  }
  if (!hasLat || !hasLon) return data;
  var off = spreadOffset(stats.locations);
  var lat = TARGET_LATITUDE + off.dLat;
  var lon = TARGET_LONGITUDE + off.dLon;
  var parts = [];
  for (var j = 0; j < fields.length; j++) {
    var f = fields[j];
    if (f.fieldNo === 1 && f.wireType === 0)
      parts.push(encodeField(1, 0, Math.round(lat * 100000000)));
    else if (f.fieldNo === 2 && f.wireType === 0)
      parts.push(encodeField(2, 0, Math.round(lon * 100000000)));
    else if (f.fieldNo === 3 && f.wireType === 0)
      parts.push(encodeField(3, 0, TARGET_ACCURACY));
    else parts.push(f.raw);
  }
  stats.locations += 1;
  return concat(parts);
}
function patchWifiDevice(data, stats) {
  var fields = parseFields(data);
  var looksLikeWifi = false;
  for (var b = 0; b < fields.length; b++) {
    if (fields[b].fieldNo === 1 && fields[b].wireType === 2) {
      var s = "";
      for (var c = 0; c < fields[b].value.length; c++) s += String.fromCharCode(fields[b].value[c] & 255);
      looksLikeWifi = /^[0-9a-fA-F]{1,2}(:[0-9a-fA-F]{1,2}){5}$/.test(s);
    }
  }
  if (!looksLikeWifi) return data;
  var changed = false, parts = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.fieldNo === 2 && f.wireType === 2) {
      try {
        var pl = patchLocationMessage(f.value, stats);
        changed = changed || pl.length !== f.value.length || pl.join(",") !== f.value.join(",");
        parts.push(encodeField(f.fieldNo, f.wireType, pl));
      } catch (e) { stats.skipped += 1; parts.push(f.raw); }
    } else { parts.push(f.raw); }
  }
  if (changed) stats.wifi += 1;
  return concat(parts);
}
function patchCellTower(data, stats) {
  var fields = parseFields(data);
  var changed = false, parts = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.fieldNo === 5 && f.wireType === 2) {
      try {
        var pl = patchLocationMessage(f.value, stats);
        changed = changed || pl.length !== f.value.length || pl.join(",") !== f.value.join(",");
        parts.push(encodeField(f.fieldNo, f.wireType, pl));
      } catch (e) { stats.skipped += 1; parts.push(f.raw); }
    } else { parts.push(f.raw); }
  }
  if (changed) stats.cell += 1;
  return concat(parts);
}
function patchPayload(payload, stats) {
  var fields = parseFields(payload), parts = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.wireType === 2 && f.fieldNo === 2)
      parts.push(encodeField(f.fieldNo, f.wireType, patchWifiDevice(f.value, stats)));
    else if (f.wireType === 2 && (f.fieldNo === 22 || f.fieldNo === 24))
      parts.push(encodeField(f.fieldNo, f.wireType, patchCellTower(f.value, stats)));
    else parts.push(f.raw);
  }
  return concat(parts);
}
function patchFrame(body, stats) {
  if (body.length < 10) throw new Error("body too short: " + body.length);
  var payloadLen = ((body[8] & 255) << 8) | (body[9] & 255);
  if (payloadLen + 10 > body.length) throw new Error("invalid frame length " + payloadLen + " for " + body.length);
  var prefix  = body.slice(0, 8);
  var payload = body.slice(10, 10 + payloadLen);
  var suffix  = body.slice(10 + payloadLen);
  var patched = patchPayload(payload, stats);
  if (patched.length > 65535) throw new Error("patched payload too large: " + patched.length);
  return concat([prefix, [(patched.length >> 8) & 255, patched.length & 255], patched, suffix]);
