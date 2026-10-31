/* =====================================================================
   PROPIEDADES BIENES — Servidor (Google Apps Script sobre Google Sheets)
   ---------------------------------------------------------------------
   Va pegado en la hoja de Google: Extensiones → Apps Script → Code.gs
   y se publica como "Aplicación web" (Ejecutar como: Yo · Acceso: Cualquier usuario).

   Pestañas que crea solo en la hoja:
     Fincas      cartera activa y vendidas (una fila por finca)
     Historial   cada cambio: quién, cuándo, valor anterior y nuevo
     Casos       casos legales (uno por fila, en JSON)
     Usuarios    usuarios, rol y contraseña CIFRADA (sal + SHA-256 repetido; nunca en texto plano)
     Sesiones    sesiones abiertas (se guarda solo la huella del token, no el token)
     Accesos     ingresos, salidas, bloqueos y cambios de contraseña
     Config      configuración de casos legales

   Seguridad:
     · Las contraseñas se verifican aquí, en el servidor. La página no ve ninguna.
     · 5 intentos fallidos → bloqueo de 15 minutos (también al cambiar la contraseña).
     · Contraseña temporal: vence en 72 h y obliga a crear una personal (mín. 10, letras y números).
     · Al cambiar o restablecer una contraseña, o al desactivar un usuario, se cierran sus sesiones.
     · La sesión dura 30 días desde el último uso (la página la mantiene viva mientras está abierta).
   ===================================================================== */

var CFG = {
  SESION_DIAS: 30,
  CLAVE_TEMP_HORAS: 72,
  MAX_FALLOS: 5,
  BLOQUEO_MIN: 15,
  ITERACIONES: 1000,          // repeticiones del SHA-256 al cifrar contraseñas
  HISTORIAL_MAX: 3000         // cambios que se envían a la página (los más recientes)
};

var ROLES = {admin: 'Administrador', editor: 'Edición (todo)', editor_bienes: 'Edición · bienes reposeídos',
             editor_legal: 'Edición · casos legales', lector: 'Solo lectura'};
var FINCA_EDIT_ROLES = ['admin', 'editor', 'editor_bienes'];
var LEGAL_EDIT_ROLES = ['admin', 'editor', 'editor_legal'];

var HOJAS = {
  Fincas: ['_id', 'finca', 'grupo', 'tipo', 'prov', 'corr', 'cedente', 'vendidoA', 'estado', 'precioVenta', 'situacion',
           'vs', 'merc', 'vlibros', 'ventaR', 'fe', 'fv', 'tasa', 'lanz', 'fa', 'ea', 'obs', 'enlace', 'upd', 'updBy'],
  Historial: ['id', 'fecha', 'usuario', 'nombre', 'filaId', 'finca', 'clave', 'campo', 'anterior', 'nuevo', 'nota'],
  Casos: ['id', 'json', 'v', 'actualizado', 'por'],
  Usuarios: ['usuario', 'nombre', 'rol', 'activo', 'salt', 'hash', 'debeCambiar', 'creado', 'ultimo', 'fallos', 'bloqueoHasta', 'tempVence'],
  Sesiones: ['huella', 'usuario', 'creado', 'ultimo', 'vence'],
  Accesos: ['fecha', 'usuario', 'evento', 'detalle'],
  Config: ['clave', 'valor']
};
var NUM_FINCA = {precioVenta: 1, vs: 1, merc: 1, vlibros: 1, ventaR: 1, tasa: 1};
var FECHA_FINCA = {fe: 1, fv: 1, fa: 1};
var EDITABLES = {estado: 'Estado', cedente: 'Cedida / Hipotecada', vendidoA: 'Vendido a', vs: 'Valor sugerido', ventaR: 'Venta rápida',
                 vlibros: 'Valor en libros', situacion: 'Situación de venta', fe: 'Fecha de entrada', fv: 'Fecha de venta', tasa: 'Tasa de interés (%)'};
var REVERTIBLE = ['estado', 'cedente', 'vendidoA', 'vs', 'ventaR', 'vlibros', 'situacion', 'fe', 'fv', 'tasa'];

/* =========================== Entrada web =========================== */
function doGet() { return salida_({ok: true, servicio: 'PROPIEDADES BIENES', version: 1}); }

function doPost(e) {
  var req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return salida_({ok: false, error: 'Solicitud inválida.'}); }
  try { return salida_(atender_(req)); }
  catch (err) {
    if (err && err.usuario) return salida_({ok: false, error: err.message, code: err.code});
    console.error(err && err.stack || err);
    return salida_({ok: false, error: 'Error del servidor: ' + (err && err.message || err)});
  }
}

function salida_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function fallo_(msg, code) { var e = new Error(msg); e.usuario = true; if (code) e.code = code; return e; }

function atender_(req) {
  instalarHojas_();
  var a = String(req.action || '');
  if (a === 'login') return login_(req);
  if (a === 'logout') return logout_(req);

  var ses = sesion_(req.token);                 // lanza code SESSION si no es válida
  var u = ses.user;
  if (a === 'changePassword') return conBloqueo_(function () { return cambiarClave_(ses, req); });
  if (a === 'ping') { tocarSesion_(ses); return {ok: true, rev: rev_(), user: publico_(u)}; }
  if (esVerdad_(u.debeCambiar)) return {ok: false, code: 'MUST_CHANGE', error: 'Debe crear su contraseña personal.'};
  tocarSesion_(ses);

  switch (a) {
    case 'data': return datos_(u);
    case 'edit': return conBloqueo_(function () { return editar_(u, req); });
    case 'revert': return conBloqueo_(function () { return revertir_(u, req); });
    case 'saveCases': return conBloqueo_(function () { return guardarCasos_(u, req); });
    case 'users': soloAdmin_(u); return usuarios_();
    case 'createUser': soloAdmin_(u); return conBloqueo_(function () { return crearUsuario_(u, req); });
    case 'updateUser': soloAdmin_(u); return conBloqueo_(function () { return actualizarUsuario_(u, req); });
    case 'resetPassword': soloAdmin_(u); return conBloqueo_(function () { return restablecer_(u, req); });
    case 'cargaInicial': soloAdmin_(u); return conBloqueo_(function () { return cargaInicial_(u, req); });
  }
  throw fallo_('Acción desconocida: ' + a);
}

function conBloqueo_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw fallo_('El servidor está ocupado con otra edición. Intente de nuevo en unos segundos.');
  try { return fn(); } finally { lock.releaseLock(); }
}
function soloAdmin_(u) { if (u.rol !== 'admin') throw fallo_('Solo el administrador puede hacer esto.'); }

/* =========================== Hoja: utilidades =========================== */
var CACHE_ = {};
function libro_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function hoja_(nombre) {
  if (CACHE_[nombre]) return CACHE_[nombre];
  var sh = libro_().getSheetByName(nombre);
  if (!sh) {
    sh = libro_().insertSheet(nombre);
    sh.getRange(1, 1, 1, HOJAS[nombre].length).setValues([HOJAS[nombre]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // todo como texto: así Sheets no convierte fechas ni números de finca
    sh.getRange(1, 1, sh.getMaxRows(), HOJAS[nombre].length).setNumberFormat('@');
  }
  return (CACHE_[nombre] = sh);
}
function instalarHojas_() { Object.keys(HOJAS).forEach(hoja_); }

function filas_(nombre) {
  var sh = hoja_(nombre), n = sh.getLastRow();
  if (n < 2) return [];
  var H = HOJAS[nombre], V = sh.getRange(2, 1, n - 1, H.length).getValues();
  return V.map(function (r, i) { var o = {_fila: i + 2}; H.forEach(function (k, j) { o[k] = r[j]; }); return o; });
}
function aFila_(nombre, o) { return HOJAS[nombre].map(function (k) { var v = o[k]; return v === null || v === undefined ? '' : v; }); }
function agregar_(nombre, objs) {
  if (!objs.length) return;
  var sh = hoja_(nombre), H = HOJAS[nombre], ini = sh.getLastRow() + 1;
  var rg = sh.getRange(ini, 1, objs.length, H.length);
  rg.setNumberFormat('@');
  rg.setValues(objs.map(function (o) { return aFila_(nombre, o); }));
}
function escribir_(nombre, o) {
  var sh = hoja_(nombre), H = HOJAS[nombre];
  var rg = sh.getRange(o._fila, 1, 1, H.length); rg.setNumberFormat('@'); rg.setValues([aFila_(nombre, o)]);
}
function reemplazarTodo_(nombre, objs) {
  var sh = hoja_(nombre), H = HOJAS[nombre], n = sh.getLastRow();
  if (n > 1) sh.getRange(2, 1, n - 1, H.length).clearContent();
  agregar_(nombre, objs);
}
function borrarFilas_(nombre, filas) {
  var sh = hoja_(nombre);
  filas.sort(function (a, b) { return b - a; }).forEach(function (f) { sh.deleteRow(f); });
}

function ahora_() { return Utilities.formatDate(new Date(), zona_(), 'yyyy-MM-dd HH:mm:ss'); }
function zona_() { return Session.getScriptTimeZone() || 'America/Panama'; }
function esVerdad_(v) { return v === true || String(v).toUpperCase() === 'TRUE' || v === 1 || v === '1'; }
function txt_(v) { if (v === null || v === undefined) return ''; if (v instanceof Date) return Utilities.formatDate(v, zona_(), 'yyyy-MM-dd'); return String(v).trim(); }
function numOVacio_(v) { if (v === '' || v === null || v === undefined) return null; var n = Number(v); return isFinite(n) ? n : null; }
function rev_() { return PropertiesService.getScriptProperties().getProperty('REV') || '0'; }
function subirRev_() { var r = String(Date.now()); PropertiesService.getScriptProperties().setProperty('REV', r); return r; }
function uuid_() { return Utilities.getUuid().replace(/-/g, ''); }

/* =========================== Contraseñas =========================== */
function hex_(bytes) { return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join(''); }
function sha_(s) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); }
function cifrar_(salt, clave) { var h = sha_(salt + '|' + clave); for (var i = 1; i < CFG.ITERACIONES; i++) h = sha_(salt + '|' + h); return h; }
// Contraseña temporal aleatoria tipo "Kp7wR-mZq4t-82" (letras y números, sin caracteres que se confunden)
function claveTemporal_() {
  var L = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz', T = L + '23456789', D = '23456789';
  var hx = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''), i = 0;
  var b = function () { var v = parseInt(hx.substr(i, 2), 16); i += 2; return v; };
  var pick = function (A, n) { var s = ''; while (n--) s += A[b() % A.length]; return s; };
  return pick(L, 1) + pick(T, 4) + '-' + pick(T, 5) + '-' + pick(D, 2);
}
function reglasClave_(nueva) {
  if (String(nueva).length < 10 || !/[A-Za-z]/.test(nueva) || !/[0-9]/.test(nueva)) throw fallo_('La contraseña debe tener mínimo 10 caracteres, con letras y números.');
}
function igualSeguro_(a, b) { if (a.length !== b.length) return false; var d = 0; for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

/* =========================== Usuarios y sesiones =========================== */
function buscarUsuario_(usuario) {
  usuario = String(usuario || '').trim().toLowerCase();
  var L = filas_('Usuarios');
  for (var i = 0; i < L.length; i++) if (String(L[i].usuario).toLowerCase() === usuario) return L[i];
  return null;
}
function publico_(u) {
  return {usuario: u.usuario, nombre: u.nombre || u.usuario, rol: u.rol, rolLabel: ROLES[u.rol] || u.rol, debeCambiar: esVerdad_(u.debeCambiar)};
}
function acceso_(usuario, evento, detalle) { agregar_('Accesos', [{fecha: ahora_(), usuario: usuario || '', evento: evento, detalle: detalle || ''}]); }

function nuevaSesion_(u) {
  var token = uuid_() + uuid_(), t = Date.now();
  agregar_('Sesiones', [{huella: sha_(token), usuario: u.usuario, creado: ahora_(), ultimo: String(t), vence: String(t + CFG.SESION_DIAS * 864e5)}]);
  return token;
}
function cerrarSesiones_(usuario, salvoHuella) {
  var f = filas_('Sesiones').filter(function (s) { return String(s.usuario).toLowerCase() === String(usuario).toLowerCase() && s.huella !== salvoHuella; })
    .map(function (s) { return s._fila; });
  borrarFilas_('Sesiones', f);
  return f.length;
}
function sesion_(token) {
  if (!token) throw fallo_('Su sesión expiró. Ingrese nuevamente.', 'SESSION');
  var h = sha_(String(token)), S = filas_('Sesiones'), s = null, ahora = Date.now(), vencidas = [];
  S.forEach(function (x) { if (Number(x.vence) < ahora) vencidas.push(x._fila); else if (x.huella === h) s = x; });
  if (vencidas.length > 20) conBloqueo_(function () { borrarFilas_('Sesiones', vencidas); });
  if (!s) throw fallo_('Su sesión expiró. Ingrese nuevamente.', 'SESSION');
  var u = buscarUsuario_(s.usuario);
  if (!u || !esVerdad_(u.activo)) throw fallo_('Su usuario fue desactivado.', 'SESSION');
  return {sesion: s, user: u, huella: h};
}
function tocarSesion_(ses) {
  var s = ses.sesion, t = Date.now();
  if (t - Number(s.ultimo) < 30 * 60 * 1000) return;   // se renueva como mucho cada 30 min
  s.ultimo = String(t); s.vence = String(t + CFG.SESION_DIAS * 864e5);
  try { escribir_('Sesiones', s); } catch (e) {}
}

function login_(req) {
  var usuario = String(req.usuario || '').trim().toLowerCase(), clave = String(req.password || '');
  if (!usuario || !clave) throw fallo_('Escriba su usuario y contraseña.');
  return conBloqueo_(function () {
    var u = buscarUsuario_(usuario), ahora = Date.now();
    if (!u) { acceso_(usuario, 'Ingreso fallido', 'Usuario inexistente'); throw fallo_('Usuario o contraseña incorrectos.'); }
    if (!esVerdad_(u.activo)) { acceso_(u.usuario, 'Ingreso rechazado', 'Usuario desactivado'); throw fallo_('Su usuario está desactivado. Hable con el administrador.'); }
    if (Number(u.bloqueoHasta) > ahora) throw fallo_('Usuario bloqueado por intentos fallidos. Intente de nuevo en ' + Math.ceil((Number(u.bloqueoHasta) - ahora) / 60000) + ' min.');
    if (!igualSeguro_(cifrar_(u.salt, clave), String(u.hash))) {
      u.fallos = Number(u.fallos || 0) + 1;
      if (u.fallos >= CFG.MAX_FALLOS) { u.bloqueoHasta = String(ahora + CFG.BLOQUEO_MIN * 60000); u.fallos = 0; acceso_(u.usuario, 'Bloqueo', CFG.MAX_FALLOS + ' intentos fallidos'); }
      else acceso_(u.usuario, 'Ingreso fallido', 'Contraseña incorrecta');
      escribir_('Usuarios', u);
      throw fallo_('Usuario o contraseña incorrectos.');
    }
    if (esVerdad_(u.debeCambiar) && u.tempVence && Number(u.tempVence) < ahora) {
      acceso_(u.usuario, 'Ingreso rechazado', 'Contraseña temporal vencida');
      throw fallo_('Su contraseña temporal venció. Pida una nueva al administrador.');
    }
    u.fallos = 0; u.bloqueoHasta = ''; u.ultimo = ahora_(); escribir_('Usuarios', u);
    var token = nuevaSesion_(u);
    acceso_(u.usuario, 'Ingreso', esVerdad_(u.debeCambiar) ? 'Con contraseña temporal' : '');
    var r = {ok: true, token: token, user: publico_(u)};
    if (!esVerdad_(u.debeCambiar)) { var d = datos_(u); for (var k in d) if (k !== 'ok') r[k] = d[k]; }
    return r;
  });
}

function logout_(req) {
  if (!req.token) return {ok: true};
  var h = sha_(String(req.token));
  return conBloqueo_(function () {
    var s = filas_('Sesiones').filter(function (x) { return x.huella === h; });
    if (s.length) { borrarFilas_('Sesiones', s.map(function (x) { return x._fila; })); acceso_(s[0].usuario, 'Salida', req.motivo === 'inactividad' ? 'Por inactividad' : ''); }
    return {ok: true};
  });
}

function cambiarClave_(ses, req) {
  var u = buscarUsuario_(ses.user.usuario), ahora = Date.now();
  if (Number(u.bloqueoHasta) > ahora) throw fallo_('Usuario bloqueado por intentos fallidos. Intente de nuevo en unos minutos.');
  var actual = String(req.actual || ''), nueva = String(req.nueva || '');
  if (!igualSeguro_(cifrar_(u.salt, actual), String(u.hash))) {
    u.fallos = Number(u.fallos || 0) + 1;
    if (u.fallos >= CFG.MAX_FALLOS) { u.bloqueoHasta = String(ahora + CFG.BLOQUEO_MIN * 60000); u.fallos = 0; acceso_(u.usuario, 'Bloqueo', 'Intentos fallidos al cambiar contraseña'); }
    escribir_('Usuarios', u);
    throw fallo_('La contraseña actual no es correcta.');
  }
  reglasClave_(nueva);
  if (nueva === actual) throw fallo_('La nueva contraseña debe ser distinta a la actual.');
  u.salt = uuid_(); u.hash = cifrar_(u.salt, nueva); u.debeCambiar = 'FALSE'; u.tempVence = ''; u.fallos = 0; u.bloqueoHasta = '';
  escribir_('Usuarios', u);
  cerrarSesiones_(u.usuario, null);                    // cierra TODAS sus sesiones (otras computadoras incluidas)
  var token = nuevaSesion_(u);                          // y le da una nueva a esta
  acceso_(u.usuario, 'Cambio de contraseña', '');
  var r = {ok: true, token: token, user: publico_(u)}, d = datos_(u);
  for (var k in d) if (k !== 'ok') r[k] = d[k];
  return r;
}

function usuarios_() {
  var ahora = Date.now();
  var users = filas_('Usuarios').map(function (u) {
    return {usuario: u.usuario, nombre: u.nombre, rol: u.rol, activo: esVerdad_(u.activo), ultimo: txt_(u.ultimo),
            bloqueado: Number(u.bloqueoHasta) > ahora, debeCambiar: esVerdad_(u.debeCambiar)};
  });
  var acc = filas_('Accesos').slice(-300).reverse().map(function (a) { return {fecha: txt_(a.fecha), usuario: a.usuario, evento: a.evento, detalle: a.detalle}; });
  return {ok: true, users: users, accesos: acc};
}
function crearUsuario_(admin, req) {
  var usuario = String(req.usuario || '').trim().toLowerCase(), nombre = String(req.nombre || '').trim(), rol = String(req.rol || 'lector');
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) throw fallo_('El usuario debe tener de 3 a 30 letras, números, punto, guion o guion bajo (sin espacios ni tildes).');
  if (!nombre) throw fallo_('Escriba el nombre.');
  if (!ROLES[rol]) throw fallo_('Rol inválido.');
  if (buscarUsuario_(usuario)) throw fallo_('Ya existe un usuario "' + usuario + '".');
  var clave = claveTemporal_(), salt = uuid_();
  agregar_('Usuarios', [{usuario: usuario, nombre: nombre, rol: rol, activo: 'TRUE', salt: salt, hash: cifrar_(salt, clave), debeCambiar: 'TRUE',
    creado: ahora_(), ultimo: '', fallos: 0, bloqueoHasta: '', tempVence: String(Date.now() + CFG.CLAVE_TEMP_HORAS * 3600e3)}]);
  acceso_(admin.usuario, 'Usuario creado', usuario + ' · ' + ROLES[rol]);
  return {ok: true, usuario: usuario, password: clave};
}
function actualizarUsuario_(admin, req) {
  var u = buscarUsuario_(req.usuario);
  if (!u) throw fallo_('Usuario no encontrado.');
  if (String(u.usuario).toLowerCase() === String(admin.usuario).toLowerCase()) throw fallo_('No puede cambiar su propio rol ni desactivarse.');
  var det = [];
  if (req.rol !== undefined) { if (!ROLES[req.rol]) throw fallo_('Rol inválido.'); det.push('rol: ' + ROLES[u.rol] + ' → ' + ROLES[req.rol]); u.rol = req.rol; }
  if (req.activo !== undefined) {
    var act = !!req.activo; det.push(act ? 'activado' : 'desactivado'); u.activo = act ? 'TRUE' : 'FALSE';
    if (!act) cerrarSesiones_(u.usuario, null);        // pierde el acceso de inmediato
  }
  escribir_('Usuarios', u);
  acceso_(admin.usuario, 'Usuario modificado', u.usuario + ' · ' + det.join(', '));
  return {ok: true};
}
function restablecer_(admin, req) {
  var u = buscarUsuario_(req.usuario);
  if (!u) throw fallo_('Usuario no encontrado.');
  if (String(u.usuario).toLowerCase() === String(admin.usuario).toLowerCase()) throw fallo_('Para su propia contraseña use "Cambiar contraseña".');
  var clave = claveTemporal_();
  u.salt = uuid_(); u.hash = cifrar_(u.salt, clave); u.debeCambiar = 'TRUE'; u.fallos = 0; u.bloqueoHasta = '';
  u.tempVence = String(Date.now() + CFG.CLAVE_TEMP_HORAS * 3600e3);
  escribir_('Usuarios', u);
  cerrarSesiones_(u.usuario, null);                    // la contraseña anterior y sus sesiones dejan de servir
  acceso_(admin.usuario, 'Contraseña restablecida', u.usuario);
  return {ok: true, usuario: u.usuario, password: clave};
}

/* =========================== Datos =========================== */
function fincaObj_(r) {
  var o = {};
  HOJAS.Fincas.forEach(function (k) {
    var v = r[k];
    if (NUM_FINCA[k]) o[k] = numOVacio_(v);
    else if (k === 'finca') { var s = txt_(v); o[k] = /^\d+$/.test(s) ? Number(s) : s; }
    else { var t = txt_(v); o[k] = t === '' ? null : t; }
  });
  o.grupo = o.grupo || 'activa';
  return o;
}
function histObj_(r) {
  var p = function (v) { if (v === '' || v === null || v === undefined) return null; try { return JSON.parse(v); } catch (e) { return v; } };
  return {id: txt_(r.id), fecha: txt_(r.fecha), usuario: r.usuario, nombre: r.nombre, filaId: txt_(r.filaId), finca: txt_(r.finca),
          clave: r.clave, campo: r.campo, anterior: p(r.anterior), nuevo: p(r.nuevo), nota: r.nota || ''};
}
function casosObj_() {
  return filas_('Casos').map(function (r) { var c; try { c = JSON.parse(r.json); } catch (e) { c = {id: r.id}; } c._v = txt_(r.v); return c; });
}
function config_(clave) {
  var L = filas_('Config');
  for (var i = 0; i < L.length; i++) if (L[i].clave === clave) { try { return JSON.parse(L[i].valor); } catch (e) { return L[i].valor; } }
  return null;
}
function guardarConfig_(clave, valor) {
  var L = filas_('Config'), txt = JSON.stringify(valor);
  for (var i = 0; i < L.length; i++) if (L[i].clave === clave) { L[i].valor = txt; escribir_('Config', L[i]); return; }
  agregar_('Config', [{clave: clave, valor: txt}]);
}
function datos_(u) {
  var H = filas_('Historial');
  return {ok: true, user: publico_(u), fincas: filas_('Fincas').map(fincaObj_),
          historial: H.slice(-CFG.HISTORIAL_MAX).map(histObj_).reverse(),
          casos: casosObj_(), legalCfg: config_('legalCfg'), rev: rev_()};
}
function hist_(u, filaId, finca, clave, campo, anterior, nuevo, nota) {
  return {id: uuid_().slice(0, 12), fecha: ahora_(), usuario: u.usuario, nombre: u.nombre || u.usuario, filaId: filaId, finca: String(finca),
          clave: clave, campo: campo, anterior: anterior === null || anterior === undefined ? '' : JSON.stringify(anterior),
          nuevo: nuevo === null || nuevo === undefined ? '' : JSON.stringify(nuevo), nota: nota || ''};
}
function normalizar_(k, v) {
  if (v === '' || v === undefined) v = null;
  if (v === null) return null;
  if (NUM_FINCA[k]) { var n = Number(v); if (!isFinite(n)) throw fallo_('Valor inválido en ' + (EDITABLES[k] || k) + '.'); return n; }
  if (FECHA_FINCA[k]) { var s = String(v).trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw fallo_('Fecha inválida en ' + (EDITABLES[k] || k) + ' (use AAAA-MM-DD).'); return s; }
  return String(v).trim().slice(0, 300) || null;
}

function editar_(u, req) {
  if (FINCA_EDIT_ROLES.indexOf(u.rol) < 0) throw fallo_('Su usuario no tiene permiso para editar fincas.');
  var patch = req.patch || {}, id = String(req.id || '');
  var L = filas_('Fincas'), r = null;
  for (var i = 0; i < L.length; i++) if (txt_(L[i]._id) === id) { r = L[i]; break; }
  if (!r) throw fallo_('No se encontró la finca (puede que se haya recargado la base). Actualice la página.');
  var actual = fincaObj_(r), H = [];
  Object.keys(patch).forEach(function (k) {
    if (!EDITABLES[k]) return;
    var nuevo = normalizar_(k, patch[k]), ant = actual[k] === undefined ? null : actual[k];
    if (String(ant === null ? '' : ant) === String(nuevo === null ? '' : nuevo)) return;
    r[k] = nuevo === null ? '' : nuevo; actual[k] = nuevo;
    H.push(hist_(u, id, actual.finca, k, EDITABLES[k], ant, nuevo, ''));
  });
  if (H.length) {
    r.upd = ahora_().slice(0, 16); r.updBy = u.nombre || u.usuario;
    escribir_('Fincas', r); agregar_('Historial', H); subirRev_();
  }
  return {ok: true, cambios: H.length, fila: fincaObj_(r)};
}

function revertir_(u, req) {
  if (u.rol !== 'admin') throw fallo_('Solo el administrador puede revertir cambios.');
  var h = null; filas_('Historial').forEach(function (x) { if (txt_(x.id) === String(req.histId)) h = x; });
  if (!h) throw fallo_('No se encontró ese cambio en el historial.');
  if (REVERTIBLE.indexOf(h.clave) < 0) throw fallo_('Ese tipo de cambio no se puede revertir desde aquí.');
  var L = filas_('Fincas'), r = null;
  for (var i = 0; i < L.length; i++) if (txt_(L[i]._id) === txt_(h.filaId)) { r = L[i]; break; }
  if (!r) throw fallo_('La finca de ese cambio ya no está en la base.');
  var anterior = histObj_(h).anterior, actual = fincaObj_(r)[h.clave];
  r[h.clave] = anterior === null ? '' : anterior; r.upd = ahora_().slice(0, 16); r.updBy = u.nombre || u.usuario;
  escribir_('Fincas', r);
  agregar_('Historial', [hist_(u, txt_(h.filaId), txt_(h.finca), h.clave, EDITABLES[h.clave] || h.campo, actual, anterior, 'Reversión del cambio del ' + txt_(h.fecha))]);
  subirRev_();
  return {ok: true};
}

function resumenCaso_(c) {
  if (!c) return null;
  if (c.concl) return 'Concluido' + (c.concl.destino ? ' · ' + c.concl.destino : '');
  return [c.tipo, c.fase].filter(Boolean).join(' · ') || 'Caso';
}
function guardarCasos_(u, req) {
  if (LEGAL_EDIT_ROLES.indexOf(u.rol) < 0) throw fallo_('Su usuario no tiene permiso para editar casos legales.');
  var items = req.cases || [], L = filas_('Casos'), porId = {}, guardados = [], conflictos = [], H = [];
  L.forEach(function (r) { porId[txt_(r.id)] = r; });
  items.forEach(function (it) {
    var d = it && it.data; if (!d || !d.id) return;
    var id = String(d.id), r = porId[id], previo = null;
    if (r) {
      try { previo = JSON.parse(r.json); } catch (e) {}
      if (String(it.baseV || '') !== txt_(r.v)) { var act = previo || {id: id}; act._v = txt_(r.v); conflictos.push({id: id, actual: act}); return; }
    }
    var limpio = JSON.parse(JSON.stringify(d)); delete limpio._v;
    var v = uuid_().slice(0, 10), fila = {id: id, json: JSON.stringify(limpio), v: v, actualizado: ahora_(), por: u.usuario};
    if (r) { fila._fila = r._fila; escribir_('Casos', fila); } else { agregar_('Casos', [fila]); porId[id] = fila; }
    var ant = resumenCaso_(previo), nue = resumenCaso_(limpio);
    if (!previo || ant !== nue) H.push(hist_(u, id, limpio.finca || limpio.n || id, 'caso', 'Caso legal', previo ? ant : 'Nuevo caso', nue, ''));
    limpio._v = v; guardados.push(limpio);
  });
  var cfg = null;
  if (req.cfg) { guardarConfig_('legalCfg', req.cfg); cfg = req.cfg; H.push(hist_(u, 'cfg', 'Configuración', 'cfg', 'Configuración casos', null, 'Actualizada', '')); }
  if (H.length) agregar_('Historial', H);
  if (guardados.length || cfg) subirRev_();
  return {ok: true, casos: guardados, conflicts: conflictos, legalCfg: cfg || config_('legalCfg')};
}

/* Carga completa (archivo MIFI_DATOS_V2): reemplaza las fincas (y los casos si vienen), con respaldo previo */
function respaldar_(nombre) {
  var sh = hoja_(nombre), copia = sh.copyTo(libro_());
  var n = 'Respaldo ' + nombre + ' ' + Utilities.formatDate(new Date(), zona_(), 'yyyy-MM-dd HH.mm.ss');
  copia.setName(n); return n;
}
function cargaInicial_(u, req) {
  var F = req.fincas;
  if (!Array.isArray(F) || !F.length) throw fallo_('El archivo no trae fincas.');
  var respaldos = [];
  if (hoja_('Fincas').getLastRow() > 1) respaldos.push(respaldar_('Fincas'));
  // se conservan los identificadores de las fincas que ya existían (para no romper el historial)
  var previos = {}; filas_('Fincas').forEach(function (r) { previos[(txt_(r.grupo) || 'activa') + '|' + txt_(r.finca)] = txt_(r._id); });
  var usados = {}, filas = F.map(function (f, i) {
    var o = {};
    HOJAS.Fincas.forEach(function (k) { var v = f[k]; o[k] = (v === null || v === undefined) ? '' : (typeof v === 'object' ? JSON.stringify(v) : v); });
    o.grupo = f.grupo === 'vendida' ? 'vendida' : 'activa';
    var clave = o.grupo + '|' + String(f.finca), id = previos[clave] || ('F' + String(f.finca).replace(/[^A-Za-z0-9]/g, '_') + (o.grupo === 'vendida' ? '_v' : ''));
    while (usados[id]) id += '_' + i; usados[id] = 1; o._id = id;
    return o;
  });
  reemplazarTodo_('Fincas', filas);
  var nCasos = null;
  if (Array.isArray(req.casos)) {
    if (hoja_('Casos').getLastRow() > 1) respaldos.push(respaldar_('Casos'));
    reemplazarTodo_('Casos', req.casos.filter(function (c) { return c && c.id; }).map(function (c) {
      var l = JSON.parse(JSON.stringify(c)); delete l._v; return {id: String(c.id), json: JSON.stringify(l), v: uuid_().slice(0, 10), actualizado: ahora_(), por: u.usuario}; }));
    nCasos = req.casos.length;
  }
  if (req.legalCfg) guardarConfig_('legalCfg', req.legalCfg);
  agregar_('Historial', [hist_(u, 'carga', 'Carga de datos', 'carga', 'Carga de datos', null, filas.length + ' fincas' + (nCasos !== null ? ' · ' + nCasos + ' casos' : ''), String(req.origen || '').slice(0, 200))]);
  subirRev_();
  acceso_(u.usuario, 'Carga completa de datos', filas.length + ' fincas');
  return {ok: true, fincas: filas.length, casos: nCasos, respaldos: respaldos};
}

/* =========================== Instalación (se corre una vez desde el editor o el menú) =========================== */
function onOpen() {
  try { SpreadsheetApp.getUi().createMenu('Propiedades Bienes').addItem('Instalar / crear administrador', 'instalar').addItem('Nueva contraseña temporal para el administrador', 'nuevaClaveAdmin').addToUi(); } catch (e) {}
}
function mostrar_(titulo, msg) { try { SpreadsheetApp.getUi().alert(titulo, msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {} Logger.log(titulo + '\n' + msg); }
function instalar() {
  instalarHojas_();
  var admins = filas_('Usuarios').filter(function (u) { return u.rol === 'admin' && esVerdad_(u.activo); });
  if (admins.length) { mostrar_('Propiedades Bienes', 'Ya está instalado. Administrador: ' + admins.map(function (a) { return a.usuario; }).join(', ') + '.'); return; }
  var clave = claveTemporal_(), salt = uuid_();
  agregar_('Usuarios', [{usuario: 'admin', nombre: 'Administrador', rol: 'admin', activo: 'TRUE', salt: salt, hash: cifrar_(salt, clave), debeCambiar: 'TRUE',
    creado: ahora_(), ultimo: '', fallos: 0, bloqueoHasta: '', tempVence: String(Date.now() + CFG.CLAVE_TEMP_HORAS * 3600e3)}]);
  acceso_('admin', 'Instalación', 'Administrador creado');
  mostrar_('Propiedades Bienes instalado', 'Usuario: admin\nContraseña temporal: ' + clave + '\n\nAnótela: no se vuelve a mostrar. Al entrar por primera vez el dashboard le pedirá crear su contraseña personal.');
}
function nuevaClaveAdmin() {
  var u = buscarUsuario_('admin'); if (!u) { instalar(); return; }
  var clave = claveTemporal_(); u.salt = uuid_(); u.hash = cifrar_(u.salt, clave); u.debeCambiar = 'TRUE'; u.activo = 'TRUE'; u.fallos = 0; u.bloqueoHasta = '';
  u.tempVence = String(Date.now() + CFG.CLAVE_TEMP_HORAS * 3600e3); escribir_('Usuarios', u); cerrarSesiones_('admin', null);
  acceso_('admin', 'Contraseña restablecida', 'Desde el menú de la hoja');
  mostrar_('Nueva contraseña temporal', 'Usuario: admin\nContraseña temporal: ' + clave);
}
