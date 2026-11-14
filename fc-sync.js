/* Frecuencia Cero - roles y sincronizacion en vivo.
   La app sigue funcionando localmente si Firebase no esta configurado.
   Para sincronizar varios telefonos hay que configurar Firebase una sola vez por proyecto. */
(function () {
  'use strict';

  var APP_VERSION = 'V15';
  var CFG_KEY = 'fc_firebase_config_v1';
  var BAND_KEY = 'fc_band_id_v1';
  var PROFILE_KEY = 'fc_device_profile_v1';
  var FIXED_BAND_ID = 'frecuencia-cero-main';
  // UID anónimo del dispositivo principal del propietario técnico (Acordeonista).
  var OWNER_UID = 'qZCvhHTK3MUhcABIlZlRyrqHKdC2';
  var FIREBASE_CONFIG = {
    apiKey: 'AIzaSyBqpgzZ-z7hBzY3E1SlnL4YaCMaKqI7qD8',
    authDomain: 'frecuencia-cerov1.firebaseapp.com',
    databaseURL: 'https://frecuencia-cerov1-default-rtdb.firebaseio.com',
    projectId: 'frecuencia-cerov1',
    storageBucket: 'frecuencia-cerov1.firebasestorage.app',
    messagingSenderId: '91517551899',
    appId: '1:91517551899:web:f45125cdc86e0dfdb17fbe',
    measurementId: 'G-STPBJMMPKZ'
  };
  var FOLLOW_KEY = 'fc_follow_director_v1';
  var OVERRIDE_KEY = 'fc_instrument_overrides_v1';
  var ROLE_LABELS = {
    voice1: 'Voz 1 · Director',
    voice2: 'Voz 2',
    bass: 'Bajista',
    accordionist: 'Acordeonista',
    drummer: 'Baterista',
    keyboardist: 'Tecladista',
    pending: 'Pendiente de asignar'
  };
  var ROLE_OPTIONS = [
    ['voice1', 'Voz 1 · Director'],
    ['voice2', 'Voz 2'],
    ['bass', 'Bajista'],
    ['accordionist', 'Acordeonista'],
    ['drummer', 'Baterista'],
    ['keyboardist', 'Tecladista'],
    ['pending', 'Pendiente']
  ];
  var firebaseApp = null;
  var auth = null;
  var db = null;
  var authWatcherStarted = false;
  var lastCatalogJson = '';
  var lastEventsJson = '';
  var currentUser = null;
  var bandId = ''; // Se fija al aprobar el dispositivo en la banda Frecuencia Cero
  var bandMeta = null;
  var memberRole = 'local';
  var memberProfile = null;
  var memberList = {};
  var presenceMap = {};
  var inviteCode = '';
  function inviteStorageKey() { return 'fc_invite_code_v1:' + bandId + ':' + (currentUser ? currentUser.uid : ''); }
  var liveState = null;
  var followDirector = localStorage.getItem(FOLLOW_KEY) !== 'false';
  var instrumentOverrides = readOverrides();
  var applyingRemote = false;
  var refs = {};
  var lastHandledSong = '';
  var originalSave = window.save;
  var originalSaveEvents = window.saveEvents;
  var originalOpenSong = window.openSong;
  var originalShow = window.show;
  var eventDraftAssignments = {};
  var selectedProfileRole = localStorage.getItem(PROFILE_KEY) || '';
  var joinRequestList = {};
  var watchingIdentity = false;
  var attachedUid = '';
  var anonymousSignInPending = false;
  var identityKind = 'members';
  var deviceList = {};
  var identityChecks = { member: false, device: false };
  var pairQrRef = null;
  var pairQrToken = '';
  var pairQrExpiryTimer = null;
  var pairScanner = null;
  var pairProcessing = false;
  var browseOverride = false;
  var openingFromLive = false;
  var lastRemotePositionKey = '';
  var lastPublishedPositionKey = '';
  var scrollPublishTimer = null;
  var firstProfileGateShown = false;

  function $(id) { return document.getElementById(id); }
  function safeJson(value) { try { return JSON.stringify(value); } catch (e) { return '{}'; } }
  function readOverrides() {
    try { return JSON.parse(localStorage.getItem(OVERRIDE_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function setStatus(message, kind) {
    var node = $('fcSyncStatus');
    if (!node) return;
    node.textContent = message;
    node.className = 'fc-status ' + (kind || 'neutral');
  }
  function setText(id, value) { var node = $(id); if (node) node.textContent = value; }
  function isConnected() { return !!(db && auth && currentUser && bandId); }
  function isDirector() { return isConnected() ? memberRole === 'voice1' : false; }
  function isTechnicalOwner() {
    if (!currentUser) return false;
    var ownerUid = bandMeta && bandMeta.ownerUid;
    var memberUid = memberProfile && (memberProfile.memberUid || currentUser.uid);
    return currentUser.uid === OWNER_UID || !!(memberProfile && memberProfile.isOwner) || !!(ownerUid && (currentUser.uid === ownerUid || memberUid === ownerUid)) || memberUid === OWNER_UID;
  }
  function canManageCatalog() { return !isConnected() || isTechnicalOwner(); }
  function canManageEvents() { return !isConnected() || isTechnicalOwner() || memberRole === 'voice1'; }
  function roleName(role) { return ROLE_LABELS[role] || 'Integrante'; }
  function randomCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var out = '';
    var bytes = new Uint8Array(10);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    for (var j = 0; j < 8; j++) out += chars[bytes[j] % chars.length];
    return out;
  }
  function mapById(list) {
    var out = {};
    (list || []).forEach(function (item) { if (item && item.id) out[item.id] = item; });
    return out;
  }
  function objectValues(obj) {
    return Object.keys(obj || {}).map(function (key) { return obj[key]; }).filter(Boolean);
  }
  function localSaveSongs() {
    try { localStorage.setItem(window.KEY || 'letras_frecuencia_cero_v3', JSON.stringify(window.songs || [])); } catch (e) {}
  }
  function localSaveEvents() {
    try { localStorage.setItem(window.EVENT_KEY || 'frecuencia_cero_eventos_v1', JSON.stringify(window.events || [])); } catch (e) {}
  }
  function memberPath() { return 'bands/' + bandId + '/members'; }
  function bandPath(child) { return 'bands/' + bandId + '/' + child; }
  function updateSyncButtons() {
    var signed = !!currentUser;
    var ownerDevice = !!(currentUser && currentUser.uid === OWNER_UID);
    var connected = isConnected();
    if (ownerDevice && !connected && selectedProfileRole !== 'accordionist') {
      selectedProfileRole = 'accordionist';
      localStorage.setItem(PROFILE_KEY, 'accordionist');
    }
    if ($('fcSignIn')) $('fcSignIn').style.display = 'none';
    if ($('fcSignOut')) $('fcSignOut').style.display = 'none';
    if ($('fcFirebaseConfig')) $('fcFirebaseConfig').style.display = 'none';
    if ($('fcConnect')) $('fcConnect').style.display = 'none';
    if ($('fcInviteWrap')) $('fcInviteWrap').style.display = 'none';
    if ($('fcJoinCode')) $('fcJoinCode').style.display = 'none';
    if ($('fcJoinBand')) $('fcJoinBand').style.display = 'none';
    if ($('fcProfileSelect')) {
      $('fcProfileSelect').disabled = connected;
      if (connected) $('fcProfileSelect').value = memberRole;
      else if (selectedProfileRole) $('fcProfileSelect').value = selectedProfileRole;
    }
    if ($('fcProfileSave')) $('fcProfileSave').style.display = (connected || ownerDevice) ? 'none' : '';
    if ($('fcProfileSelect') && ownerDevice && !connected) $('fcProfileSelect').style.display = 'none';
    if ($('fcDeviceUid')) $('fcDeviceUid').textContent = currentUser ? currentUser.uid : 'Preparando identidad de este teléfono…';
    if ($('fcCopyUid')) $('fcCopyUid').style.display = currentUser && !connected ? '' : 'none';
    // Dos acciones independientes: el propietario crea la banda; después genera el QR.
    if ($('fcCreateBand')) {
      $('fcCreateBand').style.display = (ownerDevice && !connected) ? '' : 'none';
      $('fcCreateBand').disabled = !signed;
      $('fcCreateBand').textContent = '＋ Crear banda';
    }
    if ($('fcOwnerMismatch')) $('fcOwnerMismatch').style.display = (!connected && selectedProfileRole === 'accordionist' && currentUser && currentUser.uid !== OWNER_UID) ? '' : 'none';
    if ($('fcCurrentOwnerUid')) $('fcCurrentOwnerUid').textContent = currentUser ? currentUser.uid : 'Preparando identidad…';
    if ($('fcRequestJoin')) $('fcRequestJoin').style.display = (!connected && selectedProfileRole && selectedProfileRole !== 'accordionist') ? '' : 'none';
    if ($('fcRequestJoin')) $('fcRequestJoin').disabled = !signed || !!(window.fcJoinRequestPending);
    if ($('fcLinkDevice')) {
      $('fcLinkDevice').style.display = connected ? '' : 'none';
      $('fcLinkDevice').disabled = !signed;
      $('fcLinkDevice').textContent = '▦ Generar código QR para vincular otro dispositivo';
    }
    if ($('fcScanDeviceLink')) $('fcScanDeviceLink').style.display = (!connected && signed && !ownerDevice) ? '' : 'none';
    if ($('fcPairHelp')) $('fcPairHelp').textContent = ownerDevice
      ? (connected
          ? 'Este es el dispositivo propietario. Pulsa Generar código QR y escanéalo desde el teléfono o tablet que quieras vincular.'
          : 'Este iPhone está identificado como propietario. Primero pulsa «Crear banda». Cuando se conecte, aparecerá por separado «Generar código QR».')
      : (connected
          ? 'Genera un QR para vincular otro teléfono o tablet a tu mismo perfil.'
          : 'Este dispositivo todavía no está vinculado. Escanea aquí el QR que genere un teléfono autorizado.');
    if ($('fcBandName')) $('fcBandName').style.display = (!connected && ownerDevice) ? '' : 'none';
    if ($('fcBandSummary')) $('fcBandSummary').textContent = connected
      ? ((bandMeta && bandMeta.name) || 'Frecuencia Cero') + ' · ' + roleName(memberRole)
      : (ownerDevice
          ? 'Dispositivo propietario identificado. Primero crea la banda; después podrás generar el código QR como una segunda acción.'
          : (window.fcJoinRequestPending
              ? 'Solicitud enviada. Esperando aprobación del propietario técnico.'
              : (selectedProfileRole === 'accordionist' && currentUser && currentUser.uid !== OWNER_UID
                  ? 'Este teléfono tiene una identidad distinta a la registrada como propietario. Copia el ID actual para revisar la autorización inicial.'
                  : 'Selecciona tu perfil en este teléfono.')));
    if ($('fcBandActions')) $('fcBandActions').style.display = connected ? '' : 'none';
    if ($('fcMemberAdmin')) $('fcMemberAdmin').style.display = connected && isTechnicalOwner() ? '' : 'none';
    if ($('fcMyDevicesBox')) $('fcMyDevicesBox').style.display = connected ? '' : 'none';
    if ($('fcJoinRequests')) $('fcJoinRequests').style.display = connected && isTechnicalOwner() ? '' : 'none';
    if ($('fcFollow')) $('fcFollow').checked = followDirector;
    var profileBar = $('fcRoleBar');
    if (profileBar) profileBar.style.display = (connected && memberRole !== 'pending') ? '' : 'none';
    if ($('fcDirectorButton')) $('fcDirectorButton').style.display = memberRole === 'voice1' ? '' : 'none';
    if ($('fcProfileSelect') && connected) $('fcProfileSelect').style.display = 'none';
    if ($('eventNew')) $('eventNew').style.display = connected && !canManageEvents() ? 'none' : '';
    var legacyImport = document.querySelector('.event-import'); if (legacyImport) legacyImport.style.display = connected ? 'none' : '';
    if ($('playlistEdit')) $('playlistEdit').style.display = connected && !canManageEvents() ? 'none' : '';
    if ($('bnew')) $('bnew').style.display = connected && !canManageCatalog() ? 'none' : '';
    if ($('bedit')) $('bedit').style.display = connected && !canManageCatalog() ? 'none' : '';
    if ($('tmode') && connected) $('tmode').style.display = 'none';
    renderMemberAdmin();
    renderMyDevices();
    renderJoinRequests();
  }
  function configFromInput() { return FIREBASE_CONFIG; }
  function connectFirebase() {
    try {
      if (!window.firebase || !firebase.initializeApp) throw new Error('No se pudo cargar Firebase. Comprueba tu conexión a Internet.');
      firebaseApp = firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
      auth = firebase.auth();
      db = firebase.database();
      setStatus('Conectando de forma segura este teléfono…', 'success');
      auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function () {});
      if (!authWatcherStarted) { auth.onAuthStateChanged(onAuthChanged); authWatcherStarted = true; }
      if (!auth.currentUser && !anonymousSignInPending) {
        anonymousSignInPending = true;
        auth.signInAnonymously().catch(function (err) {
          anonymousSignInPending = false;
          setStatus('No se pudo identificar este teléfono: ' + err.message, 'error');
        });
      }
      updateSyncButtons();
    } catch (err) { setStatus(err.message || 'No se pudo conectar Firebase.', 'error'); }
  }
  function signIn() { connectFirebase(); }
  function signOut() {
    if (!auth) return;
    if (!confirm('¿Cerrar sesión de Frecuencia Cero en este teléfono?')) return;
    Object.keys(refs).forEach(function (key) { try { refs[key].off(); } catch (e) {} });
    refs = {}; currentUser = null; memberRole = 'local'; memberProfile = null; memberList = {}; liveState = null;
    localStorage.removeItem(BAND_KEY); bandId = ''; inviteCode = '';
    auth.signOut().then(function () { setStatus('Sesión cerrada. El catálogo local se conserva.', 'neutral'); updateSyncButtons(); renderEvents(); render(); }).catch(function (err) { setStatus(err.message, 'error'); });
  }
  function onAuthChanged(user) {
    currentUser = user || null;
    anonymousSignInPending = false;
    if (!user) {
      memberRole = 'unjoined'; memberProfile = null;
      setStatus('Identificando este teléfono…', 'neutral');
      updateSyncButtons();
      if (auth && !anonymousSignInPending) {
        anonymousSignInPending = true;
        auth.signInAnonymously().catch(function (err) { anonymousSignInPending = false; setStatus('No se pudo crear la identidad temporal: ' + err.message, 'error'); });
      }
      return;
    }
    if (user.uid === OWNER_UID) {
      selectedProfileRole = 'accordionist';
      localStorage.setItem(PROFILE_KEY, 'accordionist');
    }
    setStatus(user.uid === OWNER_UID ? 'Dispositivo propietario identificado. Aquí podrás crear la banda y generar los códigos QR.' : 'Teléfono identificado. Selecciona tu perfil o escanea el QR de un dispositivo autorizado.', 'success');
    setText('fcDeviceUid', user.uid);
    setText('fcGateUid', user.uid);
    if (selectedProfileRole) hideFirstProfileGate();
    watchOwnMembership();
    maybeProcessIncomingPair();
    updateSyncButtons();
  }
  function activateMembership(profile, kind) {
    if (!profile || !profile.role || !currentUser) return;
    var id = currentUser.uid + ':' + kind;
    bandId = FIXED_BAND_ID; localStorage.setItem(BAND_KEY, bandId);
    identityKind = kind;
    memberRole = profile.role; memberProfile = profile;
    selectedProfileRole = profile.role; localStorage.setItem(PROFILE_KEY, profile.role);
    window.fcJoinRequestPending = false;
    if (attachedUid !== id) attachBand(FIXED_BAND_ID, kind);
    hideFirstProfileGate();
    setStatus('Conectado · ' + roleName(memberRole) + (kind === 'devices' ? ' · dispositivo vinculado' : ''), 'success');
    updateSyncButtons();
  }
  function watchOwnMembership() {
    if (!db || !currentUser || watchingIdentity) return;
    watchingIdentity = true;
    var uid = currentUser.uid;
    refs.selfMember = db.ref('bands/' + FIXED_BAND_ID + '/members/' + uid);
    refs.selfDevice = db.ref('bands/' + FIXED_BAND_ID + '/devices/' + uid);
    refs.selfRequest = db.ref('bands/' + FIXED_BAND_ID + '/joinRequests/' + uid);
    identityChecks = { member: false, device: false };
    refs.selfMember.on('value', function (snap) {
      identityChecks.member = true;
      var m = snap.val();
      if (m && m.role) activateMembership(m, 'members');
      else if (identityChecks.device && !memberProfile) finishUnjoinedIdentity();
    }, function (err) {
      identityChecks.member = true;
      if (err && err.code !== 'PERMISSION_DENIED') setStatus('No se pudo consultar el perfil: ' + err.message, 'error');
      if (identityChecks.device && !memberProfile) finishUnjoinedIdentity();
    });
    refs.selfDevice.on('value', function (snap) {
      identityChecks.device = true;
      var d = snap.val();
      if (d && d.role && !memberProfile) activateMembership(d, 'devices');
      else if (identityChecks.member && !memberProfile) finishUnjoinedIdentity();
    }, function (err) {
      identityChecks.device = true;
      if (err && err.code !== 'PERMISSION_DENIED') setStatus('No se pudo consultar el dispositivo vinculado: ' + err.message, 'error');
      if (identityChecks.member && !memberProfile) finishUnjoinedIdentity();
    });
    refs.selfRequest.on('value', function (snap) {
      var req = snap.val();
      window.fcJoinRequestPending = !!req;
      if (req) setStatus('Solicitud enviada como ' + roleName(req.requestedRole) + '. Esperando aprobación del propietario técnico.', 'warning');
      else if (!bandId && currentUser && !memberProfile) setStatus('Selecciona tu perfil o escanea un QR de vinculación.', 'neutral');
      updateSyncButtons();
    }, function (err) {
      if (err && err.code !== 'PERMISSION_DENIED') setStatus('No se pudo consultar la solicitud: ' + err.message, 'error');
    });
  }
  function finishUnjoinedIdentity() {
    if (bandId || memberProfile) return;
    memberRole = window.fcJoinRequestPending ? 'pending' : 'unjoined';
    identityKind = 'members';
    updateSyncButtons();
    maybeShowFirstProfileGate();
  }
  async function createBand() {
    try {
      if (!currentUser || !db) throw new Error('El teléfono todavía no está identificado.');
      if (currentUser.uid !== OWNER_UID) {
        var mismatch = 'El UID actual de este teléfono no coincide con el propietario configurado. UID actual: ' + currentUser.uid + '. Copia este identificador y actualizaremos la regla de Firebase. Este primer dispositivo NO debe escanear un QR.';
        setStatus(mismatch, 'warning');
        alert(mismatch);
        throw new Error(mismatch);
      }
      if (selectedProfileRole !== 'accordionist') throw new Error('Selecciona Acordeonista para crear la banda como propietario técnico.');
      if (bandId) throw new Error('Este teléfono ya pertenece a la banda.');
      var name = $('fcBandName').value.trim() || 'Frecuencia Cero';
      var now = firebase.database.ServerValue.TIMESTAMP;
      var initialEvents = {};
      (window.events || []).forEach(function (ev) { initialEvents[ev.id] = Object.assign({}, ev, { assignments: ev.assignments || {} }); });
      var initial = {
        meta: { name: name, ownerUid: currentUser.uid, createdAt: now, schema: 3, authMode: 'anonymous', ownerRole: 'accordionist', directorRole: 'voice1' },
        members: {}, devices: {}, devicePairings: {},
        catalog: mapById(window.songs || []), events: initialEvents,
        live: { eventId: null, songId: null, position: -1, rowIndex: 0, chordIndex: -1, paused: true, changedAt: now, changedBy: currentUser.uid }
      };
      initial.members[currentUser.uid] = { role: 'accordionist', name: ROLE_LABELS.accordionist, memberUid: currentUser.uid, isOwner: true, joinedAt: now, deviceType: 'anonymous' };
      var bandRootRef = db.ref('bands/' + FIXED_BAND_ID);
      var existingBand = await bandRootRef.once('value');
      if (existingBand.exists()) throw new Error('Ya existe una banda en Firebase. No sobrescribí sus integrantes, catálogo ni eventos. Antes de continuar debemos revisar si esa banda ya fue creada.');
      await bandRootRef.set(initial);
      bandId = FIXED_BAND_ID; localStorage.setItem(BAND_KEY, bandId);
      memberRole = 'accordionist'; memberProfile = initial.members[currentUser.uid]; bandMeta = initial.meta;
      selectedProfileRole = 'accordionist'; localStorage.setItem(PROFILE_KEY, 'accordionist');
      lastCatalogJson = safeJson(mapById(window.songs || [])); lastEventsJson = safeJson(mapById(window.events || []));
      attachedUid = ''; identityKind = 'members';
      await attachBand(FIXED_BAND_ID, 'members');
      setStatus('Banda creada correctamente. Ahora pulsa «Generar código QR» para vincular otro dispositivo.', 'success');
      return true;
    } catch (err) {
      var detail = err && err.code === 'PERMISSION_DENIED' ? 'Firebase rechazó la creación. Publica las reglas de Realtime Database con el UID autorizado del propietario técnico.' : (err.message || 'Error desconocido.');
      setStatus('No se pudo crear la banda: ' + detail, 'error');
      return false;
    }
  }
  async function requestJoin() {
    try {
      if (!currentUser || !db) throw new Error('Espera a que Firebase identifique este teléfono.');
      var role = selectedProfileRole || ($('fcProfileSelect') && $('fcProfileSelect').value);
      if (!role || role === 'accordionist' || !ROLE_OPTIONS.some(function (r) { return r[0] === role; })) throw new Error('La función Acordeonista está reservada al propietario técnico. Selecciona otra función disponible.');
      if (bandId) throw new Error('Este teléfono ya pertenece a la banda.');
      var reqRef = db.ref('bands/' + FIXED_BAND_ID + '/joinRequests/' + currentUser.uid);
      var existing = await reqRef.once('value');
      if (existing.exists()) { window.fcJoinRequestPending = true; setStatus('Ya existe una solicitud pendiente. El propietario técnico debe aprobarla.', 'warning'); updateSyncButtons(); return; }
      await reqRef.set({ requestedRole: role, deviceName: ROLE_LABELS[role], requestedAt: firebase.database.ServerValue.TIMESTAMP, status: 'pending' });
      selectedProfileRole = role; localStorage.setItem(PROFILE_KEY, role);
      window.fcJoinRequestPending = true;
      setStatus('Solicitud enviada. El propietario técnico aprobará tu función desde Mi banda y sincronización.', 'success');
      updateSyncButtons();
    } catch (err) {
      var msg = err && err.code === 'PERMISSION_DENIED' ? 'No se pudo enviar la solicitud. Primero el propietario técnico debe crear la banda y publicar las reglas correctas.' : (err.message || 'Error desconocido.');
      setStatus('No se pudo solicitar acceso: ' + msg, 'error');
    }
  }
  async function approveJoinRequest(uid, role) {
    if (!isTechnicalOwner() || !db || !bandId) return;
    if (!ROLE_OPTIONS.some(function (r) { return r[0] === role && role !== 'accordionist' && role !== 'pending'; })) return;
    var occupied = Object.keys(memberList || {}).find(function (otherUid) { return otherUid !== uid && memberList[otherUid] && memberList[otherUid].role === role; });
    if (occupied) { alert('La función ' + roleName(role) + ' ya está ocupada. Selecciona otra función disponible.'); return; }
    if (Object.keys(memberList || {}).length >= 6 && !memberList[uid]) { alert('La banda ya tiene sus seis integrantes.'); return; }
    var req = joinRequestList[uid] || {};
    var member = { role: role, name: ROLE_LABELS[role], memberUid: uid, joinedAt: firebase.database.ServerValue.TIMESTAMP, approvedBy: currentUser.uid };
    var patch = {};
    patch['members/' + uid] = member;
    patch['joinRequests/' + uid] = null;
    try {
      await db.ref(memberPath() + '/' + uid).set(member);
      await db.ref(bandPath('joinRequests/' + uid)).remove();
      setStatus((req.deviceName || 'Integrante') + ' aprobado como ' + roleName(role) + '.', 'success');
    } catch (err) { setStatus('No se pudo aprobar al integrante: ' + err.message, 'error'); }
  }
  async function rejectJoinRequest(uid) {
    if (!isTechnicalOwner() || !db || !bandId) return;
    try { await db.ref(bandPath('joinRequests/' + uid)).remove(); }
    catch (err) { setStatus('No se pudo rechazar la solicitud: ' + err.message, 'error'); }
  }
  async function attachBand(id, kind) {
    if (!db || !currentUser) return;
    kind = kind || 'members';
    if (attachedUid === currentUser.uid + ':' + kind && bandId === id && refs.catalog) return;
    Object.keys(refs).forEach(function (key) { try { refs[key].off(); } catch (e) {} }); refs = {};
    bandId = id; localStorage.setItem(BAND_KEY, id); identityKind = kind; attachedUid = currentUser.uid + ':' + kind;
    var root = db.ref('bands/' + id);
    refs.meta = root.child('meta');
    refs.members = root.child('members');
    refs.mine = root.child(kind + '/' + currentUser.uid);
    refs.catalog = root.child('catalog');
    refs.events = root.child('events');
    refs.live = root.child('live');
    refs.presence = root.child('presence/' + currentUser.uid);
    refs.meta.on('value', function (snap) { bandMeta = snap.val() || {}; updateSyncButtons(); });
    refs.mine.on('value', function (snap) {
      memberProfile = snap.val(); memberRole = memberProfile && memberProfile.role || 'pending';
      selectedProfileRole = memberRole; localStorage.setItem(PROFILE_KEY, memberRole);
      setStatus('Conectado · ' + roleName(memberRole), 'success');
      updateSyncButtons(); if (window.cur) applyRoleToCurrentSong();
    });
    refs.members.on('value', function (snap) { memberList = snap.val() || {}; updateMemberPresence(); renderMemberAdmin(); renderMyDevices(); renderMembersStatus(); });
    refs.devices = root.child('devices');
    refs.devices.on('value', function (snap) { deviceList = snap.val() || {}; updateMemberPresence(); renderMemberAdmin(); renderMyDevices(); renderMembersStatus(); });
    if (isTechnicalOwner()) {
      refs.joinRequests = root.child('joinRequests');
      refs.joinRequests.on('value', function (snap) { joinRequestList = snap.val() || {}; renderJoinRequests(); });
    }
    refs.allPresence = root.child('presence');
    refs.allPresence.on('value', function (snap) {
      presenceMap = snap.val() || {};
      updateMemberPresence();
      renderMemberAdmin(); renderMyDevices(); renderMembersStatus();
    });
    refs.catalog.on('value', function (snap) {
      var data = snap.val(); if (!data) return;
      applyingRemote = true;
      window.songs = objectValues(data).sort(function (a, b) { return (a.catalogOrder == null ? 999999 : a.catalogOrder) - (b.catalogOrder == null ? 999999 : b.catalogOrder); });
      lastCatalogJson = safeJson(mapById(window.songs));
      localSaveSongs(); applyingRemote = false;
      if (typeof window.render === 'function') window.render();
      if (window.cur) { var latest = window.find(window.cur.id); if (latest) { window.cur = latest; window.paint(); applyRoleToCurrentSong(); } }
      // Reintenta el seguimiento si el listener de live llegó antes que el catálogo.
      renderLiveBanner(); handleLiveUpdate();
    });
    refs.events.on('value', function (snap) {
      var data = snap.val(); if (!data) data = {};
      applyingRemote = true;
      window.events = objectValues(data).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      lastEventsJson = safeJson(mapById(window.events));
      localSaveEvents(); applyingRemote = false;
      if (typeof window.renderEvents === 'function') window.renderEvents();
      if (window.currentEventId && $('vplaylist') && $('vplaylist').classList.contains('on')) window.renderEventPlaylist();
      if (window.cur) applyRoleToCurrentSong();
      // Reintenta cuando los eventos ya están disponibles localmente.
      renderLiveBanner(); handleLiveUpdate();
    });
    refs.live.on('value', function (snap) { liveState = snap.val() || null; renderLiveBanner(); handleLiveUpdate(); });
    refs.presence.set({ name: roleName(memberRole), role: memberRole, online: true, since: firebase.database.ServerValue.TIMESTAMP }).catch(function () {});
    refs.presence.onDisconnect().remove().catch(function () {});
    updateSyncButtons();
  }
  function randomTokenHex() {
    var bytes = new Uint8Array(24);
    if (!window.crypto || !crypto.getRandomValues) throw new Error('Este navegador no puede generar un QR seguro. Actualiza Safari o Chrome.');
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function canonicalMemberUid() {
    if (memberProfile && memberProfile.memberUid) return memberProfile.memberUid;
    return currentUser ? currentUser.uid : '';
  }
  function pairingUrl(token) {
    var url = new URL('./', window.location.href);
    url.search = ''; url.hash = ''; url.searchParams.set('fc_pair', token);
    return url.toString();
  }
  function closePairQr(message) {
    if (pairQrRef) { pairQrRef.off(); pairQrRef = null; }
    if (pairQrExpiryTimer) { clearTimeout(pairQrExpiryTimer); pairQrExpiryTimer = null; }
    pairQrToken = '';
    var box = $('fcPairQrBox'); if (box) { box.style.display = 'none'; box.innerHTML = ''; }
    if (message) setStatus(message, 'success');
  }
  async function createDevicePairing() {
    try {
      if (!isConnected() || !memberProfile) throw new Error('Primero debes tener un perfil autorizado en la banda.');
      var memberUid = canonicalMemberUid();
      var memberSnap = await db.ref(memberPath() + '/' + memberUid).once('value');
      var canonicalMember = memberSnap.val();
      if (!canonicalMember || !canonicalMember.role || canonicalMember.role === 'pending') throw new Error('No se encontró la función actual de este integrante. Vuelve a conectar el perfil antes de generar el QR.');
      var pairingRole = canonicalMember.role;
      var token = randomTokenHex();
      var expiresAt = Date.now() + 180000;
      var pairing = {
        role: pairingRole,
        memberUid: memberUid,
        createdBy: currentUser.uid,
        createdAt: firebase.database.ServerValue.TIMESTAMP,
        expiresAt: expiresAt,
        status: 'pending'
      };
      var ref = db.ref(bandPath('devicePairings/' + token));
      await ref.set(pairing);
      closePairQr();
      pairQrToken = token; pairQrRef = ref;
      var box = $('fcPairQrBox');
      box.innerHTML = '<div class="fc-pair-title">Vincular otro dispositivo</div><p class="note">Abre Frecuencia Cero en el otro teléfono o tablet y pulsa Escanear QR. Este QR vence en 3 minutos y solo sirve una vez.</p><div id="fcPairQrCanvas" class="fc-pair-qr"></div><div id="fcPairUrlText" class="fc-pair-url"></div><div id="fcPairCountdown" class="note">Válido durante 3:00</div><button type="button" id="fcPairCopy">Copiar enlace alternativo</button><button type="button" id="fcPairCancel">Cancelar QR</button>';
      box.style.display = '';
      var link = pairingUrl(token);
      $('fcPairUrlText').textContent = link;
      if (window.QRCode) {
        new QRCode($('fcPairQrCanvas'), { text: link, width: 220, height: 220, colorDark: '#111827', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
      } else {
        $('fcPairQrCanvas').textContent = 'No se pudo cargar el generador QR. Puedes abrir el enlace en el otro dispositivo.';
      }
      $('fcPairCopy').onclick = function () { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(function () { setStatus('Enlace alternativo copiado.', 'success'); }).catch(function () { setStatus('No se pudo copiar. Mantén pulsado el enlace para copiarlo.', 'warning'); }); else setStatus('Mantén pulsado el enlace para copiarlo.', 'neutral'); };
      $('fcPairCancel').onclick = function () { ref.remove().catch(function () {}); closePairQr('Código de vinculación cancelado.'); };
      ref.on('value', function (snap) {
        var state = snap.val();
        if (!state) return;
        if (state.status === 'completed') { ref.remove().catch(function () {}); closePairQr('¡Dispositivo vinculado correctamente a ' + roleName(state.role) + '!'); }
        else if (state.status === 'claimed') setText('fcPairCountdown', 'QR escaneado. Terminando vinculación…');
      });
      var end = Date.now() + 180000;
      function tick() {
        if (!pairQrToken || pairQrToken !== token) return;
        var remain = Math.max(0, end - Date.now());
        var total = Math.ceil(remain / 1000);
        setText('fcPairCountdown', 'Válido durante ' + Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0'));
        if (remain <= 0) { ref.remove().catch(function () {}); closePairQr('El QR venció. Genera uno nuevo cuando lo necesites.'); }
        else pairQrExpiryTimer = setTimeout(tick, 1000);
      }
      tick();
      setStatus('QR generado. Escanéalo desde el dispositivo que quieres vincular.', 'success');
    } catch (err) { setStatus('No se pudo generar el QR: ' + (err.message || err), 'error'); }
  }
  async function handleOwnerBandAction() {
    var button = $('fcCreateBand');
    try {
      if (!currentUser || !db) throw new Error('Espera a que Firebase identifique este dispositivo.');
      if (currentUser.uid !== OWNER_UID) throw new Error('Solo el iPhone registrado como propietario técnico puede crear la banda.');
      if (isConnected()) throw new Error('La banda ya está conectada. Utiliza «Generar código QR» como acción independiente.');
      if (button) { button.disabled = true; button.textContent = 'Comprobando banda…'; }
      selectedProfileRole = 'accordionist';
      localStorage.setItem(PROFILE_KEY, 'accordionist');
      var rootSnap = await db.ref('bands/' + FIXED_BAND_ID).once('value');
      if (!rootSnap.exists()) {
        setStatus('Creando la banda como propietario técnico…', 'neutral');
        var created = await createBand();
        if (!created) return;
      } else {
        var rootData = rootSnap.val() || {};
        var meta = rootData.meta || {};
        if (meta.ownerUid !== OWNER_UID) {
          throw new Error('Ya existe una banda con ese identificador, pero no está registrada a nombre de este propietario. No modifiqué ningún dato. Hay que revisar la banda existente en Firebase.');
        }
        var ownerMember = rootData.members && rootData.members[OWNER_UID];
        if (!ownerMember || !ownerMember.role || ownerMember.role === 'pending') {
          throw new Error('La banda ya existe y pertenece a este UID, pero falta el perfil del propietario en /members. No se sobrescribió ningún dato; hay que revisar esa relación en Firebase.');
        }
        bandMeta = meta;
        bandId = FIXED_BAND_ID;
        localStorage.setItem(BAND_KEY, bandId);
        memberRole = ownerMember.role;
        memberProfile = ownerMember;
        identityKind = 'members';
        await attachBand(FIXED_BAND_ID, 'members');
        setStatus('Se recuperó la banda existente sin modificar integrantes, canciones ni eventos. Ahora puedes generar el QR por separado.', 'success');
      }
    } catch (err) {
      var message = err && err.code === 'PERMISSION_DENIED'
        ? 'Firebase bloqueó la operación. Revisa que Authentication anónimo esté habilitado y que las reglas de Realtime Database permitan al propietario consultar y crear la banda.'
        : (err.message || 'No se pudo crear o recuperar la banda.');
      setStatus('No se pudo crear la banda: ' + message, 'error');
      alert(message);
    } finally {
      if (button) { button.disabled = false; button.textContent = '＋ Crear banda'; }
      updateSyncButtons();
    }
  }

  async function handleGeneratePairQr() {
    try {
      if (!currentUser || !db) throw new Error('Espera a que Firebase identifique este dispositivo.');
      if (!isConnected() || !memberProfile) throw new Error('Primero crea la banda o completa la aprobación/vinculación de este perfil. El QR se genera en una acción separada, después de quedar conectado.');
      await createDevicePairing();
    } catch (err) {
      var message = err && err.code === 'PERMISSION_DENIED'
        ? 'Firebase bloqueó la operación. Revisa que Authentication anónimo esté habilitado y que hayas publicado las reglas de Realtime Database.'
        : (err.message || 'No se pudo generar el QR.');
      setStatus('No se pudo generar el QR: ' + message, 'error');
      alert(message);
    }
  }

  function extractPairToken(text) {
    try {
      var u = new URL(text);
      return u.searchParams.get('fc_pair') || '';
    } catch (e) {
      return /^[a-f0-9]{48}$/i.test(String(text || '').trim()) ? String(text).trim() : '';
    }
  }
  async function claimDevicePairing(token) {
    if (pairProcessing) return;
    pairProcessing = true;
    try {
      if (!currentUser || !db) throw new Error('Este dispositivo todavía no tiene identidad de Firebase.');
      if (bandId) throw new Error('Este dispositivo ya está vinculado a una función.');
      var pairRef = db.ref('bands/' + FIXED_BAND_ID + '/devicePairings/' + token);
      var initial = await pairRef.once('value');
      var pair = initial.val();
      if (!pair || pair.status !== 'pending' || Number(pair.expiresAt) <= Date.now()) throw new Error('El QR venció o ya fue utilizado. Genera uno nuevo desde el dispositivo original.');
      var tx = await pairRef.transaction(function (current) {
        if (!current || current.status !== 'pending' || Number(current.expiresAt) <= Date.now()) return;
        current.status = 'claimed';
        current.claimedBy = currentUser.uid;
        current.claimedAt = firebase.database.ServerValue.TIMESTAMP;
        return current;
      });
      if (!tx.committed) throw new Error('Este QR ya fue utilizado o venció. Solicita uno nuevo.');
      pair = tx.snapshot.val();
      var device = {
        role: pair.role,
        name: ROLE_LABELS[pair.role] || 'Integrante',
        memberUid: pair.memberUid,
        linkedFrom: pair.createdBy,
        linkedAt: firebase.database.ServerValue.TIMESTAMP,
        pairingToken: token
      };
      await db.ref('bands/' + FIXED_BAND_ID + '/devices/' + currentUser.uid).set(device);
      await pairRef.update({ status: 'completed', completedAt: firebase.database.ServerValue.TIMESTAMP });
      var cleanUrl = new URL(window.location.href); cleanUrl.searchParams.delete('fc_pair');
      history.replaceState({}, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
      setStatus('¡Este dispositivo quedó vinculado como ' + roleName(pair.role) + '!', 'success');
    } catch (err) {
      setStatus('No se pudo vincular el dispositivo: ' + (err.message || err), 'error');
      alert(err.message || 'No se pudo completar la vinculación.');
    } finally { pairProcessing = false; }
  }
  function maybeProcessIncomingPair() {
    if (!currentUser || !db || pairProcessing) return;
    var token = '';
    try { token = new URL(window.location.href).searchParams.get('fc_pair') || ''; } catch (e) {}
    if (token) claimDevicePairing(token);
  }
  async function startPairScanner() {
    try {
      if (!currentUser || !db) throw new Error('Espera a que Firebase identifique este dispositivo.');
      if (bandId) throw new Error('Este dispositivo ya está vinculado.');
      if (!window.Html5Qrcode) throw new Error('No se pudo cargar el lector QR. Comprueba Internet y vuelve a intentarlo.');
      var wrap = $('fcPairScannerWrap'); wrap.style.display = '';
      $('fcPairScannerStatus').textContent = 'Solicitando permiso de cámara…';
      pairScanner = new Html5Qrcode('fcPairScanner');
      await pairScanner.start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 230, height: 230 }, aspectRatio: 1 }, function (decodedText) {
        var token = extractPairToken(decodedText);
        if (!token) { $('fcPairScannerStatus').textContent = 'Ese QR no pertenece a una vinculación de Frecuencia Cero.'; return; }
        stopPairScanner();
        claimDevicePairing(token);
      }, function () {});
      $('fcPairScannerStatus').textContent = 'Apunta la cámara al QR que muestra tu otro dispositivo.';
    } catch (err) {
      if ($('fcPairScannerStatus')) $('fcPairScannerStatus').textContent = err.message || 'No se pudo abrir la cámara.';
      setStatus(err.message || 'No se pudo iniciar el lector QR.', 'error');
    }
  }
  function stopPairScanner() {
    if (pairScanner) {
      pairScanner.stop().catch(function () {}).finally(function () { pairScanner.clear().catch(function () {}); pairScanner = null; });
    }
    if ($('fcPairScannerWrap')) $('fcPairScannerWrap').style.display = 'none';
  }

  async function removeMember(uid) {
    if (!isTechnicalOwner() || !db || !bandId) return;
    var ownerUid = bandMeta && bandMeta.ownerUid;
    if (uid === ownerUid) { alert('El propietario técnico no se puede eliminar desde esta pantalla.'); return; }
    var member = memberList[uid];
    if (!member) return;
    if (!confirm('¿Quitar a ' + (member.name || 'este integrante') + ' de Frecuencia Cero? También se revocarán sus dispositivos vinculados.')) return;
    try {
      var linked = Object.keys(deviceList || {}).filter(function (deviceUid) { return deviceList[deviceUid] && deviceList[deviceUid].memberUid === uid; });
      await db.ref(memberPath() + '/' + uid).remove();
      await Promise.all(linked.map(function (deviceUid) { return db.ref(bandPath('devices/' + deviceUid)).remove(); }));
      await db.ref(bandPath('joinRequests/' + uid)).remove().catch(function () {});
      setStatus((member.name || 'Integrante') + ' retirado de la banda. La plaza quedó disponible.', 'success');
    } catch (err) {
      setStatus('No se pudo quitar al integrante: ' + (err.message || err), 'error');
    }
  }

  async function setMemberRole(uid, role) {
    if (!isTechnicalOwner() || !db || !bandId) return;
    var allowed = ROLE_OPTIONS.some(function (r) { return r[0] === role; });
    if (!allowed) return;
    var ownerUid = bandMeta && bandMeta.ownerUid;
    if (uid === ownerUid) { alert('El perfil del propietario técnico no se puede quitar ni reasignar.'); renderMemberAdmin(); return; }
    if (role === 'accordionist') { alert('La función Acordeonista está reservada al propietario técnico.'); renderMemberAdmin(); return; }
    if (role !== 'pending') {
      var occupied = Object.keys(memberList || {}).find(function (otherUid) { return otherUid !== uid && memberList[otherUid] && memberList[otherUid].role === role; });
      if (occupied) { alert('La función ' + roleName(role) + ' ya está asignada a otro integrante. Cada una de las seis funciones debe tener una sola persona.'); renderMemberAdmin(); return; }
    }
    try {
      await db.ref(memberPath() + '/' + uid).update({ role: role, name: roleName(role) });
      var linkedIds = Object.keys(deviceList || {}).filter(function (deviceUid) { return deviceList[deviceUid] && deviceList[deviceUid].memberUid === uid; });
      await Promise.all(linkedIds.map(function (deviceUid) { return db.ref(bandPath('devices/' + deviceUid)).update({ role: role, name: roleName(role) }); }));
      setStatus('Función actualizada. También se sincronizó en sus dispositivos vinculados.', 'success');
    } catch (err) { setStatus('No se pudo cambiar el rol: ' + (err.message || err), 'error'); }
  }
  async function revokeDevice(deviceUid) {
    if (!isConnected() || !db) return;
    var target = deviceList[deviceUid];
    if (!target) return;
    var myMemberUid = canonicalMemberUid();
    if (!isTechnicalOwner() && target.memberUid !== myMemberUid) {
      alert('Solo puedes revocar dispositivos vinculados a tu propio perfil.');
      return;
    }
    if (deviceUid === currentUser.uid) {
      alert('Este es el dispositivo que estás utilizando. Para dejar de usarlo, cierra la sesión de este teléfono.');
      return;
    }
    if (!confirm('¿Revocar este dispositivo? Dejará de tener acceso a Frecuencia Cero.')) return;
    try {
      await db.ref(bandPath('devices/' + deviceUid)).remove();
      await db.ref(bandPath('presence/' + deviceUid)).remove().catch(function () {});
      setStatus('Dispositivo revocado correctamente.', 'success');
      renderMyDevices(); renderMemberAdmin();
    } catch (err) {
      setStatus('No se pudo revocar el dispositivo: ' + (err.message || err), 'error');
    }
  }
  function renderMyDevices() {
    var box = $('fcMyDevices'); if (!box) return;
    box.innerHTML = '';
    if (!isConnected() || !memberProfile) { box.textContent = 'Conecta tu perfil para administrar tus dispositivos.'; return; }
    var uid = canonicalMemberUid();
    var own = Object.keys(deviceList || {}).filter(function (deviceUid) { return deviceList[deviceUid] && deviceList[deviceUid].memberUid === uid; });
    var primary = document.createElement('div'); primary.className = 'fc-member-row';
    var primaryInfo = document.createElement('div'); primaryInfo.className = 'fc-member-info';
    var primaryName = document.createElement('strong'); primaryName.textContent = 'Dispositivo principal actual';
    var primaryDetail = document.createElement('small'); primaryDetail.textContent = 'Este perfil está abierto en este dispositivo.';
    primaryInfo.append(primaryName, primaryDetail); primary.appendChild(primaryInfo); box.appendChild(primary);
    if (!own.length) { var empty = document.createElement('p'); empty.className = 'note'; empty.textContent = 'Todavía no has vinculado otros teléfonos o tablets.'; box.appendChild(empty); return; }
    own.forEach(function (deviceUid) {
      var device = deviceList[deviceUid] || {}, row = document.createElement('div'); row.className = 'fc-member-row';
      var info = document.createElement('div'); info.className = 'fc-member-info';
      var name = document.createElement('strong'); name.textContent = (device.name || 'Dispositivo vinculado') + (deviceUid === currentUser.uid ? ' · Este dispositivo' : '');
      var detail = document.createElement('small'); detail.textContent = (presenceMap[deviceUid] && presenceMap[deviceUid].online ? 'En línea' : 'Desconectado') + ' · ' + deviceUid.slice(0, 9) + '…';
      info.append(name, detail); row.appendChild(info);
      if (deviceUid !== currentUser.uid) { var revoke = document.createElement('button'); revoke.className = 'danger'; revoke.textContent = 'Revocar'; revoke.type = 'button'; revoke.onclick = function () { revokeDevice(deviceUid); }; row.appendChild(revoke); }
      box.appendChild(row);
    });
  }

  function renderJoinRequests() {
    var box = $('fcJoinRequestsList'); if (!box) return;
    box.innerHTML = '';
    if (!isTechnicalOwner()) return;
    var ids = Object.keys(joinRequestList || {});
    if (!ids.length) { box.textContent = 'No hay solicitudes pendientes.'; return; }
    ids.forEach(function (uid) {
      var req = joinRequestList[uid] || {};
      var row = document.createElement('div'); row.className = 'fc-member-row';
      var info = document.createElement('div'); info.className = 'fc-member-info';
      var name = document.createElement('strong'); name.textContent = req.deviceName || 'Nuevo integrante';
      var detail = document.createElement('small'); detail.textContent = 'Solicita: ' + roleName(req.requestedRole) + ' · ' + uid.slice(0, 9) + '…';
      info.append(name, detail);
      var select = document.createElement('select'); select.setAttribute('aria-label','Función para aprobar integrante');
      ROLE_OPTIONS.forEach(function (r) {
        if (r[0] === 'accordionist' || r[0] === 'pending') return;
        var opt = document.createElement('option'); opt.value = r[0]; opt.textContent = r[1];
        var occupied = Object.keys(memberList || {}).some(function (otherUid) { return otherUid !== uid && memberList[otherUid] && memberList[otherUid].role === r[0]; });
        opt.disabled = occupied;
        if (r[0] === req.requestedRole && !occupied) opt.selected = true;
        select.appendChild(opt);
      });
      var approve = document.createElement('button'); approve.className = 'p'; approve.textContent = 'Aprobar'; approve.onclick = function () { approveJoinRequest(uid, select.value); };
      var reject = document.createElement('button'); reject.textContent = '×'; reject.title = 'Rechazar'; reject.onclick = function () { rejectJoinRequest(uid); };
      row.append(info, select, approve, reject); box.appendChild(row);
    });
  }
  function renderMemberAdmin() {
    var box = $('fcMembers'); if (!box) return;
    box.innerHTML = '';
    var ids = Object.keys(memberList || {});
    if (!ids.length) { box.textContent = 'Los integrantes aparecerán aquí al unirse a la banda.'; return; }
    ids.forEach(function (uid) {
      var m = memberList[uid] || {}, row = document.createElement('div'); row.className = 'fc-member-row';
      var info = document.createElement('div'); info.className = 'fc-member-info';
      var name = document.createElement('strong'); name.textContent = m.name || m.email || 'Integrante';
      var linkedCount = Object.keys(deviceList || {}).filter(function (deviceUid) { return deviceList[deviceUid] && deviceList[deviceUid].memberUid === uid; }).length;
      var detail = document.createElement('small'); detail.textContent = (m.email || '') + (uid === currentUser.uid ? ' · Este dispositivo principal' : '') + (linkedCount ? ' · ' + linkedCount + ' dispositivo(s) vinculado(s)' : '') + (m.online ? ' · En línea' : ' · Desconectado');
      info.append(name, detail);
      var select = document.createElement('select'); select.setAttribute('aria-label', 'Rol de ' + (m.name || 'integrante'));
      ROLE_OPTIONS.forEach(function (r) { if (r[0] === 'accordionist' && bandMeta && uid !== bandMeta.ownerUid) return; var o = document.createElement('option'); o.value = r[0]; o.textContent = r[1]; if (r[0] !== 'pending' && r[0] !== m.role) { var used = Object.keys(memberList || {}).some(function (otherUid) { return otherUid !== uid && memberList[otherUid] && memberList[otherUid].role === r[0]; }); if (used) o.disabled = true; } select.appendChild(o); });
      select.value = m.role || 'pending'; select.disabled = !isTechnicalOwner() || (bandMeta && uid === bandMeta.ownerUid);
      select.onchange = function () { setMemberRole(uid, select.value); };
      row.append(info, select);
      if (isTechnicalOwner() && !(bandMeta && uid === bandMeta.ownerUid)) { var remove = document.createElement('button'); remove.className = 'danger'; remove.type = 'button'; remove.title = 'Quitar integrante y revocar sus dispositivos'; remove.textContent = 'Quitar'; remove.onclick = function () { removeMember(uid); }; row.appendChild(remove); }
      box.appendChild(row);
      Object.keys(deviceList || {}).filter(function (deviceUid) { return deviceList[deviceUid] && deviceList[deviceUid].memberUid === uid; }).forEach(function (deviceUid) {
        var device = deviceList[deviceUid], deviceRow = document.createElement('div'); deviceRow.className = 'fc-member-device';
        var deviceName = document.createElement('span'); deviceName.textContent = '↳ ' + (device.name || 'Dispositivo vinculado') + ' · ' + deviceUid.slice(0, 8) + '…';
        var revoke = document.createElement('button'); revoke.className = 'danger'; revoke.type = 'button'; revoke.textContent = 'Revocar'; revoke.onclick = function () { revokeDevice(deviceUid); };
        deviceRow.append(deviceName, revoke); box.appendChild(deviceRow);
      });
    });
  }
  function eventAssignmentDefaults() { return { accordionist: 'accordion', keyboardist: 'keyboard' }; }
  function getCurrentEvent() { return (window.events || []).find(function (ev) { return ev.id === window.currentEventId; }) || null; }
  function getAssignment(songId, roleKey) {
    var ev = getCurrentEvent();
    var assigned = ev && ev.assignments && ev.assignments[songId] && ev.assignments[songId][roleKey];
    if (assigned) return assigned;
    return roleKey === 'accordionist' ? 'accordion' : 'keyboard';
  }
  function effectiveInstrument(songId) {
    var roleKey = memberRole;
    if (roleKey !== 'accordionist' && roleKey !== 'keyboardist') return '';
    var key = (window.currentEventId || 'catalog') + ':' + songId + ':' + roleKey;
    var override = instrumentOverrides[key] || 'auto';
    if (override !== 'auto') return override;
    return getAssignment(songId, roleKey);
  }
  function currentNextSong() {
    var ev = getCurrentEvent(); if (!ev || !ev.songIds) return null;
    var id = window.cur && window.cur.id;
    var index = ev.songIds.indexOf(id);
    if (index < 0 && liveState && liveState.eventId === ev.id) index = ev.songIds.indexOf(liveState.songId);
    return index >= 0 && index + 1 < ev.songIds.length ? window.find(ev.songIds[index + 1]) : null;
  }
  function applyRoleToCurrentSong() {
    if (!window.cur) return;
    var role = memberRole;
    var instrument = effectiveInstrument(window.cur.id);
    var nextOnly = false;
    var desiredMode = 's';
    if (role === 'bass') desiredMode = 'b';
    else if (role === 'accordionist' || role === 'keyboardist') {
      if (instrument === 'guitar') desiredMode = 'b';
      else { desiredMode = 's'; nextOnly = true; }
    } else if (role === 'drummer') { desiredMode = 's'; nextOnly = true; }
    else if (role === 'voice1' || role === 'voice2') desiredMode = 's';
    if (role === 'local' || role === 'unjoined' || role === 'pending') nextOnly = false;
    if (window.mode !== desiredMode) { window.mode = desiredMode; window.paint(); }
    var rd = $('rd'), nextPanel = $('fcNextOnlyPanel');
    if (nextPanel) {
      if (nextOnly) {
        var next = currentNextSong();
        setText('fcRoleCurrentSong', window.cur.title);
        setText('fcRoleNextSong', next ? next.title : 'Aún no hay siguiente canción en este evento');
        setText('fcRoleCurrentKey', window.cur.key ? 'Tono: ' + window.cur.key : 'Tonalidad no especificada');
        setText('fcRoleInstrumentName', role === 'accordionist' ? 'Acordeón' : role === 'keyboardist' ? 'Teclado' : 'Batería');
        nextPanel.style.display = '';
        if (rd) rd.style.display = 'none';
        if ($('mainbar')) $('mainbar').style.display = 'none';
        if ($('bassTools')) $('bassTools').style.display = 'none';
      } else {
        nextPanel.style.display = 'none';
        if (rd) rd.style.display = '';
        if ($('mainbar')) $('mainbar').style.display = '';
        if ($('bassTools')) $('bassTools').style.display = '';
      }
    }
    renderRoleBar(instrument);
    updateSyncButtons();
  }
  function renderRoleBar(instrument) {
    var bar = $('fcRoleBar'); if (!bar) return;
    if (!currentUser || memberRole === 'pending') { bar.style.display = 'none'; return; }
    bar.style.display = '';
    setText('fcRoleDescription', roleName(memberRole) + (instrument ? ' · ' + (instrument === 'guitar' ? 'Guitarra' : instrument === 'accordion' ? 'Acordeón' : 'Teclado') : ''));
    var followBtn = $('fcFollowToggle');
    if (followBtn) { followBtn.style.display = (memberRole === 'voice1') ? 'none' : ''; followBtn.textContent = followDirector && !browseOverride ? 'Siguiendo director' : 'Vista libre'; }
    var select = $('fcInstrumentSelect');
    if (!select) return;
    var musicianRole = memberRole === 'accordionist' || memberRole === 'keyboardist';
    select.style.display = musicianRole ? '' : 'none';
    if (!musicianRole) return;
    var choices = memberRole === 'accordionist' ? [['auto','Automático por canción'],['accordion','Acordeón'],['guitar','Guitarra']] : [['auto','Automático por canción'],['keyboard','Teclado'],['guitar','Guitarra']];
    select.innerHTML = '';
    choices.forEach(function (item) { var option = document.createElement('option'); option.value = item[0]; option.textContent = item[1]; select.appendChild(option); });
    var key = (window.currentEventId || 'catalog') + ':' + window.cur.id + ':' + memberRole;
    select.value = instrumentOverrides[key] || 'auto';
  }
  function renderLiveBanner() {
    var banner = $('fcLiveBanner'); if (!banner) return;
    if (!liveState || !liveState.eventId || !liveState.songId) { banner.style.display = 'none'; return; }
    var ev = (window.events || []).find(function (item) { return item.id === liveState.eventId; });
    var s = window.find(liveState.songId);
    if (!ev || !s) { banner.style.display = 'none'; return; }
    banner.style.display = '';
    setText('fcLiveBannerText', 'EN VIVO · ' + ev.name + ' · ' + s.title);
  }
  function cleanLiveLine(song, rowIndex) {
    if (!song) return '';
    var lines = String(song.text || '').split(/\r?\n/);
    var i = Math.max(0, Math.min(Number(rowIndex) || 0, Math.max(0, lines.length - 1)));
    var text = String(lines[i] || '').replace(/\[[^\]]+\]/g, '').replace(/^##\s*/, '').trim();
    if (!text) {
      for (var j = i + 1; j < lines.length; j++) {
        text = String(lines[j] || '').replace(/\[[^\]]+\]/g, '').replace(/^##\s*/, '').trim();
        if (text) break;
      }
    }
    return text || 'Parte instrumental';
  }
  function renderMiniPlayer() {
    var mini = $('fcMiniPlayer');
    if (!mini) return;
    var song = liveState && liveState.songId ? window.find(liveState.songId) : null;
    var ev = liveState && liveState.eventId ? (window.events || []).find(function (x) { return x.id === liveState.eventId; }) : null;
    if (!isConnected() || !song || !ev) { mini.style.display = 'none'; return; }
    mini.style.display = 'flex';
    setText('fcMiniEvent', ev.name || 'Evento en vivo');
    setText('fcMiniSong', song.title || 'Canción actual');
    setText('fcMiniLine', cleanLiveLine(song, liveState.rowIndex));
    var lines = String(song.text || '').split(/\r?\n/);
    var current = Math.min(lines.length || 1, Math.max(1, (Number(liveState.rowIndex) || 0) + 1));
    var pct = Math.round(current / Math.max(1, lines.length) * 100);
    var progress = $('fcMiniProgress');
    if (progress) progress.style.width = pct + '%';
    setText('fcMiniProgressText', current + '/' + Math.max(1, lines.length));
    var modeLabel = memberRole === 'voice1' ? 'DIRECTOR' : (!followDirector || browseOverride ? 'VISTA LIBRE' : 'EN SINCRONÍA');
    setText('fcMiniMode', modeLabel);
    var action = $('fcMiniReturn');
    if (action) {
      action.textContent = memberRole === 'voice1' ? 'Abrir' : (!followDirector || browseOverride ? 'Volver a sincronía' : 'Ver en vivo');
      action.style.display = '';
    }
    var paused = !!liveState.paused;
    setText('fcMiniState', paused ? 'En pausa' : 'Avanzando');
    mini.classList.toggle('is-free', memberRole !== 'voice1' && (!followDirector || browseOverride));
    mini.classList.toggle('is-paused', paused);
  }
  function renderLiveBanner() {
    var banner = $('fcLiveBanner');
    if (banner) {
      if (!liveState || !liveState.eventId || !liveState.songId) banner.style.display = 'none';
      else {
        var ev = (window.events || []).find(function (item) { return item.id === liveState.eventId; });
        var s = window.find(liveState.songId);
        if (!ev || !s) banner.style.display = 'none';
        else { banner.style.display = ''; setText('fcLiveBannerText', 'EN VIVO · ' + ev.name + ' · ' + s.title); }
      }
    }
    renderMiniPlayer();
  }
  function applyLivePosition() {
    if (!liveState || !window.cur || window.cur.id !== liveState.songId || !$('vr') || !$('vr').classList.contains('on')) return;
    var rowIndex = Math.max(0, Number(liveState.rowIndex) || 0);
    if (window.mode === 'b' && window.bassEvents && window.bassEvents.length) {
      var chordIndex = Number(liveState.chordIndex);
      if (chordIndex < 0) {
        chordIndex = window.bassEvents.findIndex(function (item) { return item.line && Number(item.line.dataset.lineIndex) === rowIndex; });
      }
      if (chordIndex >= 0 && window.setActiveBassEvent) { window.setActiveBassEvent(Math.min(chordIndex, window.bassEvents.length - 1), true); return; }
    }
    var target = $('rt') && $('rt').querySelector('[data-line-index="' + rowIndex + '"]');
    if (!target) return;
    Array.prototype.forEach.call($('rt').querySelectorAll('[data-line-index]'), function (el) { el.classList.toggle('fc-live-row-current', el === target); });
    var rd = $('rd'), r = target.getBoundingClientRect(), container = rd.getBoundingClientRect();
    var top = rd.scrollTop + (r.top - container.top) - Math.max(25, rd.clientHeight * .28);
    rd.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
  function handleLiveUpdate() {
    if (!liveState || !liveState.eventId || !liveState.songId) { renderLiveBanner(); return; }
    renderLiveBanner();
    if (memberRole === 'voice1') return;
    var s = window.find(liveState.songId); if (!s) return;
    var songKey = liveState.eventId + ':' + liveState.songId;
    var remotePositionKey = songKey + ':' + (liveState.rowIndex == null ? 0 : liveState.rowIndex) + ':' + (liveState.chordIndex == null ? -1 : liveState.chordIndex) + ':' + (!!liveState.paused);
    var changedSong = lastHandledSong !== songKey;
    window.currentEventId = liveState.eventId;
    if ($('vplaylist') && $('vplaylist').classList.contains('on')) window.renderEventPlaylist();
    var editing = ($('ve') && $('ve').classList.contains('on')) || ($('vset') && $('vset').classList.contains('on')) || ($('vm') && $('vm').classList.contains('on'));
    if (!followDirector || browseOverride || editing) { renderMiniPlayer(); return; }
    var alreadyOnLiveSong = window.cur && window.cur.id === liveState.songId && $('vr') && $('vr').classList.contains('on');
    if (changedSong || !alreadyOnLiveSong) {
      lastHandledSong = songKey;
      openingFromLive = true;
      window.openSong(liveState.songId, 'vplaylist');
      openingFromLive = false;
    }
    if (remotePositionKey !== lastRemotePositionKey || changedSong) {
      lastRemotePositionKey = remotePositionKey;
      window.requestAnimationFrame(function () { applyLivePosition(); renderMiniPlayer(); });
    }
    applyRoleToCurrentSong();
  }
  async function setLiveSong(eventId, songId, index) {
    if (memberRole !== 'voice1' || !db || !bandId) { alert('Solo Voz 1 · Director puede cambiar la canción compartida.'); return; }
    try {
      var payload = { eventId: eventId, songId: songId, position: index, rowIndex: 0, chordIndex: -1, paused: true, changedAt: firebase.database.ServerValue.TIMESTAMP, changedBy: currentUser.uid, changedByName: currentUser.displayName || 'Voz 1' };
      await db.ref(bandPath('live')).set(payload);
      liveState = Object.assign({}, payload, { changedAt: Date.now() });
      window.currentEventId = eventId; lastHandledSong = eventId + ':' + songId; lastRemotePositionKey = '';
      lastPublishedPositionKey = '';
      renderEventPlaylist(); renderLiveBanner();
    } catch (err) { setStatus('No se pudo actualizar la canción en vivo: ' + err.message, 'error'); }
  }
  function publishLivePosition(rowIndex, chordIndex, paused) {
    if (memberRole !== 'voice1' || !db || !bandId || !liveState || !window.cur || liveState.songId !== window.cur.id) return;
    rowIndex = Math.max(0, Number(rowIndex) || 0);
    chordIndex = chordIndex == null ? -1 : Number(chordIndex);
    var key = liveState.eventId + ':' + liveState.songId + ':' + rowIndex + ':' + chordIndex + ':' + (!!paused);
    if (key === lastPublishedPositionKey) return;
    lastPublishedPositionKey = key;
    var patch = { rowIndex: rowIndex, chordIndex: chordIndex, paused: !!paused, positionChangedAt: firebase.database.ServerValue.TIMESTAMP };
    Object.assign(liveState, { rowIndex: rowIndex, chordIndex: chordIndex, paused: !!paused, positionChangedAt: Date.now() });
    renderMiniPlayer();
    db.ref(bandPath('live')).update(patch).catch(function (err) { setStatus('No se pudo sincronizar el renglón: ' + err.message, 'error'); });
  }
  function syncDirectorRowFromScroll() {
    if (memberRole !== 'voice1' || !liveState || !window.cur || liveState.songId !== window.cur.id || window.mode !== 's' || !$('vr') || !$('vr').classList.contains('on')) return;
    var rd = $('rd'), children = $('rt') ? Array.prototype.slice.call($('rt').children) : [];
    if (!children.length) return;
    var anchor = rd.getBoundingClientRect().top + Math.max(24, rd.clientHeight * .30), rowIndex = 0;
    children.forEach(function (el) {
      var line = Number(el.dataset.lineIndex);
      if (Number.isFinite(line) && el.getBoundingClientRect().top <= anchor) rowIndex = line;
    });
    publishLivePosition(rowIndex, -1, !window.scrollFrame);
  }
  window.fcSyncPositionChanged = function (rowIndex, chordIndex) {
    if (memberRole !== 'voice1') return;
    publishLivePosition(rowIndex, chordIndex, !window.chordTimer);
  };
  function returnToLive() {
    if (!liveState || !liveState.eventId || !liveState.songId) return;
    followDirector = true; browseOverride = false;
    localStorage.setItem(FOLLOW_KEY, 'true');
    if ($('fcFollow')) $('fcFollow').checked = true;
    window.currentEventId = liveState.eventId;
    var ev = window.findEvent(liveState.eventId);
    if (ev) window.openEvent(liveState.eventId);
    openingFromLive = true;
    window.openSong(liveState.songId, 'vplaylist');
    openingFromLive = false;
    window.requestAnimationFrame(function () { applyLivePosition(); renderMiniPlayer(); });
    renderMiniPlayer();
  }
  function updateMemberPresence() {
    Object.keys(memberList || {}).forEach(function (uid) {
      var online = !!(presenceMap[uid] && presenceMap[uid].online);
      if (!online) online = Object.keys(deviceList || {}).some(function (deviceUid) {
        return deviceList[deviceUid] && deviceList[deviceUid].memberUid === uid && presenceMap[deviceUid] && presenceMap[deviceUid].online;
      });
      memberList[uid].online = online;
    });
  }
  function renderMembersStatus() {
    updateMemberPresence();
    var online = 0;
    Object.keys(memberList || {}).forEach(function (uid) { if (memberList[uid] && memberList[uid].online) online++; });
    setText('fcOnlineCount', Object.keys(memberList || {}).length + '/6 integrantes · ' + online + ' en línea');
  }

  // Las escrituras locales del director se publican en la base compartida.
  window.save = function () {
    if (typeof originalSave === 'function') originalSave();
    if (!applyingRemote && db && bandId && isTechnicalOwner()) {
      var payload = mapById(window.songs || []), serialized = safeJson(payload);
      // Evita volver a subir todo el catálogo al abrir una canción si nada cambió.
      if (serialized !== lastCatalogJson) {
        lastCatalogJson = serialized;
        db.ref(bandPath('catalog')).set(payload).catch(function (err) { setStatus('Error al publicar el catálogo: ' + err.message, 'error'); });
      }
    }
  };
  window.saveEvents = function () {
    if (typeof originalSaveEvents === 'function') originalSaveEvents();
    if (!applyingRemote && db && bandId && (isTechnicalOwner() || memberRole === 'voice1')) {
      var payload = mapById(window.events || []), serialized = safeJson(payload);
      if (serialized !== lastEventsJson) {
        lastEventsJson = serialized;
        db.ref(bandPath('events')).set(payload).catch(function (err) { setStatus('Error al publicar los eventos: ' + err.message, 'error'); });
      }
    }
  };
  window.openSong = function (id, backTo) {
    if (!openingFromLive && memberRole !== 'voice1' && liveState && liveState.songId) {
      if (id !== liveState.songId) browseOverride = true;
      else browseOverride = false;
    }
    if (typeof originalOpenSong === 'function') originalOpenSong(id, backTo);
    applyRoleToCurrentSong();
    renderMiniPlayer();
  };
  window.show = function (id) {
    if (typeof originalShow === 'function') originalShow(id);
    document.body.classList.toggle('fc-reader-open', id === 'vr');
    if (id === 'vm') updateSyncButtons();
    else if (id === 'vl' || id === 'vse' || id === 'vplaylist' || id === 'vr') setTimeout(handleLiveUpdate, 0);
    renderMiniPlayer();
  };

  // Editor de evento: asignación independiente por canción para acordeonista y tecladista.
  window.editEvent = function (id) {
    if (isConnected() && !canManageEvents()) { alert('Solo Voz 1 · Director o el propietario técnico pueden editar los eventos.'); return; }
    var ev = id ? window.findEvent(id) : null;
    window.eventEditId = id || null;
    window.eventDraftSongIds = ev ? (ev.songIds || []).slice() : [];
    eventDraftAssignments = ev && ev.assignments ? JSON.parse(JSON.stringify(ev.assignments)) : {};
    window.eventDraftSongIds.forEach(function (songId) { if (!eventDraftAssignments[songId]) eventDraftAssignments[songId] = eventAssignmentDefaults(); });
    $('eventEditorHeading').textContent = ev ? 'Editar evento' : 'Nuevo evento';
    $('eventName').value = ev ? ev.name : '';
    $('eventSongSearch').value = '';
    $('eventDelete').style.display = ev ? '' : 'none';
    window.renderEventEditor();
    window.show('vset');
  };
  window.renderEventEditor = function () {
    var chosen = $('eventSelected'); chosen.innerHTML = '';
    $('eventSelectedCount').textContent = window.eventDraftSongIds.length + ' seleccionadas · aprox. ' + window.formatDurationLong(window.eventDuration(window.eventDraftSongIds));
    if (!window.eventDraftSongIds.length) { var msg = document.createElement('p'); msg.className = 'note'; msg.textContent = 'Aún no agregas canciones. Selecciónalas en el catálogo de abajo.'; chosen.appendChild(msg); }
    window.eventDraftSongIds.forEach(function (id, i) {
      var s = window.find(id), row = document.createElement('div'); row.className = 'event-selected-row fc-event-selected-row';
      var head = document.createElement('div'); head.className = 'fc-event-song-head';
      var pos = document.createElement('span'); pos.className = 'event-position'; pos.textContent = i + 1;
      var title = document.createElement('span'); title.className = 'event-selected-title'; title.textContent = s ? s.title : 'Canción no disponible';
      var duration = document.createElement('small'); duration.className = 'event-selected-time'; duration.textContent = s ? window.formatDuration(window.songDuration(s)) : '--:--';
      var up = document.createElement('button'); up.textContent = '↑'; up.title = 'Subir'; up.disabled = i === 0; up.onclick = function () { window.moveDraftSong(i, -1); };
      var down = document.createElement('button'); down.textContent = '↓'; down.title = 'Bajar'; down.disabled = i === window.eventDraftSongIds.length - 1; down.onclick = function () { window.moveDraftSong(i, 1); };
      var remove = document.createElement('button'); remove.textContent = '×'; remove.title = 'Quitar del evento'; remove.onclick = function () { window.eventDraftSongIds.splice(i, 1); renderEventEditor(); };
      head.append(pos, title, duration, up, down, remove); row.appendChild(head);
      var controls = document.createElement('div'); controls.className = 'fc-assignment-controls';
      var accLabel = document.createElement('label'); accLabel.textContent = 'Acordeonista';
      var acc = document.createElement('select'); [['accordion','Acordeón'],['guitar','Guitarra']].forEach(function (item) { var o = document.createElement('option'); o.value = item[0]; o.textContent = item[1]; acc.appendChild(o); });
      var keyLabel = document.createElement('label'); keyLabel.textContent = 'Tecladista';
      var key = document.createElement('select'); [['keyboard','Teclado'],['guitar','Guitarra']].forEach(function (item) { var o = document.createElement('option'); o.value = item[0]; o.textContent = item[1]; key.appendChild(o); });
      var existing = eventDraftAssignments[id] || eventAssignmentDefaults(); acc.value = existing.accordionist || 'accordion'; key.value = existing.keyboardist || 'keyboard';
      acc.onchange = function () { if (!eventDraftAssignments[id]) eventDraftAssignments[id] = eventAssignmentDefaults(); eventDraftAssignments[id].accordionist = acc.value; };
      key.onchange = function () { if (!eventDraftAssignments[id]) eventDraftAssignments[id] = eventAssignmentDefaults(); eventDraftAssignments[id].keyboardist = key.value; };
      accLabel.appendChild(acc); keyLabel.appendChild(key); controls.append(accLabel, keyLabel); row.appendChild(controls); chosen.appendChild(row);
    });
    window.renderSongPicker();
  };
  window.saveEventEditor = function () {
    if (isConnected() && !canManageEvents()) { alert('Solo Voz 1 · Director o el propietario técnico pueden guardar eventos.'); return; }
    var name = $('eventName').value.trim();
    if (!name) { alert('Escribe el nombre del evento.'); $('eventName').focus(); return; }
    var ev = window.eventEditId ? window.findEvent(window.eventEditId) : null;
    if (!ev) { ev = { id: 'evt_' + Date.now(), name: name, songIds: [], assignments: {}, createdAt: Date.now() }; window.events.push(ev); }
    ev.name = name; ev.songIds = window.eventDraftSongIds.slice(); ev.assignments = {};
    ev.songIds.forEach(function (id) { ev.assignments[id] = eventDraftAssignments[id] || eventAssignmentDefaults(); });
    ev.updatedAt = Date.now(); window.saveEvents(); window.renderEvents(); window.currentEventId = ev.id; window.openEvent(ev.id);
  };

  window.renderEvents = function () {
    var l = $('eventList'); if (!l) return; l.innerHTML = '';
    if (!window.events.length) { var empty = document.createElement('div'); empty.className = 'playlist-empty'; empty.innerHTML = 'Todavía no hay carpetas de eventos.<br>Pulsa <b>+ Nuevo</b>, escribe el nombre y selecciona canciones del catálogo.'; l.appendChild(empty); return; }
    window.events.slice().sort(function (a,b) { return (a.createdAt || 0) - (b.createdAt || 0); }).forEach(function (ev) {
      var row = document.createElement('div'); row.className = 'event-folder';
      var icon = document.createElement('span'); icon.className = 'event-folder-icon'; icon.textContent = '📁';
      var main = document.createElement('button'); main.className = 'event-folder-main';
      var name = document.createElement('span'); name.className = 'event-folder-name'; name.textContent = ev.name || 'Evento sin nombre';
      var meta = document.createElement('span'); meta.className = 'event-folder-meta';
      var isLive = liveState && liveState.eventId === ev.id;
      meta.textContent = (ev.songIds || []).length + ' canciones · aprox. ' + window.formatDurationLong(window.eventDuration(ev.songIds)) + (isLive ? ' · EN VIVO' : '');
      main.append(name, meta); main.onclick = function () { window.openEvent(ev.id); };
      row.append(icon, main);
      if (!isConnected() || canManageEvents()) { var edit = document.createElement('button'); edit.className = 'event-folder-edit'; edit.textContent = 'Editar'; edit.onclick = function () { window.editEvent(ev.id); }; row.appendChild(edit); }
      l.appendChild(row);
    });
  };
  window.openEvent = function (id) { var ev = window.findEvent(id); if (!ev) return; window.currentEventId = id; window.renderEventPlaylist(); window.show('vplaylist'); };
  window.renderEventPlaylist = function () {
    var ev = window.findEvent(window.currentEventId); if (!ev) return;
    $('playlistName').textContent = ev.name;
    $('playlistMeta').textContent = (ev.songIds || []).length + ' canciones · duración aproximada: ' + window.formatDuration(window.eventDuration(ev.songIds)) + ' (' + window.formatDurationLong(window.eventDuration(ev.songIds)) + ')' + (isConnected() ? ' · Banda sincronizada' : ' · Guardado en este teléfono');
    $('playlistMode').textContent = isConnected() ? roleName(memberRole) : (window.mode === 's' ? 'Vista cantante' : 'Vista bajista');
    $('playlistModeToggle').style.display = 'none';
    $('playlistEdit').style.display = (!isConnected() || canManageEvents()) ? '' : 'none';
    $('eventShare').style.display = isConnected() ? 'none' : '';
    var shareArea = document.querySelector('.event-share-area'); if (shareArea) shareArea.style.display = isConnected() ? 'none' : '';
    var l = $('playlistSongs'); l.innerHTML = '';
    if (!ev.songIds || !ev.songIds.length) { var empty = document.createElement('div'); empty.className = 'playlist-empty'; empty.textContent = 'Esta carpeta todavía no tiene canciones.'; l.appendChild(empty); return; }
    ev.songIds.forEach(function (id, i) {
      var s = window.find(id); if (!s) return;
      var row = document.createElement('div'); row.className = 'playlist-song';
      if (liveState && liveState.eventId === ev.id && liveState.songId === id) row.classList.add('fc-live-song');
      var no = document.createElement('span'); no.className = 'playlist-number'; no.textContent = String(i + 1).padStart(2, '0');
      var open = document.createElement('button'); open.className = 'playlist-open';
      var title = document.createElement('strong'); title.textContent = s.title;
      var detail = document.createElement('small');
      var assignment = ev.assignments && ev.assignments[id] || eventAssignmentDefaults();
      detail.textContent = (s.key ? 'Tono ' + s.key : 'Sin tonalidad') + ' · ' + window.formatDuration(window.songDuration(s)) + ' aprox.' + (memberRole === 'accordionist' ? ' · Tú: ' + (assignment.accordionist === 'guitar' ? 'Guitarra' : 'Acordeón') : memberRole === 'keyboardist' ? ' · Tú: ' + (assignment.keyboardist === 'guitar' ? 'Guitarra' : 'Teclado') : '');
      open.append(title, detail); open.onclick = function () { window.openSong(s.id, 'vplaylist'); };
      row.append(no, open);
      if (memberRole === 'voice1' && db && bandId) { var play = document.createElement('button'); play.className = 'p fc-play-song'; play.textContent = (liveState && liveState.songId === id && liveState.eventId === ev.id) ? 'En curso' : '▶ Tocar'; play.disabled = liveState && liveState.songId === id && liveState.eventId === ev.id; play.onclick = function () { setLiveSong(ev.id, s.id, i); window.openSong(s.id, 'vplaylist'); }; row.appendChild(play); }
      l.appendChild(row);
    });
    renderLiveBanner();
  };

  function renderRoleCurrentNext() {
    var next = currentNextSong();
    setText('fcRoleCurrentSong', window.cur ? window.cur.title : 'Sin canción');
    setText('fcRoleNextSong', next ? next.title : 'Fin del repertorio');
  }
  // Oculta controles administrativos a los seguidores una vez que están autenticados.
  function profileButtonActions() {
    if ($('fcInstrumentSelect')) $('fcInstrumentSelect').onchange = function () {
      if (!window.cur) return;
      var key = (window.currentEventId || 'catalog') + ':' + window.cur.id + ':' + memberRole;
      instrumentOverrides[key] = this.value; localStorage.setItem(OVERRIDE_KEY, safeJson(instrumentOverrides));
      applyRoleToCurrentSong();
    };
    if ($('fcFollow')) $('fcFollow').onchange = function () { followDirector = this.checked; browseOverride = !followDirector; localStorage.setItem(FOLLOW_KEY, String(followDirector)); renderRoleBar(effectiveInstrument(window.cur && window.cur.id)); if (followDirector) returnToLive(); else renderMiniPlayer(); };
    if ($('fcFollowToggle')) $('fcFollowToggle').onclick = function () { followDirector = !followDirector; browseOverride = !followDirector; localStorage.setItem(FOLLOW_KEY, String(followDirector)); if ($('fcFollow')) $('fcFollow').checked = followDirector; renderRoleBar(effectiveInstrument(window.cur && window.cur.id)); if (followDirector) returnToLive(); else renderMiniPlayer(); };
    if ($('fcDirectorButton')) $('fcDirectorButton').onclick = function () { if (!window.cur || !window.currentEventId) { alert('Abre primero la canción desde una carpeta de evento.'); return; } var ev = window.findEvent(window.currentEventId); var index = ev ? ev.songIds.indexOf(window.cur.id) : -1; if (index >= 0) setLiveSong(ev.id, window.cur.id, index); };
  }
  function hideFirstProfileGate() {
    var gate = $('fcFirstProfileGate');
    if (gate) gate.style.display = 'none';
  }
  function maybeShowFirstProfileGate() {
    if (selectedProfileRole || memberProfile || !currentUser || firstProfileGateShown) return;
    try { if (new URL(window.location.href).searchParams.get('fc_pair')) return; } catch (e) {}
    var gate = $('fcFirstProfileGate');
    if (!gate) return;
    firstProfileGateShown = true;
    gate.style.display = 'grid';
  }
  async function checkForAppUpdates() {
    var button = $('fcCheckUpdates');
    var label = $('fcUpdateStatus');
    if (button) { button.disabled = true; button.textContent = 'Comprobando…'; }
    if (label) label.textContent = 'Buscando una versión nueva…';
    try {
      if (!('serviceWorker' in navigator)) {
        if (label) label.textContent = 'Este navegador no admite actualización automática. Recarga la página desde Safari.';
        return;
      }
      var registration = await navigator.serviceWorker.getRegistration('./');
      if (!registration) registration = await navigator.serviceWorker.register('./sw.js?v=15');
      var controllerChanged = new Promise(function (resolve) {
        var finished = false;
        var finish = function () {
          if (finished) return;
          finished = true;
          navigator.serviceWorker.removeEventListener('controllerchange', finish);
          resolve(true);
        };
        navigator.serviceWorker.addEventListener('controllerchange', finish);
        setTimeout(function () { if (!finished) { finished = true; navigator.serviceWorker.removeEventListener('controllerchange', finish); resolve(false); } }, 10000);
      });
      await registration.update();
      var worker = registration.installing || registration.waiting;
      if (registration.waiting) registration.waiting.postMessage({ type: 'FC_SKIP_WAITING' });
      if (worker) {
        var activated = await new Promise(function (resolve) {
          var done = false;
          function finish(value) { if (done) return; done = true; worker.removeEventListener('statechange', onState); resolve(value); }
          function onState() {
            if (worker.state === 'activated') finish(true);
            else if (worker.state === 'redundant') finish(false);
          }
          worker.addEventListener('statechange', onState);
          onState();
          setTimeout(function () { finish(worker.state === 'activated'); }, 10000);
        });
        if (!activated) throw new Error('El navegador no pudo activar la nueva versión.');
        await Promise.race([controllerChanged, new Promise(function (resolve) { setTimeout(resolve, 2500); })]);
        if (label) label.textContent = 'Actualización aplicada. Abriendo ' + APP_VERSION + '…';
        setTimeout(function () { window.location.reload(); }, 350);
        return;
      }
      var controllerWasChanged = await Promise.race([controllerChanged, new Promise(function (resolve) { setTimeout(function () { resolve(false); }, 2500); })]);
      if (controllerWasChanged) {
        if (label) label.textContent = 'Actualización aplicada. Abriendo ' + APP_VERSION + '…';
        setTimeout(function () { window.location.reload(); }, 350);
      } else if (label) label.textContent = 'Frecuencia Cero ya está actualizada · ' + APP_VERSION + '.';
    } catch (err) {
      if (label) label.textContent = 'No se pudo comprobar la actualización. Verifica Internet y vuelve a intentarlo.';
      console.warn('Frecuencia Cero update check:', err);
    } finally {
      if (button) { button.disabled = false; button.textContent = '↻ Buscar actualizaciones'; }
    }
  }

  function initUi() {
    var menu = document.querySelector('#vm .menu-content');
    if (menu && !$('fcSyncPanel')) {
      var panel = document.createElement('section'); panel.id = 'fcSyncPanel'; panel.className = 'fc-sync-panel';
      panel.innerHTML = '<div class="fc-panel-head"><div><strong>Mi banda y sincronización</strong><p class="note">La primera vez eliges tu perfil. Para incorporar a otra persona, debe solicitar acceso y el propietario la aprueba. El QR sirve para vincular otro teléfono o tablet al mismo perfil.</p></div><span class="fc-panel-icon">☁️</span></div>' +
        '<div id="fcSyncStatus" class="fc-status neutral">Conectando con Firebase…</div>' +
        '<div class="fc-band-box"><strong>Mi perfil en Frecuencia Cero</strong><label class="fc-field-label" for="fcProfileSelect">Selecciona quién utiliza este teléfono</label><select id="fcProfileSelect"><option value="">Seleccionar perfil…</option><option value="voice1">Voz 1 · Hombre (Director)</option><option value="voice2">Voz 2 · Mujer</option><option value="bass">Bajista</option><option value="accordionist">Acordeonista</option><option value="drummer">Baterista</option><option value="keyboardist">Tecladista</option></select><button id="fcProfileSave" class="p">Guardar mi perfil</button><p id="fcBandSummary" class="note">Selecciona tu perfil para continuar.</p><label class="fc-field-label" for="fcBandName">Nombre de la banda</label><input id="fcBandName" placeholder="Frecuencia Cero" value="Frecuencia Cero"><button id="fcCreateBand" class="p" style="display:none">Crear banda como propietario técnico</button><div id="fcOwnerMismatch" class="fc-pair-box" style="display:none"><strong>Este parece ser el primer dispositivo, pero el UID no coincide con el propietario configurado.</strong><p class="note">No necesitas QR para iniciar la banda. Copia este ID actual y actualizaremos la autorización de Firebase.</p><code id="fcCurrentOwnerUid"></code><button type="button" id="fcCopyCurrentOwnerUid">Copiar ID actual</button></div><button id="fcRequestJoin" class="p" style="display:none">Solicitar incorporación</button><p class="note">El propietario crea la banda primero. Una vez conectada, utiliza el botón independiente para generar un QR. Los demás integrantes solicitan acceso y el propietario los aprueba; un QR vincula otro teléfono al mismo perfil.</p><div class="note">ID de este teléfono: <code id="fcDeviceUid">Preparando…</code> <button id="fcCopyUid" style="display:none">Copiar ID</button></div><div id="fcPairActions" class="fc-pair-actions"><div class="fc-member-head"><strong>Vincular otro dispositivo</strong></div><p id="fcPairHelp" class="note">El dispositivo autorizado genera el QR; el dispositivo nuevo lo escanea.</p><button id="fcLinkDevice" type="button" style="display:none">▦ Generar código QR</button><button id="fcScanDeviceLink" class="p" style="display:none">📷 Escanear código QR</button></div><div id="fcPairQrBox" class="fc-pair-box" style="display:none"></div><div id="fcPairScannerWrap" class="fc-pair-box" style="display:none"><div id="fcPairScanner"></div><p id="fcPairScannerStatus" class="note">Preparando cámara…</p><button type="button" id="fcPairScannerClose">Cerrar cámara</button></div></div>' +
        '<div id="fcJoinRequests" class="fc-member-admin" style="display:none"><div class="fc-member-head"><strong>Solicitudes de integrantes</strong></div><div id="fcJoinRequestsList"></div></div>' +
        '<div id="fcMemberAdmin" class="fc-member-admin" style="display:none"><div class="fc-member-head"><strong>Integrantes y funciones (6 plazas)</strong><span id="fcOnlineCount" class="note"></span></div><p class="note">El propietario técnico administra el catálogo, integrantes y dispositivos. Voz 1 dirige los eventos y puede crear y organizar repertorios. Cada función se asigna a una sola persona.</p><div id="fcMembers"></div></div>' +
        '<div id="fcMyDevicesBox" class="fc-member-admin" style="display:none"><div class="fc-member-head"><strong>Mis dispositivos vinculados</strong></div><p class="note">Puedes vincular varios teléfonos o tablets a tu mismo perfil y revocar los que ya no utilices.</p><div id="fcMyDevices"></div></div>' +
        '<label class="fc-follow-row"><input type="checkbox" id="fcFollow" checked> Seguir automáticamente la canción que elija Voz 1</label>';
      var insertion = $('mi'); menu.insertBefore(panel, insertion);
    }
    if (!$('fcFirstProfileGate')) {
      var gate = document.createElement('div'); gate.id = 'fcFirstProfileGate'; gate.className = 'fc-profile-gate'; gate.style.display = 'none';
      gate.innerHTML = '<div class="fc-profile-card"><div class="fc-profile-brand">♫</div><strong class="fc-profile-title">Frecuencia Cero</strong><p class="note">Primera configuración: selecciona quién utiliza este dispositivo. Se guardará para las próximas veces.</p><div class="fc-profile-grid"><button data-role="voice1"><b>🎤 Voz 1</b><small>Director musical</small></button><button data-role="voice2"><b>🎤 Voz 2</b><small>Cantante</small></button><button data-role="bass"><b>🎸 Bajista</b><small>Acordes</small></button><button data-role="accordionist"><b>🪗 Acordeonista</b><small>Acordeón / guitarra</small></button><button data-role="drummer"><b>🥁 Baterista</b><small>Seguimiento</small></button><button data-role="keyboardist"><b>🎹 Tecladista</b><small>Teclado / guitarra</small></button></div><p class="note fc-profile-foot">Si eres otra persona que se incorpora a la banda, elige tu función y solicita acceso. Si es otro teléfono o tablet de alguien ya autorizado, escanea el QR que genere uno de sus dispositivos.</p><div class="note">ID de este teléfono: <code id="fcGateUid">Preparando…</code> <button type="button" id="fcGateCopyUid">Copiar ID</button></div><button type="button" id="fcProfileGateQr">Ya tengo un QR para vincular</button></div>';
      document.body.appendChild(gate);
      Array.prototype.forEach.call(gate.querySelectorAll('[data-role]'), function (button) {
        button.onclick = function () {
          var role = button.dataset.role;
          selectedProfileRole = role; localStorage.setItem(PROFILE_KEY, role);
          hideFirstProfileGate(); updateSyncButtons();
          setStatus(role === 'accordionist' && currentUser && currentUser.uid !== OWNER_UID ? 'Perfil Acordeonista seleccionado. No escanees QR: copia el UID actual en Más → Mi banda y sincronización para ajustar la autorización inicial.' : 'Perfil guardado: ' + roleName(role) + '. Completa la incorporación en Más → Mi banda y sincronización.', role === 'accordionist' && currentUser && currentUser.uid !== OWNER_UID ? 'warning' : 'success');
          if (typeof window.show === 'function') window.show('vm');
        };
      });
      var gateQr = $('fcProfileGateQr'); if (gateQr) gateQr.onclick = function () { hideFirstProfileGate(); if (typeof window.show === 'function') window.show('vm'); setTimeout(function () { if ($('fcScanDeviceLink')) $('fcScanDeviceLink').click(); }, 250); };
      var gateCopy = $('fcGateCopyUid'); if (gateCopy) gateCopy.onclick = function () { var uid = currentUser && currentUser.uid || ''; if (!uid) return; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(uid).then(function () { alert('ID copiado: ' + uid); }).catch(function () { alert('ID de este teléfono: ' + uid); }); else alert('ID de este teléfono: ' + uid); };
    }
    if (!$('fcMiniPlayer')) {
      var mini = document.createElement('aside'); mini.id = 'fcMiniPlayer'; mini.className = 'fc-mini-player'; mini.style.display = 'none';
      mini.innerHTML = '<div class="fc-mini-top"><span class="fc-mini-live-dot"></span><span id="fcMiniMode">EN VIVO</span><span class="fc-mini-event" id="fcMiniEvent"></span><span class="fc-mini-state" id="fcMiniState"></span></div><div class="fc-mini-main"><div class="fc-mini-copy"><strong id="fcMiniSong">—</strong><span id="fcMiniLine">Esperando canción del director…</span></div><button type="button" id="fcMiniReturn">Volver a sincronía</button></div><div class="fc-mini-progress-track"><span id="fcMiniProgress"></span></div><span class="fc-mini-progress-text" id="fcMiniProgressText"></span>';
      document.body.appendChild(mini);
    }
    var listView = $('vl');
    if (listView && !$('fcLiveBanner')) {
      var banner = document.createElement('button'); banner.id = 'fcLiveBanner'; banner.className = 'fc-live-banner'; banner.style.display = 'none'; banner.innerHTML = '<span class="fc-live-dot"></span><span id="fcLiveBannerText">EN VIVO</span><span>Ver</span>';
      banner.onclick = function () { if (liveState && liveState.eventId && liveState.songId) { window.currentEventId = liveState.eventId; window.openEvent(liveState.eventId); window.openSong(liveState.songId, 'vplaylist'); } };
      var list = $('list'); listView.insertBefore(banner, list);
    }
    var reader = $('vr');
    if (reader && !$('fcRoleBar')) {
      var rolebar = document.createElement('div'); rolebar.id = 'fcRoleBar'; rolebar.className = 'fc-role-bar'; rolebar.style.display = 'none';
      rolebar.innerHTML = '<div class="fc-role-line"><strong id="fcRoleDescription">Integrante</strong><div class="fc-role-actions"><button id="fcFollowToggle" style="display:none">Siguiendo director</button><button id="fcDirectorButton" style="display:none">▶ Poner en curso para todos</button></div></div><select id="fcInstrumentSelect" style="display:none" aria-label="Mi instrumento en esta canción"></select>';
      reader.insertBefore(rolebar, $('rd'));
      var panel = document.createElement('div'); panel.id = 'fcNextOnlyPanel'; panel.className = 'fc-next-only'; panel.style.display = 'none';
      panel.innerHTML = '<div class="fc-next-chip" id="fcRoleInstrumentName">Instrumento</div><div class="fc-next-caption">CANCIÓN ACTUAL</div><div class="fc-next-current" id="fcRoleCurrentSong">—</div><div class="fc-next-caption">SIGUIENTE CANCIÓN</div><div class="fc-next-title" id="fcRoleNextSong">—</div><div class="fc-next-key" id="fcRoleCurrentKey"></div><p class="note">Tu pantalla está siguiendo el repertorio del evento. Cambia tu instrumento arriba si hoy te toca guitarra.</p>';
      reader.insertBefore(panel, $('rd'));
    }
  }

  function bindUi() {
    if ($('fcConnect')) $('fcConnect').onclick = connectFirebase;
    if ($('fcSignIn')) $('fcSignIn').onclick = signIn;
    if ($('fcSignOut')) $('fcSignOut').onclick = signOut;
    if ($('fcCreateBand')) $('fcCreateBand').onclick = handleOwnerBandAction;
    if ($('fcRequestJoin')) $('fcRequestJoin').onclick = requestJoin;
    if ($('fcLinkDevice')) $('fcLinkDevice').onclick = handleGeneratePairQr;
    if ($('fcCheckUpdates')) $('fcCheckUpdates').onclick = checkForAppUpdates;
    if ($('fcScanDeviceLink')) $('fcScanDeviceLink').onclick = startPairScanner;
    if ($('fcPairScannerClose')) $('fcPairScannerClose').onclick = stopPairScanner;
    if ($('fcProfileSave')) $('fcProfileSave').onclick = function () {
      var role = $('fcProfileSelect').value;
      if (!role) { alert('Selecciona una función.'); return; }
      if (isConnected()) { alert('Tu función ya fue asignada por el propietario técnico. Para cambiarla, solicita que actualice tu perfil.'); return; }
      selectedProfileRole = role; localStorage.setItem(PROFILE_KEY, role);
      hideFirstProfileGate();
      updateSyncButtons();
      setStatus(role === 'voice1' ? 'Perfil Voz 1 seleccionado. Solicita incorporación a la banda.' : 'Perfil ' + roleName(role) + ' seleccionado. Pulsa Solicitar incorporación.', 'success');
    };
    if ($('fcProfileSelect')) $('fcProfileSelect').onchange = function () { selectedProfileRole = this.value; updateSyncButtons(); };
    if ($('fcCopyUid')) $('fcCopyUid').onclick = function () {
      var uid = currentUser && currentUser.uid || '';
      if (!uid) return;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(uid).then(function () { setStatus('ID de este dispositivo copiado.', 'success'); });
      else { setStatus('ID del teléfono: ' + uid, 'neutral'); }
    };
    if ($('fcCopyCurrentOwnerUid')) $('fcCopyCurrentOwnerUid').onclick = function () {
      var uid = currentUser && currentUser.uid || ''; if (!uid) return;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(uid).then(function () { setStatus('UID actual copiado. Envíalo para actualizar la regla del propietario.', 'success'); }).catch(function () { alert('UID actual: ' + uid); });
      else alert('UID actual: ' + uid);
    };
    profileButtonActions();
    if ($('fcMiniReturn')) $('fcMiniReturn').onclick = returnToLive;
    if ($('rd') && !$('rd').dataset.fcLiveScrollBound) {
      $('rd').dataset.fcLiveScrollBound = '1';
      $('rd').addEventListener('scroll', function () {
        if (memberRole !== 'voice1' || window.mode !== 's' || !liveState || !window.cur || liveState.songId !== window.cur.id) return;
        if (scrollPublishTimer) clearTimeout(scrollPublishTimer);
        scrollPublishTimer = setTimeout(syncDirectorRowFromScroll, 120);
      }, { passive: true });
    }
    if ($('play') && !$('play').dataset.fcPlaySyncBound) {
      $('play').dataset.fcPlaySyncBound = '1';
      $('play').addEventListener('click', function () { setTimeout(function () {
        if (memberRole !== 'voice1' || !liveState || !window.cur || liveState.songId !== window.cur.id) return;
        if (window.mode === 'b' && window.bassEvents && window.bassEvents.length) { var ev = window.bassEvents[window.bassIndex] || window.bassEvents[0]; publishLivePosition(ev && ev.line ? Number(ev.line.dataset.lineIndex || 0) : 0, window.bassIndex || 0, !window.chordTimer); }
        else syncDirectorRowFromScroll();
      }, 40); });
    }
  }

  function addStyles() {
    var css = '' +
      '.fc-sync-panel{border:1px solid var(--line);border-radius:16px;padding:13px;background:var(--card);display:flex;flex-direction:column;gap:9px}' +
      '.fc-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.fc-panel-head strong{font-size:17px}.fc-panel-icon{font-size:25px}' +
      '.fc-status{padding:9px 11px;border-radius:10px;font-size:13px;font-weight:700;background:var(--bg)}.fc-status.success{color:#16764b;background:rgba(22,139,88,.10)}.fc-status.warning{color:#946200;background:rgba(220,160,30,.13)}.fc-status.error{color:#b3261e;background:rgba(179,38,30,.10)}' +
      '.fc-field-label{font-size:12px;color:var(--mut);font-weight:800;margin-top:3px}.fc-auth-row,.fc-invite-row{display:flex;gap:7px}.fc-auth-row button,.fc-invite-row button{flex:1;min-width:0}.fc-band-box{border-top:1px solid var(--line);padding-top:10px;display:flex;flex-direction:column;gap:8px}.fc-member-admin{border-top:1px solid var(--line);padding-top:10px}.fc-member-head{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px}.fc-member-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line)}.fc-member-info{flex:1;min-width:0}.fc-member-info strong,.fc-member-info small{display:block;overflow-wrap:anywhere}.fc-member-info small{font-size:11px;color:var(--mut)}.fc-member-row select{width:47%;min-width:128px;padding:7px;font-size:12px}.fc-sync-panel code{font-size:10px;overflow-wrap:anywhere}.fc-sync-panel #fcProfileSelect{width:100%}.fc-sync-panel #fcCopyUid{font-size:11px;min-height:30px;padding:4px 8px}.fc-follow-row{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700}.fc-follow-row input{width:18px;min-height:18px;height:18px}.fc-live-banner{width:calc(100% - 24px);margin:0 12px 8px;text-align:left;background:rgba(22,139,88,.12);border-color:rgba(22,139,88,.35);color:var(--fg);font-size:13px;font-weight:850;display:flex;align-items:center;gap:8px}.fc-live-banner span:nth-child(2){flex:1}.fc-live-dot{width:9px;height:9px;border-radius:100%;background:#16a36a;display:inline-block}.fc-role-bar{padding:8px 12px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--bg)}.fc-role-line{display:flex;align-items:center;justify-content:space-between;gap:7px;width:100%;font-size:12px}.fc-role-line button{font-size:12px;min-height:36px;padding:6px 9px}.fc-role-bar select{min-height:38px;font-size:13px}.fc-next-only{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px 18px;gap:12px;overflow:auto}.fc-next-chip{padding:6px 12px;border-radius:20px;background:var(--acc);color:var(--accfg);font-weight:900;font-size:12px}.fc-next-caption{font-size:11px;color:var(--mut);font-weight:900;letter-spacing:.12em}.fc-next-current{font-size:clamp(25px,6vw,38px);font-weight:900;line-height:1.1}.fc-next-title{font-size:clamp(28px,8vw,48px);font-weight:950;color:var(--acc);line-height:1.08}.fc-next-key{font-size:14px;color:var(--mut);font-weight:800}.fc-event-selected-row{display:block}.fc-event-song-head{display:flex;align-items:center;gap:7px}.fc-assignment-controls{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:7px 3px 2px 29px}.fc-assignment-controls label{font-size:10px;color:var(--mut);font-weight:800}.fc-assignment-controls select{display:block;min-height:35px;font-size:12px;padding:5px;margin-top:3px}.fc-live-song{background:rgba(22,139,88,.09);border-radius:10px;padding-left:8px;padding-right:8px}.fc-play-song{font-size:12px;padding:7px 9px;min-height:36px}' +
      '.fc-member-device{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 8px 8px 28px;font-size:11px;color:var(--mut)}.fc-member-device button{min-height:30px;padding:4px 8px;font-size:11px}.fc-pair-actions{border:1px solid var(--line);border-radius:13px;padding:12px;background:var(--bg);display:flex;flex-direction:column;gap:9px}.fc-pair-actions p{margin:0}.fc-pair-actions button{width:100%;min-height:44px}.fc-pair-box{border:1px solid var(--line);border-radius:13px;padding:12px;background:var(--bg);display:flex;flex-direction:column;gap:9px}.fc-pair-title{font-size:16px;font-weight:900}.fc-pair-qr{display:flex;justify-content:center;align-items:center;background:#fff;border-radius:10px;padding:12px;min-height:230px}.fc-pair-qr img{max-width:100%;height:auto}.fc-pair-url{font-size:10px;color:var(--mut);overflow-wrap:anywhere;user-select:text}.fc-pair-box button{width:100%}' +
      '.fc-live-row-current{outline:1px solid color-mix(in srgb,var(--acc) 25%,transparent);outline-offset:3px;border-radius:7px}.fc-profile-gate{position:fixed;inset:0;z-index:2000;display:grid;place-items:center;padding:18px;background:rgba(7,14,25,.78);backdrop-filter:blur(7px)}.fc-profile-card{width:min(100%,480px);max-height:90dvh;overflow:auto;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:22px;padding:20px;box-shadow:0 18px 60px rgba(0,0,0,.3);display:flex;flex-direction:column;gap:12px}.fc-profile-brand{width:48px;height:48px;border-radius:15px;display:grid;place-items:center;background:var(--acc);color:var(--accfg);font-size:28px}.fc-profile-title{font-size:24px}.fc-profile-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.fc-profile-grid button{min-height:76px;text-align:left;display:flex;flex-direction:column;gap:4px;padding:11px}.fc-profile-grid button b{font-size:14px}.fc-profile-grid button small{color:var(--mut);font-size:11px}.fc-profile-foot{margin:0}.fc-mini-player{position:fixed;left:10px;right:10px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:1100;display:flex;flex-direction:column;gap:5px;padding:9px 11px 7px;border:1px solid color-mix(in srgb,var(--acc) 38%,var(--line));border-radius:14px;background:color-mix(in srgb,var(--card) 94%,transparent);color:var(--fg);box-shadow:0 8px 26px rgba(0,0,0,.18);backdrop-filter:blur(12px)}body.fc-reader-open .fc-mini-player{bottom:calc(98px + env(safe-area-inset-bottom))}.fc-mini-top{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:900;letter-spacing:.06em;color:var(--mut);min-width:0}.fc-mini-live-dot{width:8px;height:8px;border-radius:50%;background:#18a66a;flex:0 0 auto}.fc-mini-player.is-paused .fc-mini-live-dot{background:#d49b2e}.fc-mini-event{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-weight:700;letter-spacing:0}.fc-mini-state{white-space:nowrap}.fc-mini-main{display:flex;align-items:center;gap:9px;min-width:0}.fc-mini-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.fc-mini-copy strong{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fc-mini-copy span{font-size:11px;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fc-mini-main button{min-height:35px;padding:6px 9px;font-size:11px;font-weight:850;white-space:nowrap}.fc-mini-player.is-free{border-color:color-mix(in srgb,#d49b2e 55%,var(--line))}.fc-mini-progress-track{height:3px;background:var(--line);border-radius:99px;overflow:hidden}.fc-mini-progress-track span{height:100%;display:block;width:0;background:var(--acc);transition:width .2s}.fc-mini-progress-text{position:absolute;right:11px;top:8px;font-size:9px;color:var(--mut);display:none}#list{padding-bottom:100px}.event-list{padding-bottom:100px}';
    var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  }

  function startAutoConnect() {
    if (window.firebase) connectFirebase();
    else setStatus('Firebase no se ha cargado. Comprueba Internet y vuelve a abrir la página.', 'error');
    if ($('fcProfileSelect') && selectedProfileRole) $('fcProfileSelect').value = selectedProfileRole;
    if (currentUser) { setText('fcGateUid', currentUser.uid); setText('fcCurrentOwnerUid', currentUser.uid); }
    if (selectedProfileRole) hideFirstProfileGate();
    updateSyncButtons();
  }

  initUi(); addStyles(); bindUi();
  // Recalcula la vista personal al volver desde lista/evento.
  var oldRenderPlaylist = window.renderEventPlaylist;
  // La función renderEventPlaylist ya fue sustituida; llamamos su resultado y actualizamos controles.
  var oldOpenEvent = window.openEvent;
  var _openEvent = window.openEvent;
  window.openEvent = function (id) { _openEvent(id); renderRoleCurrentNext(); };
  var oldDelete = $('eventDelete').onclick;
  $('eventDelete').onclick = function () {
    if (isConnected() && !canManageEvents()) { alert('Solo Voz 1 · Director o el propietario técnico pueden borrar eventos.'); return; }
    if (oldDelete) oldDelete();
  };
  $('eventNew').onclick = function () { window.editEvent(null); };
  $('eventSave').onclick = window.saveEventEditor;
  $('playlistEdit').onclick = function () { window.editEvent(window.currentEventId); };
  $('eventEditBack').onclick = function () { window.renderEvents(); window.show('vse'); };
  $('eventCancel').onclick = function () { window.renderEvents(); window.show('vse'); };
  $('eventShare').style.display = 'none';
  if ($('playlistBack')) $('playlistBack').onclick = function () { window.show('vse'); };
  if ($('fcLiveBanner')) $('fcLiveBanner').onclick = returnToLive;
  if ($('tmode')) $('tmode').addEventListener('click', function () { if (isConnected()) { setTimeout(applyRoleToCurrentSong, 0); } });
  window.addEventListener('online', function () { if (currentUser && bandId && db) setStatus('Conexión recuperada. Sincronizando…', 'success'); renderMiniPlayer(); });
  window.addEventListener('offline', function () { if (currentUser && bandId) setStatus('Sin Internet. Se conserva la última información descargada; los cambios se sincronizarán al reconectar.', 'warning'); renderMiniPlayer(); });
  renderEvents(); renderLiveBanner(); startAutoConnect(); updateSyncButtons();
  if (selectedProfileRole) hideFirstProfileGate();
  else setTimeout(maybeShowFirstProfileGate, 1800);
})();
