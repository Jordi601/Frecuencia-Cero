/* Frecuencia Cero - roles y sincronizacion en vivo.
   La app sigue funcionando localmente si Firebase no esta configurado.
   Para sincronizar varios telefonos hay que configurar Firebase una sola vez por proyecto. */
(function () {
  'use strict';

  var APP_VERSION = 'V27';
  var CFG_KEY = 'fc_firebase_config_v1';
  var BAND_KEY = 'fc_band_id_v1';
  var PROFILE_KEY = 'fc_device_profile_v1';
  var ACCESS_REVOKED_KEY = 'fc_band_access_revoked_v17';
  var ACCESS_REVOKED_MODE_KEY = 'fc_band_access_revoked_mode_v17';
  var IDENTITY_KIND_KEY = 'fc_identity_kind_v17';
  var accessRevoked = localStorage.getItem(ACCESS_REVOKED_KEY) === '1';
  var accessVerificationPending = !!localStorage.getItem(BAND_KEY) && !accessRevoked;
  var revocationMode = localStorage.getItem(ACCESS_REVOKED_MODE_KEY) || 'member';
  var handlingRevocation = false;
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
  var OVERRIDE_KEY = 'fc_instrument_overrides_v2';
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
  var catalogWriteQueue = Promise.resolve();
  var catalogWriteQueuedJson = '';
  var eventsWriteQueue = Promise.resolve();
  var eventsWriteQueuedJson = '';
  var eventDragState = null;
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
  var activeLiveEventOnThisClient = '';
  var lastEndedLiveEventKey = '';
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
  var pairInvitePromptToken = '';
  var serverClockRef = null;
  var serverClockOffsetMs = 0;
  var serverClockReady = false;
  var browseOverride = false;
  var openingFromLive = false;
  var lastRemotePositionKey = '';
  var lastPublishedPositionKey = '';
  var scrollPublishTimer = null;
  var firstProfileGateShown = false;
  var incomingMemberInviteToken = '';
  var incomingMemberInvite = null;
  var memberInviteCheckStarted = false;
  var genericJoinLink = false;
  var ownerLocalMigrationPrompted = false;
  var currentMemberInviteLink = '';
  var accessLinkProcessing = false;
  // Seguimiento por voz: el micrófono solo se activa tras una acción explícita de Voz 1.
  var speechRecognition = null;
  var speechWanted = false;
  var speechRestartTimer = null;
  var speechCursor = -1;
  var speechCandidate = -1;
  var speechCandidateHits = 0;
  var speechStatus = 'Listo. Inicia el micrófono cuando comience la canción.';
  var speechResumeAfterPause = false;
  var speechLastTranscript = '';
  var playlistDragState = null;
  var queueAddOpen = false;
  var queueSearchText = '';

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
  function isConnected() { return !!(db && auth && currentUser && bandId && memberProfile && memberProfile.role && memberProfile.role !== 'pending' && memberRole !== 'pending'); }
  function isDirector() { return isConnected() ? memberRole === 'voice1' : false; }
  function isTechnicalOwner() {
    if (!currentUser) return false;
    var ownerUid = bandMeta && bandMeta.ownerUid;
    var memberUid = memberProfile && (memberProfile.memberUid || currentUser.uid);
    return currentUser.uid === OWNER_UID || !!(memberProfile && memberProfile.isOwner) || !!(ownerUid && (currentUser.uid === ownerUid || memberUid === ownerUid)) || memberUid === OWNER_UID;
  }
  function canManageCatalog() { return isConnected() && isTechnicalOwner(); }
  function canManageEvents() { return isConnected() && (isTechnicalOwner() || memberRole === 'voice1'); }
  function isLiveSessionActive(state) { state = state === undefined ? liveState : state; return !!(state && state.eventId && state.songId && state.status !== 'ended' && !state.endedAt); }
  function canEndLiveEvent() { return isConnected() && canManageEvents(); }
  function roleName(role) { return ROLE_LABELS[role] || 'Integrante'; }
  function canRequestMembership() {
    return !!(currentUser && db && !bandId && selectedProfileRole && selectedProfileRole !== 'accordionist' && selectedProfileRole !== 'pending' && !(accessRevoked && revocationMode === 'devices'));
  }
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
    if ($('fcProfileEditor')) $('fcProfileEditor').style.display = (!connected && !ownerDevice) ? '' : 'none';
    if ($('fcOwnerCreateCard')) $('fcOwnerCreateCard').style.display = (ownerDevice && !connected) ? '' : 'none';
    if ($('fcProfileSave')) $('fcProfileSave').style.display = (connected || ownerDevice) ? 'none' : '';
    if ($('fcProfileSelect') && ownerDevice && !connected) $('fcProfileSelect').style.display = 'none';
    if ($('fcProfileIdentityBadge')) {
      $('fcProfileIdentityBadge').textContent = connected ? 'Acceso autorizado' : (ownerDevice ? 'Propietario técnico' : 'Sin autorización');
      $('fcProfileIdentityBadge').className = 'fc-access-badge ' + (connected ? 'is-ok' : (ownerDevice ? 'is-owner' : 'is-pending'));
    }
    if ($('fcPairActions')) $('fcPairActions').style.display = connected ? '' : 'none';
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
    if ($('fcRequestJoin')) $('fcRequestJoin').style.display = (!connected && canRequestMembership()) ? '' : 'none';
    if ($('fcRequestJoin')) $('fcRequestJoin').disabled = !signed || !!(window.fcJoinRequestPending);
    if ($('fcLinkDevice')) {
      $('fcLinkDevice').style.display = connected ? '' : 'none';
      $('fcLinkDevice').disabled = !signed;
      $('fcLinkDevice').textContent = '▦ Generar código QR para vincular otro dispositivo';
    }
    if ($('fcScanDeviceLink')) $('fcScanDeviceLink').style.display = 'none';
    if ($('fcPairHelp')) $('fcPairHelp').textContent = connected
      ? 'El QR o enlace añade otro navegador a ESTE perfil: ' + roleName(memberRole) + '. No crea otro integrante ni necesita aprobación. Para añadir un dispositivo de Voz 2, genera el enlace desde una sesión ya autorizada como Voz 2.'
      : 'Primero solicita o completa tu acceso. Después podrás añadir dispositivos a tu propio perfil.';
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
    if ($('fcMemberInvitePanel')) $('fcMemberInvitePanel').style.display = connected && isTechnicalOwner() ? '' : 'none';
    if ($('fcFollow')) $('fcFollow').checked = followDirector;
    var profileBar = $('fcRoleBar');
    if (profileBar) profileBar.style.display = (connected && memberRole !== 'pending') ? '' : 'none';
    if ($('fcDirectorButton')) $('fcDirectorButton').style.display = memberRole === 'voice1' ? '' : 'none';
    if ($('fcProfileSelect') && connected) $('fcProfileSelect').style.display = 'none';
    if ($('eventNew')) $('eventNew').style.display = connected && canManageEvents() ? '' : 'none';
    var legacyImport = document.querySelector('.event-import'); if (legacyImport) legacyImport.style.display = connected ? 'none' : '';
    if ($('playlistEdit')) $('playlistEdit').style.display = connected && canManageEvents() ? '' : 'none';
    if ($('bnew')) $('bnew').style.display = connected && canManageCatalog() ? '' : 'none';
    if ($('bedit')) $('bedit').style.display = connected && canManageCatalog() ? '' : 'none';
    if ($('tmode') && connected) $('tmode').style.display = 'none';
    renderMemberAdmin();
    renderMyDevices();
    renderJoinRequests();
  }
  function startServerClock() {
    if (!db || serverClockRef) return;
    serverClockRef = db.ref('.info/serverTimeOffset');
    serverClockRef.on('value', function (snap) {
      var offset = Number(snap.val());
      serverClockOffsetMs = Number.isFinite(offset) ? offset : 0;
      serverClockReady = true;
    });
  }
  function serverNow() { return Date.now() + serverClockOffsetMs; }
  function waitForServerClock() {
    startServerClock();
    if (serverClockReady) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var started = Date.now();
      function check() {
        if (serverClockReady) { resolve(); return; }
        if (Date.now() - started >= 5000) {
          reject(new Error('No se pudo sincronizar la hora con Firebase. Revisa la conexión y vuelve a intentarlo.'));
          return;
        }
        setTimeout(check, 50);
      }
      check();
    });
  }
  function configFromInput() { return FIREBASE_CONFIG; }
  function connectFirebase() {
    try {
      if (!window.firebase || !firebase.initializeApp) throw new Error('No se pudo cargar Firebase. Comprueba tu conexión a Internet.');
      firebaseApp = firebase.apps.length ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
      auth = firebase.auth();
      db = firebase.database();
      startServerClock();
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
    if (user && user.uid !== OWNER_UID && !accessRevoked) {
      // Cada navegador no reconocido vuelve a elegir perfil; una membresía ya aprobada
      // volverá a cargar su función desde Firebase después de verificar el UID.
      var hasAssignedInviteInUrl = false;
      try { hasAssignedInviteInUrl = new URL(window.location.href).searchParams.has('fc_member_invite'); } catch (e) {}
      if (!hasAssignedInviteInUrl) {
        selectedProfileRole = '';
        try { localStorage.removeItem(PROFILE_KEY); } catch (e) {}
      }
    }
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
    watchOwnMembership();
    maybeProcessIncomingPair();
    maybeProcessIncomingMemberInvite();
    updateSyncButtons();
  }
  function activateMembership(profile, kind) {
    if (!profile || !profile.role || !currentUser) return;
    var id = currentUser.uid + ':' + kind;
    bandId = FIXED_BAND_ID; localStorage.setItem(BAND_KEY, bandId);
    identityKind = kind;
    memberRole = profile.role; memberProfile = profile;
    accessRevoked = false; accessVerificationPending = false; handlingRevocation = false; revocationMode = 'member';
    localStorage.removeItem(ACCESS_REVOKED_KEY); localStorage.removeItem(ACCESS_REVOKED_MODE_KEY);
    localStorage.setItem(IDENTITY_KIND_KEY, kind || 'members');
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
      if (req) {
        if (req.requestedRole) { selectedProfileRole = req.requestedRole; localStorage.setItem(PROFILE_KEY, req.requestedRole); }
        setStatus('Solicitud enviada como ' + roleName(req.requestedRole) + '. Esperando aprobación del propietario técnico.', 'warning');
      } else if (!bandId && currentUser && !memberProfile) setStatus('Selecciona tu perfil o escanea un QR de vinculación.', 'neutral');
      var gateStatus = $('fcGateStatus'); var gateRequest = $('fcGateRequestJoin');
      if (req) {
        if (gateStatus) gateStatus.textContent = 'Tu solicitud como ' + roleName(req.requestedRole) + ' está pendiente de aprobación. El catálogo permanece bloqueado.';
        if (gateRequest) { gateRequest.style.display = ''; gateRequest.disabled = true; gateRequest.textContent = 'Solicitud pendiente'; }
      } else if (accessRevoked) {
        if (gateRequest) { gateRequest.disabled = !selectedProfileRole; gateRequest.textContent = 'Solicitar reincorporación'; }
      }
      updateSyncButtons();
    }, function (err) {
      if (err && err.code !== 'PERMISSION_DENIED') setStatus('No se pudo consultar la solicitud: ' + err.message, 'error');
    });
  }
  function finishUnjoinedIdentity() {
    if (bandId || memberProfile) return;
    if (localStorage.getItem(BAND_KEY)) {
      handleAccessRevoked('Este perfil ya no está autorizado en la banda. Selecciona tu función y solicita nuevamente el acceso.');
      return;
    }
    memberRole = window.fcJoinRequestPending ? 'pending' : 'unjoined';
    identityKind = 'members';
    // Una visita nueva debe elegir su función en esta sesión; no reutilizar una selección local antigua.
    // Se conserva únicamente si ya existe una solicitud o si la URL trae un enlace con función asignada.
    var hasPreassignedInvite = false;
    try { hasPreassignedInvite = new URL(window.location.href).searchParams.has('fc_member_invite'); } catch (e) {}
    if (!window.fcJoinRequestPending && !hasPreassignedInvite) {
      selectedProfileRole = '';
      try { localStorage.removeItem(PROFILE_KEY); } catch (e) {}
    }
    if (currentUser && currentUser.uid !== OWNER_UID) {
      try {
        localStorage.removeItem('fc_v24_legacy_songs_backup'); localStorage.removeItem('fc_v24_legacy_events_backup');
        localStorage.removeItem(window.KEY || 'letras_frecuencia_cero_v3'); localStorage.removeItem(window.EVENT_KEY || 'frecuencia_cero_eventos_v1');
        localStorage.removeItem('letras_v1'); localStorage.removeItem('letras_fc_v2');
      } catch (e) {}
      window.songs = []; window.events = [];
      if (typeof window.render === 'function') window.render(); if (typeof window.renderEvents === 'function') window.renderEvents();
    }
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
      if (accessRevoked && revocationMode === 'devices') throw new Error('Este perfil sigue perteneciendo a la banda. Escanea un nuevo QR desde un dispositivo autorizado para volver a vincular este teléfono.');
      var role = selectedProfileRole || ($('fcProfileSelect') && $('fcProfileSelect').value);
      if (!role || role === 'accordionist' || role === 'pending' || !ROLE_OPTIONS.some(function (r) { return r[0] === role; })) throw new Error('La función Acordeonista está reservada al propietario técnico. Selecciona otra función disponible.');
      if (bandId) throw new Error('Este teléfono ya pertenece a la banda.');
      if (incomingMemberInviteToken && incomingMemberInvite && incomingMemberInvite.role !== role) throw new Error('Esta invitación está reservada para ' + roleName(incomingMemberInvite.role) + '.');
      var reqRef = db.ref('bands/' + FIXED_BAND_ID + '/joinRequests/' + currentUser.uid);
      var existing = await reqRef.once('value');
      if (existing.exists()) { window.fcJoinRequestPending = true; var existingStatus = $('fcGateStatus'); if (existingStatus) existingStatus.textContent = 'Ya existe una solicitud pendiente. El repertorio se abrirá cuando el propietario la apruebe.'; var existingButton = $('fcGateRequestJoin'); if (existingButton) { existingButton.disabled = true; existingButton.textContent = 'Solicitud pendiente'; } updateSyncButtons(); return; }
      var requestData = { requestedRole: role, deviceName: ROLE_LABELS[role], requestedAt: firebase.database.ServerValue.TIMESTAMP, status: 'pending', requestedVia: incomingMemberInviteToken ? 'role-invite-link' : (genericJoinLink ? 'general-invite-link' : 'profile-selection') };
      if (incomingMemberInviteToken) {
        var claimedInvite = await claimMemberInvite(incomingMemberInviteToken, role);
        requestData.inviteToken = incomingMemberInviteToken;
        requestData.invitedBy = claimedInvite.createdBy || '';
        requestData.inviteMode = 'preassigned-role';
      }
      await reqRef.set(requestData);
      selectedProfileRole = role; localStorage.setItem(PROFILE_KEY, role);
      window.fcJoinRequestPending = true;
      if (incomingMemberInviteToken) clearMemberInviteFromUrl();
      incomingMemberInviteToken = ''; incomingMemberInvite = null;
      var gateStatusAfter = $('fcGateStatus'); if (gateStatusAfter) gateStatusAfter.textContent = 'Solicitud enviada como ' + roleName(role) + '. El propietario debe aprobarla. Hasta entonces el catálogo y los eventos seguirán bloqueados.';
      var gateRequestAfter = $('fcGateRequestJoin'); if (gateRequestAfter) { gateRequestAfter.style.display = ''; gateRequestAfter.disabled = true; gateRequestAfter.textContent = 'Solicitud pendiente'; }
      setStatus('Solicitud enviada como ' + roleName(role) + '. Esperando aprobación del propietario.', 'success');
      updateSyncButtons();
    } catch (err) {
      var msg = err && err.code === 'PERMISSION_DENIED' ? 'Firebase rechazó la solicitud. Comprueba que el propietario haya creado la banda y que estén publicadas las reglas V24 de invitaciones.' : (err.message || 'Error desconocido.');
      setStatus('No se pudo solicitar incorporación: ' + msg, 'error');
      var gateStatus = $('fcGateStatus'); if (gateStatus) gateStatus.textContent = 'No se pudo enviar la solicitud: ' + msg;
      var gateButton = $('fcGateRequestJoin'); if (gateButton) { gateButton.disabled = false; gateButton.textContent = 'Reintentar solicitud'; }
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
      if (req.inviteToken && role !== req.requestedRole) throw new Error('Esta invitación tiene la función preasignada de ' + roleName(req.requestedRole) + '. Aprueba con esa misma función.');
      await db.ref(memberPath() + '/' + uid).set(member);
      await db.ref(bandPath('joinRequests/' + uid)).remove();
      if (req.inviteToken) await db.ref(bandPath('memberInvites/' + req.inviteToken)).update({ status: 'completed', completedAt: firebase.database.ServerValue.TIMESTAMP, completedBy: currentUser.uid }).catch(function () {});
      setStatus((req.deviceName || 'Integrante') + ' aprobado como ' + roleName(role) + '.', 'success');
    } catch (err) { setStatus('No se pudo aprobar al integrante: ' + err.message, 'error'); }
  }
  async function rejectJoinRequest(uid) {
    if (!isTechnicalOwner() || !db || !bandId) return;
    try {
      var req = joinRequestList[uid] || {};
      await db.ref(bandPath('joinRequests/' + uid)).remove();
      if (req.inviteToken) await db.ref(bandPath('memberInvites/' + req.inviteToken)).remove().catch(function () {});
      setStatus('Solicitud rechazada.', 'success');
    } catch (err) { setStatus('No se pudo rechazar la solicitud: ' + err.message, 'error'); }
  }
  function clearMemberInviteFromUrl() {
    try {
      var url = new URL(window.location.href);
      url.searchParams.delete('fc_member_invite');
      url.searchParams.delete('fc_join');
      history.replaceState({}, '', url.pathname + url.search + url.hash);
    } catch (e) {}
  }
  function memberInvitePath(token) { return 'bands/' + FIXED_BAND_ID + '/memberInvites/' + String(token || '').toLowerCase(); }
  function showMemberInviteResult(text, isError) {
    var node = $('fcMemberInviteResult');
    if (node) { node.textContent = text; node.className = 'note ' + (isError ? 'error' : 'success'); }
  }
  async function createMemberInviteLink() {
    try {
      if (!isConnected() || !isTechnicalOwner() || !db) throw new Error('Solo el propietario técnico puede crear invitaciones.');
      var role = $('fcMemberInviteRole') ? $('fcMemberInviteRole').value : 'choose';
      var url = new URL('./', window.location.href); url.search = ''; url.hash = '';
      if (role === 'choose') {
        url.searchParams.set('fc_join', '1');
      } else {
        if (!ROLE_OPTIONS.some(function (r) { return r[0] === role && role !== 'accordionist' && role !== 'pending'; })) throw new Error('Selecciona una función válida.');
        var occupied = Object.keys(memberList || {}).some(function (uid) { return memberList[uid] && memberList[uid].role === role; });
        var requested = Object.keys(joinRequestList || {}).some(function (uid) { return joinRequestList[uid] && joinRequestList[uid].requestedRole === role; });
        if (occupied || requested) throw new Error('La función ' + roleName(role) + ' ya está ocupada o tiene una solicitud pendiente.');
        await waitForServerClock();
        var token = randomTokenHex();
        var record = { role: role, status: 'pending', mode: 'member-request', createdBy: currentUser.uid, createdAt: firebase.database.ServerValue.TIMESTAMP, expiresAt: serverNow() + 7 * 24 * 60 * 60 * 1000 };
        await db.ref(memberInvitePath(token)).set(record);
        url.searchParams.set('fc_member_invite', token);
      }
      var link = url.toString();
      currentMemberInviteLink = link;
      var output = $('fcMemberInviteOutput'); if (output) output.style.display = '';
      var field = $('fcMemberInviteUrl');
      if (field) { field.value = link; field.style.display = ''; field.focus(); field.select(); }
      var copy = $('fcCopyMemberInvite'); if (copy) { copy.style.display = ''; copy.onclick = function () {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(function () { showMemberInviteResult('Enlace copiado. Envíalo por WhatsApp o mensaje.', false); }).catch(function () { if (field) { field.focus(); field.select(); } showMemberInviteResult('Selecciona el enlace y cópialo manualmente.', false); });
        else { if (field) { field.focus(); field.select(); } showMemberInviteResult('Selecciona el enlace y cópialo manualmente.', false); }
      }; }
      var shareButton = $('fcShareMemberInvite'); if (shareButton) shareButton.style.display = '';
      showMemberInviteResult(role === 'choose' ? 'Enlace general listo. La persona puede instalar primero la app, elegir su función y solicitar acceso. Tú tendrás que aprobarla.' : 'Enlace para ' + roleName(role) + ' listo. La función llegará preseleccionada. La persona deberá solicitar acceso y tú tendrás que aprobarlo. Vence en 7 días y se reclama una sola vez.', false);
    } catch (err) { showMemberInviteResult('No se pudo crear el enlace: ' + (err.message || err), true); }
  }
  async function shareMemberInviteLink() {
    if (!currentMemberInviteLink) { showMemberInviteResult('Primero crea un enlace de invitación.', true); return; }
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Invitación a Frecuencia Cero', text: 'Abre Frecuencia Cero desde el dispositivo donde usarás la app, selecciona tu perfil y solicita incorporación. El propietario aprobará el acceso.', url: currentMemberInviteLink });
        showMemberInviteResult('Invitación compartida.', false);
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(currentMemberInviteLink);
        showMemberInviteResult('El enlace se copió al portapapeles.', false);
      } else {
        var field = $('fcMemberInviteUrl'); if (field) { field.focus(); field.select(); }
        showMemberInviteResult('Selecciona el enlace y cópialo manualmente.', false);
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      showMemberInviteResult('No se pudo compartir automáticamente. Usa Copiar enlace.', true);
    }
  }

  async function maybeProcessIncomingMemberInvite() {
    if (!currentUser || !db || memberInviteCheckStarted) return;
    var token = '';
    try {
      var query = new URL(window.location.href).searchParams;
      token = query.get('fc_member_invite') || '';
      genericJoinLink = query.get('fc_join') === '1';
    } catch (e) {}
    if (!token) {
      // La puerta se muestra después de que watchOwnMembership confirme que este UID no tiene acceso.
      return;
    }
    if (!/^[a-f0-9]{48}$/i.test(token)) {
      maybeShowFirstProfileGate();
      var invalidStatus = $('fcGateStatus'); if (invalidStatus) invalidStatus.textContent = 'El enlace de invitación no contiene un código válido. Pide al propietario que genere otro.';
      return;
    }
    memberInviteCheckStarted = true;
    selectedProfileRole = '';
    try { localStorage.removeItem(PROFILE_KEY); } catch (e) {}
    try {
      // No convertir un dispositivo ya autorizado en otro perfil por abrir un enlace.
      var own = await Promise.all([
        db.ref('bands/' + FIXED_BAND_ID + '/members/' + currentUser.uid).once('value'),
        db.ref('bands/' + FIXED_BAND_ID + '/devices/' + currentUser.uid).once('value')
      ]);
      if ((own[0].val() && own[0].val().role) || (own[1].val() && own[1].val().role)) {
        setStatus('Este dispositivo ya está vinculado. La invitación debe abrirse en otro navegador o dispositivo.', 'warning');
        return;
      }
      await waitForServerClock();
      var snap = await db.ref(memberInvitePath(token)).once('value');
      var invite = snap.val();
      if (!invite || invite.mode !== 'member-request') throw new Error('La invitación no existe o fue cancelada. Pide al propietario un enlace nuevo.');
      if (invite.status !== 'pending') throw new Error(invite.status === 'claimed' ? 'Esta invitación ya fue utilizada para enviar una solicitud.' : 'Esta invitación ya no está disponible.');
      if (!Number(invite.expiresAt) || Number(invite.expiresAt) <= serverNow()) throw new Error('La invitación venció. Pide un enlace nuevo al propietario.');
      if (!ROLE_OPTIONS.some(function (r) { return r[0] === invite.role && invite.role !== 'accordionist' && invite.role !== 'pending'; })) throw new Error('La invitación contiene una función no válida.');
      incomingMemberInviteToken = token.toLowerCase(); incomingMemberInvite = invite;
      selectedProfileRole = invite.role; localStorage.setItem(PROFILE_KEY, invite.role);
      maybeShowFirstProfileGate();
      var gate = $('fcFirstProfileGate');
      if (gate) {
        var grid = gate.querySelector('.fc-profile-grid'); if (grid) grid.style.display = 'none';
        var status = $('fcGateStatus'); if (status) status.textContent = 'Te invitaron como ' + roleName(invite.role) + '. Pulsa Solicitar incorporación. El repertorio seguirá bloqueado hasta que el propietario apruebe tu solicitud.';
        var request = $('fcGateRequestJoin'); if (request) { request.style.display = ''; request.disabled = false; request.textContent = 'Solicitar incorporación como ' + roleName(invite.role); }
        var intro = $('fcGateIntro'); if (intro) intro.textContent = 'Invitación con función preasignada';
        gate.style.display = 'grid'; firstProfileGateShown = true;
      }
    } catch (err) {
      genericJoinLink = false;
      maybeShowFirstProfileGate();
      var statusNode = $('fcGateStatus'); if (statusNode) statusNode.textContent = err.message || 'No se pudo verificar la invitación.';
      var gridNode = document.querySelector('#fcFirstProfileGate .fc-profile-grid'); if (gridNode) gridNode.style.display = '';
      var requestNode = $('fcGateRequestJoin'); if (requestNode) requestNode.style.display = 'none';
    }
  }
  async function claimMemberInvite(token, role) {
    await waitForServerClock();
    var ref = db.ref(memberInvitePath(token));
    var first = (await ref.once('value')).val();
    if (!first || first.mode !== 'member-request') throw new Error('La invitación ya no existe. Pide un enlace nuevo.');
    if (first.role !== role) throw new Error('La invitación está reservada para ' + roleName(first.role) + '.');
    if (first.status === 'claimed' && first.claimedBy === currentUser.uid) return first;
    if (first.status !== 'pending') throw new Error('La invitación ya fue utilizada o cancelada.');
    if (Number(first.expiresAt) <= serverNow()) throw new Error('La invitación venció. Pide un enlace nuevo.');
    var fallback = true;
    var tx = await ref.transaction(function (current) {
      if (current == null && fallback) { current = Object.assign({}, first); fallback = false; }
      if (!current || current.status !== 'pending' || Number(current.expiresAt) <= serverNow() || current.role !== role) return;
      var next = Object.assign({}, current);
      next.status = 'claimed'; next.claimedBy = currentUser.uid; next.requestedRole = role; next.claimedAt = firebase.database.ServerValue.TIMESTAMP;
      return next;
    }, undefined, false);
    if (tx.committed) return tx.snapshot.val();
    var last = (await ref.once('value')).val();
    if (last && last.status === 'claimed' && last.claimedBy === currentUser.uid && last.role === role) return last;
    if (!last) throw new Error('La invitación fue eliminada. Pide un enlace nuevo.');
    if (Number(last.expiresAt) <= serverNow()) throw new Error('La invitación venció. Pide un enlace nuevo.');
    throw new Error('La invitación ya fue usada por otro dispositivo o Firebase no pudo reclamarla.');
  }

  function readStoredArray(key, fallbackKeys) {
    var keys = [key].concat(fallbackKeys || []);
    for (var i = 0; i < keys.length; i++) {
      try {
        var raw = localStorage.getItem(keys[i]);
        if (!raw) continue;
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) return parsed;
      } catch (e) {}
    }
    return [];
  }
  function maybeOfferOwnerLocalMigration() {
    if (ownerLocalMigrationPrompted || !isTechnicalOwner() || !db || !bandId) return;
    var legacySongs = readStoredArray('fc_v24_legacy_songs_backup', [window.KEY || 'letras_frecuencia_cero_v3', 'letras_v1', 'letras_fc_v2']);
    var legacyEvents = readStoredArray('fc_v24_legacy_events_backup', [window.EVENT_KEY || 'frecuencia_cero_eventos_v1']);
    if (!legacySongs.length && !legacyEvents.length) { ownerLocalMigrationPrompted = true; return; }
    ownerLocalMigrationPrompted = true;
    Promise.all([
      db.ref(bandPath('catalog')).once('value'),
      db.ref(bandPath('events')).once('value')
    ]).then(function (snaps) {
      var remoteSongs = snaps[0].val() || {};
      var remoteEvents = snaps[1].val() || {};
      var importSongs = !Object.keys(remoteSongs).length && legacySongs.length > 0;
      var importEvents = !Object.keys(remoteEvents).length && legacyEvents.length > 0;
      if (!importSongs && !importEvents) return;
      var prompt = 'Encontré un respaldo local de este dispositivo propietario que no aparece todavía en Firebase.\n\n' +
        (importSongs ? legacySongs.length + ' canciones\n' : '') +
        (importEvents ? legacyEvents.length + ' eventos\n' : '') +
        '\n¿Deseas importarlo a la banda? No se reemplazará ningún dato que ya exista en Firebase.';
      if (!confirm(prompt)) {
        setStatus('Se conservó el respaldo local sin publicarlo. El catálogo compartido seguirá cargándose desde Firebase.', 'warning');
        return;
      }
      var jobs = [];
      if (importSongs) jobs.push(db.ref(bandPath('catalog')).set(mapById(legacySongs)));
      if (importEvents) jobs.push(db.ref(bandPath('events')).set(mapById(legacyEvents)));
      return Promise.all(jobs).then(function () {
        localStorage.removeItem('fc_v24_legacy_songs_backup');
        localStorage.removeItem('fc_v24_legacy_events_backup');
        setStatus('Respaldo local importado a Firebase correctamente.', 'success');
      });
    }).catch(function (err) {
      ownerLocalMigrationPrompted = false;
      setStatus('No se pudo revisar el respaldo local: ' + (err.message || err), 'warning');
    });
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
    refs.meta.on('value', function (snap) { bandMeta = snap.val() || {}; updateSyncButtons(); }, function (err) {
      if (err && err.code === 'PERMISSION_DENIED') handleAccessRevoked('Firebase ya no autoriza este dispositivo para consultar la banda.');
    });
    var mineWasAuthorized = !!(memberProfile && memberProfile.role && memberProfile.role !== 'pending');
    refs.mine.on('value', function (snap) {
      var latestProfile = snap.val();
      if (!latestProfile || !latestProfile.role || latestProfile.role === 'pending') {
        if (mineWasAuthorized) handleAccessRevoked('El propietario retiró tu acceso a Frecuencia Cero. Selecciona tu perfil y solicita nuevamente la incorporación.');
        return;
      }
      mineWasAuthorized = true;
      memberProfile = latestProfile; memberRole = latestProfile.role;
      selectedProfileRole = memberRole; localStorage.setItem(PROFILE_KEY, memberRole);
      localStorage.setItem(BAND_KEY, id);
      accessRevoked = false; accessVerificationPending = false; revocationMode = 'member'; localStorage.removeItem(ACCESS_REVOKED_KEY); localStorage.removeItem(ACCESS_REVOKED_MODE_KEY);
      localStorage.setItem(IDENTITY_KIND_KEY, kind);
      setStatus('Conectado · ' + roleName(memberRole), 'success');
      updateSyncButtons(); if (window.cur) applyRoleToCurrentSong();
    }, function (err) {
      if (mineWasAuthorized && err && err.code === 'PERMISSION_DENIED') handleAccessRevoked('Firebase rechazó el acceso de este dispositivo. El propietario debe volver a aprobarlo.');
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
      if (accessRevoked || accessVerificationPending) return;
      var data = snap.val() || {};
      if (!Object.keys(data).length && isTechnicalOwner()) {
        var hasLegacySongs = readStoredArray('fc_v24_legacy_songs_backup', [window.KEY || 'letras_frecuencia_cero_v3', 'letras_v1', 'letras_fc_v2']).length > 0;
        if (hasLegacySongs) { maybeOfferOwnerLocalMigration(); window.songs = []; if (typeof window.render === 'function') window.render(); return; }
      }
      if (Object.keys(data).length && isTechnicalOwner()) { localStorage.removeItem('fc_v24_legacy_songs_backup'); }
      applyingRemote = true;
      window.songs = objectValues(data).map(function (song) {
        if (song.section !== 'keyboard' && song.section !== 'accordion') song.section = 'accordion';
        return song;
      }).sort(function (a, b) { return (a.catalogOrder == null ? 999999 : a.catalogOrder) - (b.catalogOrder == null ? 999999 : b.catalogOrder); });
      lastCatalogJson = safeJson(mapById(window.songs));
      localSaveSongs(); applyingRemote = false;
      if (typeof window.render === 'function') window.render();
      if (window.cur) { var latest = window.find(window.cur.id); if (latest) { window.cur = latest; window.paint(); applyRoleToCurrentSong(); } }
      renderLiveBanner(); handleLiveUpdate();
    }, function (err) { if (err && err.code === 'PERMISSION_DENIED') handleAccessRevoked('Tu acceso al catálogo fue revocado.'); });
    refs.events.on('value', function (snap) {
      if (accessRevoked || accessVerificationPending) return;
      var data = snap.val() || {};
      if (!Object.keys(data).length && isTechnicalOwner()) {
        var hasLegacyEvents = readStoredArray('fc_v24_legacy_events_backup', [window.EVENT_KEY || 'frecuencia_cero_eventos_v1']).length > 0;
        if (hasLegacyEvents) { maybeOfferOwnerLocalMigration(); window.events = []; if (typeof window.renderEvents === 'function') window.renderEvents(); return; }
      }
      if (Object.keys(data).length && isTechnicalOwner()) { localStorage.removeItem('fc_v24_legacy_events_backup'); }
      applyingRemote = true;
      window.events = objectValues(data).sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      lastEventsJson = safeJson(mapById(window.events));
      localSaveEvents(); applyingRemote = false;
      if (typeof window.renderEvents === 'function') window.renderEvents();
      if (window.currentEventId && $('vplaylist') && $('vplaylist').classList.contains('on')) window.renderEventPlaylist();
      if (window.cur) applyRoleToCurrentSong();
      renderLiveBanner(); handleLiveUpdate();
    }, function (err) { if (err && err.code === 'PERMISSION_DENIED') handleAccessRevoked('Tu acceso a los eventos fue revocado.'); });
    refs.live.on('value', function (snap) { if (accessRevoked || accessVerificationPending) return; liveState = snap.val() || null; renderLiveBanner(); handleLiveUpdate(); }, function (err) {
      if (err && err.code === 'PERMISSION_DENIED') handleAccessRevoked('Tu acceso a la sincronización en vivo fue revocado.');
    });
    // La presencia debe registrarse en cada reconexión, no solo al abrir la app.
    // Si iOS suspende Safari/PWA o cambia la red, onDisconnect elimina el nodo;
    // .info/connected vuelve a crearlo cuando Firebase recupera la conexión.
    refs.connectionInfo = db.ref('.info/connected');
    refs.connectionInfo.on('value', function (snap) {
      if (snap.val() !== true || !isConnected()) return;
      var presenceRef = refs.presence;
      presenceRef.onDisconnect().remove().then(function () {
        return presenceRef.set({
          name: roleName(memberRole),
          role: memberRole,
          online: true,
          since: firebase.database.ServerValue.TIMESTAMP,
          lastSeen: firebase.database.ServerValue.TIMESTAMP
        });
      }).catch(function (err) {
        setStatus('La banda está conectada, pero no se pudo actualizar la presencia: ' + (err.message || err), 'warning');
      });
    });
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
      await waitForServerClock();
      var token = randomTokenHex();
      var expiresAt = serverNow() + 180000;
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
      box.innerHTML = '<div class="fc-pair-title">Añadir dispositivo a ' + roleName(pairingRole) + '</div><p class="note">Este QR y su enlace vinculan el nuevo navegador a este perfil: ' + roleName(pairingRole) + '. No crean otro integrante ni requieren aprobación. Para añadir un dispositivo a Voz 2, genera el enlace desde una sesión ya autorizada como Voz 2. Vence en 3 minutos y se usa una sola vez.</p><div id="fcPairQrCanvas" class="fc-pair-qr"></div><div id="fcPairUrlText" class="fc-pair-url"></div><div id="fcPairCountdown" class="note">Válido durante 3:00</div><div class="fc-pair-share-actions"><button type="button" id="fcPairCopy">Copiar enlace para este perfil</button><button type="button" id="fcPairShare">Compartir enlace…</button></div><button type="button" id="fcPairCancel">Cancelar</button>';
      box.style.display = '';
      var link = pairingUrl(token);
      $('fcPairUrlText').innerHTML = '';
      var invitationAnchor = document.createElement('a');
      invitationAnchor.href = link;
      invitationAnchor.textContent = 'Abrir enlace alternativo de invitación';
      invitationAnchor.style.display = 'inline-block';
      invitationAnchor.style.textDecoration = 'underline';
      invitationAnchor.style.overflowWrap = 'anywhere';
      $('fcPairUrlText').appendChild(invitationAnchor);
      if (window.QRCode) {
        new QRCode($('fcPairQrCanvas'), { text: link, width: 220, height: 220, colorDark: '#111827', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
      } else {
        $('fcPairQrCanvas').textContent = 'No se pudo cargar el generador QR. Puedes abrir el enlace en el otro dispositivo.';
      }
      $('fcPairCopy').onclick = function () { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(function () { setStatus('Enlace copiado para añadir un dispositivo al perfil ' + roleName(pairingRole) + '.', 'success'); }).catch(function () { setStatus('No se pudo copiar. Mantén pulsado el enlace para copiarlo.', 'warning'); }); else setStatus('Mantén pulsado el enlace para copiarlo.', 'neutral'); };
      $('fcPairShare').onclick = async function () { try { if (navigator.share) await navigator.share({ title: 'Añadir dispositivo a ' + roleName(pairingRole), text: 'Abre Frecuencia Cero en el dispositivo que quieres añadir a este mismo perfil.', url: link }); else if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(link); setStatus('Enlace copiado. Pégalo dentro de Frecuencia Cero en el otro dispositivo.', 'success'); } } catch (shareErr) { if (!shareErr || shareErr.name !== 'AbortError') setStatus('No se pudo compartir. Usa Copiar enlace para este perfil.', 'warning'); } };
      $('fcPairCancel').onclick = function () { ref.remove().catch(function () {}); closePairQr('Vinculación cancelada.'); };
      ref.on('value', function (snap) {
        var state = snap.val();
        if (!state) return;
        if (state.status === 'completed') { ref.remove().catch(function () {}); closePairQr('¡Dispositivo vinculado correctamente a ' + roleName(state.role) + '!'); }
        else if (state.status === 'claimed') setText('fcPairCountdown', 'QR escaneado. Terminando vinculación…');
      });
      var end = expiresAt;
      function tick() {
        if (!pairQrToken || pairQrToken !== token) return;
        var remain = Math.max(0, end - serverNow());
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
  async function assertDeviceCanBePaired() {
    if (!currentUser || !db) throw new Error('Este dispositivo todavía no tiene identidad de Firebase.');
    // Resuelve la identidad en el servidor antes de consumir el token. Evita la
    // carrera entre onAuthStateChanged y los listeners de membresía/dispositivo.
    var checks = await Promise.all([
      db.ref('bands/' + FIXED_BAND_ID + '/members/' + currentUser.uid).once('value'),
      db.ref('bands/' + FIXED_BAND_ID + '/devices/' + currentUser.uid).once('value')
    ]);
    var existingMember = checks[0].val();
    var existingDevice = checks[1].val();
    if (existingMember && existingMember.role) {
      throw new Error('Este navegador ya tiene el perfil ' + roleName(existingMember.role) + '. El enlace es para un dispositivo nuevo, no para duplicar una sesión existente.');
    }
    if (existingDevice && existingDevice.memberUid) {
      throw new Error('Este navegador ya está vinculado al perfil ' + roleName(existingDevice.role) + '. No necesitas usar otro enlace aquí.');
    }
    if (bandId || (memberProfile && memberProfile.role && memberProfile.role !== 'pending')) {
      throw new Error('Este dispositivo ya está conectado a una banda. Para vincular otro equipo, abre el enlace en ese otro equipo.');
    }
  }
  function clearPairTokenFromUrl() {
    try {
      var cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('fc_pair');
      history.replaceState({}, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
    } catch (e) {}
  }
  function closeIncomingPairPrompt(removeToken) {
    var prompt = $('fcPairInviteGate');
    if (prompt) prompt.remove();
    pairInvitePromptToken = '';
    if (removeToken) clearPairTokenFromUrl();
  }
  function showIncomingPairPrompt(token) {
    if (pairInvitePromptToken === token && $('fcPairInviteGate')) return;
    closeIncomingPairPrompt(false);
    pairInvitePromptToken = token;
    var overlay = document.createElement('div');
    overlay.id = 'fcPairInviteGate';
    overlay.className = 'fc-pair-invite-overlay';
    overlay.innerHTML = '<section class="fc-pair-invite-card" role="dialog" aria-modal="true" aria-labelledby="fcPairInviteTitle">' +
      '<div class="fc-profile-brand">↔</div>' +
      '<h2 id="fcPairInviteTitle">Invitación a Frecuencia Cero</h2>' +
      '<p>Este enlace permite vincular este navegador a un perfil que ya existe. No se utilizará hasta que pulses el botón de confirmación.</p>' +
      '<div class="fc-pair-invite-note">La invitación es de un solo uso y vence a los 3 minutos de haber sido generada. Se verificará con la hora del servidor de Firebase.</div>' +
      '<p id="fcPairInviteStatus" class="fc-pair-invite-status" aria-live="polite">Conectando con Firebase para verificar la invitación…</p>' +
      '<button type="button" id="fcPairInviteAccept" class="p">Vincular este dispositivo</button>' +
      '<button type="button" id="fcPairInviteCancel">Cancelar</button>' +
      '</section>';
    document.body.appendChild(overlay);
    // Muestra el perfil de destino antes de que el usuario confirme. Así evita
    // confundir un QR del Acordeonista con una invitación para Voz 2, por ejemplo.
    if (token && currentUser && db) {
      db.ref('bands/' + FIXED_BAND_ID + '/devicePairings/' + token.toLowerCase()).once('value').then(function (snap) {
        var info = snap.val();
        var statusNode = $('fcPairInviteStatus');
        var acceptButton = $('fcPairInviteAccept');
        if (!statusNode || !$('fcPairInviteGate')) return;
        if (!info) {
          statusNode.textContent = 'No se encontró esta invitación. Pide que generen un enlace nuevo desde el perfil correcto.';
          if (acceptButton) acceptButton.disabled = true;
          return;
        }
        if (info.status !== 'pending' || Number(info.expiresAt) <= serverNow()) {
          statusNode.textContent = 'Este enlace ya se utilizó o venció. Genera uno nuevo desde el perfil que deseas añadir.';
          if (acceptButton) acceptButton.disabled = true;
          return;
        }
        statusNode.textContent = 'Este dispositivo se añadirá al perfil ' + roleName(info.role) + '. No crea un integrante nuevo ni requiere aprobación adicional. Confirma solo si ese es el perfil que quieres usar.';
      }).catch(function (err) {
        var statusNode = $('fcPairInviteStatus');
        if (statusNode && $('fcPairInviteGate')) statusNode.textContent = 'No se pudo consultar el perfil del enlace: ' + (err.message || 'error de Firebase') + '. Puedes volver a intentarlo.';
      });
    }
    var accept = $('fcPairInviteAccept');
    if (accept) accept.onclick = async function () {
      accept.disabled = true;
      accept.textContent = 'Verificando invitación…';
      var status = $('fcPairInviteStatus');
      if (status) status.textContent = 'Comprobando que este navegador no esté vinculado y que el enlace siga vigente…';
      var ok = await claimDevicePairing(token, true);
      if (!ok && $('fcPairInviteGate')) {
        accept.disabled = false;
        accept.textContent = 'Volver a intentar';
      }
    };
    var cancel = $('fcPairInviteCancel');
    if (cancel) cancel.onclick = function () {
      closeIncomingPairPrompt(true);
      setStatus('Invitación cerrada. Puedes seleccionar un perfil o escanear un QR más tarde.', 'neutral');
      maybeShowFirstProfileGate();
    };
  }
  async function continueWithPastedAccessLink() {
    if (accessLinkProcessing) return;
    var field = $('fcGateAccessLinkInput');
    var raw = field ? field.value.trim() : '';
    if (!raw) { setText('fcGateAccessLinkStatus', 'Pega primero el enlace que te compartieron.'); return; }
    accessLinkProcessing = true;
    try {
      var parsed = new URL(raw, window.location.href);
      if (parsed.origin !== window.location.origin) throw new Error('El enlace debe pertenecer a Frecuencia Cero. Pide que te compartan el enlace completo de esta aplicación.');
      var pairToken = parsed.searchParams.get('fc_pair') || '';
      var memberToken = parsed.searchParams.get('fc_member_invite') || '';
      var generalJoin = parsed.searchParams.get('fc_join') === '1';
      if (pairToken) {
        if (!/^[a-f0-9]{48}$/i.test(pairToken)) throw new Error('El enlace de dispositivo no tiene un código válido.');
        setText('fcGateAccessLinkStatus', 'Enlace de dispositivo identificado. Confirma para añadir este navegador al perfil que ya tienes autorizado.');
        showIncomingPairPrompt(pairToken.toLowerCase());
        return;
      }
      if (memberToken) {
        if (!/^[a-f0-9]{48}$/i.test(memberToken)) throw new Error('El enlace de invitación no tiene un código válido.');
        var current = new URL(window.location.href);
        current.searchParams.delete('fc_pair'); current.searchParams.delete('fc_join');
        current.searchParams.set('fc_member_invite', memberToken.toLowerCase());
        history.replaceState({}, '', current.pathname + current.search + current.hash);
        memberInviteCheckStarted = false; incomingMemberInviteToken = ''; incomingMemberInvite = null; genericJoinLink = false;
        await maybeProcessIncomingMemberInvite();
        setText('fcGateAccessLinkStatus', 'Invitación verificada. Revisa la función preseleccionada y pulsa Solicitar incorporación.');
        return;
      }
      if (generalJoin) {
        genericJoinLink = true;
        setText('fcGateStatus', 'Invitación general reconocida. Selecciona tu función y pulsa Solicitar incorporación; el propietario debe aprobarte.');
        setText('fcGateAccessLinkStatus', 'Enlace general reconocido. Ahora selecciona tu perfil.');
        if (field) field.value = '';
        return;
      }
      throw new Error('No reconocí este enlace. Debe ser una invitación de integrante o un enlace para añadir otro dispositivo.');
    } catch (err) {
      setText('fcGateAccessLinkStatus', err.message || 'No se pudo interpretar el enlace.');
    } finally { accessLinkProcessing = false; }
  }

  async function claimDevicePairing(token, fromLink) {
    if (pairProcessing) return false;
    pairProcessing = true;
    try {
      if (!/^[a-f0-9]{48}$/i.test(String(token || ''))) throw new Error('El enlace no contiene un código de vinculación válido.');
      await waitForServerClock();
      await assertDeviceCanBePaired();
      var pairRef = db.ref('bands/' + FIXED_BAND_ID + '/devicePairings/' + token.toLowerCase());
      var initial = await pairRef.once('value');
      var pair = initial.val();
      if (!pair) throw new Error('La invitación ya no existe. Puede haberse cancelado o eliminado por el propietario. Genera un enlace nuevo.');
      if (pair.status !== 'pending') {
        throw new Error(pair.status === 'completed' ? 'Esta invitación ya se utilizó correctamente en otro dispositivo.' : 'Esta invitación ya fue reclamada por otro dispositivo. Genera un enlace nuevo.');
      }
      if (Number(pair.expiresAt) <= serverNow()) throw new Error('La invitación venció según la hora de Firebase. Genera un enlace nuevo.');
      // En algunos navegadores el SDK web puede iniciar la transacción con
      // current === null aunque el once('value') inmediatamente anterior ya
      // haya leído la invitación. Si devolvemos undefined en ese primer intento,
      // Firebase aborta localmente y la invitación sigue pendiente. Usamos la
      // lectura recién verificada como respaldo SOLO en la primera llamada; si
      // el servidor devuelve null realmente, el hash de la transacción no
      // coincide y el SDK vuelve a ejecutar el callback con el estado real.
      async function claimPairTransaction(snapshotPair) {
        var snapshotFallbackAvailable = true;
        var abortReason = '';
        var result = await pairRef.transaction(function (current) {
          if (current == null && snapshotFallbackAvailable) {
            current = Object.assign({}, snapshotPair);
            snapshotFallbackAvailable = false;
          }
          if (!current) {
            abortReason = 'Firebase no devolvió el estado actual de la invitación durante la transacción.';
            return;
          }
          if (current.status !== 'pending') {
            abortReason = 'La invitación cambió de estado antes de confirmarse.';
            return;
          }
          if (Number(current.expiresAt) <= serverNow()) {
            abortReason = 'La invitación venció según la hora del servidor.';
            return;
          }
          var next = Object.assign({}, current);
          next.status = 'claimed';
          next.claimedBy = currentUser.uid;
          next.claimedAt = firebase.database.ServerValue.TIMESTAMP;
          return next;
        }, undefined, false);
        return { result: result, abortReason: abortReason };
      }

      var claimAttempt = await claimPairTransaction(pair);
      var tx = claimAttempt.result;
      if (!tx.committed) {
        // Releer y reintentar una sola vez si el token continúa pendiente.
        // La regla de Firebase sigue controlando la transición y el uso único.
        var latestSnap = await pairRef.once('value');
        var latest = latestSnap.val();
        if (!latest) throw new Error('La invitación fue cancelada o eliminada. Genera una nueva.');
        if (latest.status === 'claimed' && latest.claimedBy === currentUser.uid) {
          pair = latest;
        } else if (latest.status !== 'pending') {
          throw new Error('La invitación ya fue utilizada o reclamada por otro dispositivo. Genera una nueva.');
        } else if (Number(latest.expiresAt) <= serverNow()) {
          throw new Error('La invitación venció según la hora del servidor. Genera una nueva.');
        } else {
          claimAttempt = await claimPairTransaction(latest);
          tx = claimAttempt.result;
          if (!tx.committed) {
            var finalSnap = await pairRef.once('value');
            var finalState = finalSnap.val();
            if (finalState && finalState.status === 'claimed' && finalState.claimedBy === currentUser.uid) {
              pair = finalState;
            } else if (!finalState) {
              throw new Error('La invitación desapareció durante la confirmación. Genera una nueva.');
            } else if (finalState.status !== 'pending') {
              throw new Error('La invitación ya fue utilizada o reclamada por otro dispositivo. Genera una nueva.');
            } else if (Number(finalState.expiresAt) <= serverNow()) {
              throw new Error('La invitación venció según la hora del servidor. Genera una nueva.');
            } else {
              throw new Error('La invitación sigue pendiente en Firebase, pero el navegador no pudo confirmar la transacción. ' + (claimAttempt.abortReason || 'Verifica la conexión y las reglas de vinculación de Realtime Database.'));
            }
          } else {
            pair = tx.snapshot.val();
          }
        }
      } else {
        pair = tx.snapshot.val();
      }
      var device = {
        role: pair.role,
        name: ROLE_LABELS[pair.role] || 'Integrante',
        memberUid: pair.memberUid,
        linkedFrom: pair.createdBy,
        linkedAt: firebase.database.ServerValue.TIMESTAMP,
        pairingToken: token.toLowerCase()
      };
      await db.ref('bands/' + FIXED_BAND_ID + '/devices/' + currentUser.uid).set(device);
      await pairRef.update({ status: 'completed', completedAt: firebase.database.ServerValue.TIMESTAMP });
      closeIncomingPairPrompt(false);
      clearPairTokenFromUrl();
      setStatus('¡Este dispositivo quedó vinculado como ' + roleName(pair.role) + '!', 'success');
      updateSyncButtons();
      return true;
    } catch (err) {
      var message = err && err.code === 'PERMISSION_DENIED'
        ? 'Firebase rechazó una operación de vinculación (' + (err.code || 'PERMISSION_DENIED') + '). La invitación debe estar pendiente, su creador debe seguir autorizado y las reglas deben permitir reclamar el token y registrar el dispositivo.'
        : (err.message || 'No se pudo completar la vinculación.');
      setStatus('No se pudo vincular el dispositivo: ' + message, 'error');
      if (fromLink) {
        var statusNode = $('fcPairInviteStatus');
        if (statusNode) statusNode.textContent = message;
      } else {
        alert(message);
      }
      return false;
    } finally { pairProcessing = false; }
  }
  function maybeProcessIncomingPair() {
    if (!currentUser || !db || pairProcessing) return;
    var token = '';
    try { token = new URL(window.location.href).searchParams.get('fc_pair') || ''; } catch (e) {}
    if (!token) return;
    if (!/^[a-f0-9]{48}$/i.test(token)) {
      showIncomingPairPrompt('');
      var status = $('fcPairInviteStatus');
      if (status) status.textContent = 'El enlace está incompleto o no es válido. Solicita uno nuevo al dispositivo que genera la invitación.';
      var accept = $('fcPairInviteAccept'); if (accept) accept.disabled = true;
      return;
    }
    // Abrir o previsualizar el enlace NO consume la invitación. La persona confirma
    // explícitamente en el dispositivo de destino antes de reclamar el token.
    showIncomingPairPrompt(token.toLowerCase());
    waitForServerClock().then(function () {
      var status = $('fcPairInviteStatus');
      if (status && $('fcPairInviteGate')) status.textContent = 'Invitación lista. Pulsa «Vincular este dispositivo» para utilizarla.';
    }).catch(function () {});
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
    if (!confirm('¿Quitar a ' + (member.name || 'este integrante') + ' de Frecuencia Cero? Se cerrará su acceso y se revocarán todos sus dispositivos y códigos QR pendientes.')) return;
    try {
      // Lee la lista más reciente antes de construir una única revocación atómica.
      var snapshots = await Promise.all([
        db.ref(bandPath('devices')).once('value'),
        db.ref(bandPath('devicePairings')).once('value')
      ]);
      var latestDevices = snapshots[0].val() || {};
      var pairings = snapshots[1].val() || {};
      var linked = Object.keys(latestDevices).filter(function (deviceUid) { return latestDevices[deviceUid] && latestDevices[deviceUid].memberUid === uid; });
      var revokedUids = [uid].concat(linked);
      var updates = {};
      updates['members/' + uid] = null;
      updates['joinRequests/' + uid] = null;
      updates['presence/' + uid] = null;
      linked.forEach(function (deviceUid) {
        updates['devices/' + deviceUid] = null;
        updates['presence/' + deviceUid] = null;
      });
      // Un QR abierto antes de la baja tampoco puede seguir utilizándose.
      Object.keys(pairings).forEach(function (token) {
        var pair = pairings[token] || {};
        if (pair.memberUid === uid || revokedUids.indexOf(pair.createdBy) >= 0 || revokedUids.indexOf(pair.claimedBy) >= 0) {
          updates['devicePairings/' + token] = null;
        }
      });
      if (member.role === 'voice1') updates.live = null;
      await db.ref('bands/' + bandId).update(updates);
      setStatus((member.name || 'Integrante') + ' retirado. Firebase revocó su perfil, dispositivos, presencia y QR pendientes.', 'success');
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
      // Las rutas concretas permiten a un integrante revocar sus propios dispositivos.
      // Los QR emitidos por ese dispositivo dejan de ser válidos porque las reglas
      // exigen que quien los creó siga autorizado y que su registro de dispositivo exista.
      await db.ref(bandPath('devices/' + deviceUid)).remove();
      await db.ref(bandPath('presence/' + deviceUid)).remove().catch(function () {});
      setStatus('Dispositivo revocado. Sus códigos QR pendientes también dejan de ser válidos.', 'success');
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
    var primaryDetail = document.createElement('small'); primaryDetail.textContent = 'Este perfil está abierto aquí · ' + (presenceMap[currentUser.uid] && presenceMap[currentUser.uid].online ? 'En línea' : 'Sin conexión reciente');
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
      var row = document.createElement('div'); row.className = 'fc-member-row fc-request-row';
      var info = document.createElement('div'); info.className = 'fc-member-info fc-request-info';
      var name = document.createElement('strong'); name.textContent = req.deviceName || ('Solicitud · ' + roleName(req.requestedRole));
      var detail = document.createElement('small'); detail.textContent = 'Solicita la función: ' + roleName(req.requestedRole);
      var uidLine = document.createElement('small'); uidLine.textContent = 'ID: ' + uid.slice(0, 9) + '…'; uidLine.className = 'fc-request-uid';
      info.append(name, detail, uidLine);
      var actions = document.createElement('div'); actions.className = 'fc-request-actions';
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
      var reject = document.createElement('button'); reject.className = 'fc-request-reject'; reject.textContent = 'Rechazar'; reject.title = 'Rechazar solicitud'; reject.onclick = function () { rejectJoinRequest(uid); };
      actions.append(select, approve, reject);
      row.append(info, actions); box.appendChild(row);
    });
  }
  function renderMemberAdmin() {
    var box = $('fcMembers'); if (!box) return;
    box.innerHTML = '';
    var ids = Object.keys(memberList || {});
    if (!ids.length) { box.textContent = 'Los integrantes aparecerán aquí al unirse a la banda.'; return; }
    ids.forEach(function (uid) {
      var m = memberList[uid] || {}, row = document.createElement('div'); row.className = 'fc-member-row fc-admin-member-row';
      var info = document.createElement('div'); info.className = 'fc-member-info';
      var name = document.createElement('strong'); name.textContent = m.name || m.email || 'Integrante';
      var linkedCount = Object.keys(deviceList || {}).filter(function (deviceUid) { return deviceList[deviceUid] && deviceList[deviceUid].memberUid === uid; }).length;
      var detail = document.createElement('small'); detail.textContent = (uid === currentUser.uid ? 'Perfil abierto en este dispositivo · ' : '') + (linkedCount ? linkedCount + ' dispositivo(s) vinculado(s) · ' : '') + (m.online ? 'En línea' : 'Desconectado');
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
  function catalogSongSection(songId) {
    var song = window.find ? window.find(songId) : null;
    return song && song.section === 'keyboard' ? 'keyboard' : 'accordion';
  }
  function eventAssignmentDefaults(songId) { return { section: catalogSongSection(songId), manualSection: false }; }
  function getCurrentEvent() { return (window.events || []).find(function (ev) { return ev.id === window.currentEventId; }) || null; }
  function getSongSection(songId, eventOverride) {
    var ev = eventOverride || getCurrentEvent();
    var assignment = ev && ev.assignments && ev.assignments[songId] || {};
    // Las asignaciones nuevas heredan del catálogo. Solo una selección explícita dentro
    // del evento puede sustituir temporalmente el bloque principal de la canción.
    if (assignment.manualSection === true && (assignment.section === 'keyboard' || assignment.section === 'accordion')) return assignment.section;
    // En V19, las canciones marcadas como Teclado en un evento eran selecciones manuales;
    // se conservan como excepción. Los valores Acordeón antiguos eran el valor por defecto.
    if (assignment.manualSection == null && assignment.section === 'keyboard') return 'keyboard';
    // Compatibilidad con eventos V15 que ya tenían asignaciones independientes por perfil.
    if (assignment.manualSection == null && !assignment.section && assignment.accordionist === 'guitar' && assignment.keyboardist === 'keyboard') return 'keyboard';
    return catalogSongSection(songId);
  }
  function getAssignment(songId, roleKey) {
    var ev = getCurrentEvent();
    var assignment = ev && ev.assignments && ev.assignments[songId] || {};
    if (!assignment.section && assignment[roleKey]) return assignment[roleKey];
    var section = getSongSection(songId, ev);
    // Reglas automáticas acordadas: acordeonista en bloque teclado = guitarra;
    // tecladista en bloque acordeón = guitarra. En su propio bloque siguen la letra.
    if (roleKey === 'accordionist') return section === 'keyboard' ? 'guitar' : 'accordion';
    return section === 'accordion' ? 'guitar' : 'keyboard';
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
      // En bloque propio se muestra letra sincronizada; en bloque cruzado, acordes + letra.
      desiredMode = instrument === 'guitar' ? 'b' : 's';
    } else if (role === 'drummer' || role === 'voice1' || role === 'voice2') desiredMode = 's';
    if (window.mode !== desiredMode) { window.mode = desiredMode; window.paint(); }
    if (role === 'accordionist' || role === 'keyboardist') {
      var blockName = getSongSection(window.cur.id) === 'keyboard' ? 'Teclado' : 'Acordeón';
      setText('rmeta', desiredMode === 'b'
        ? 'Letra + acordes · Guitarra · Bloque ' + blockName
        : 'Seguimiento de letra · Bloque ' + blockName);
    }
    var rd = $('rd'), nextPanel = $('fcNextOnlyPanel');
    if (nextPanel) {
      if (nextOnly) {
        var next = currentNextSong();
        setText('fcRoleCurrentSong', window.cur.title);
        setText('fcRoleNextSong', next ? next.title : 'Aún no hay siguiente canción en este evento');
        setText('fcRoleCurrentKey', window.cur.key ? 'Tono: ' + window.cur.key : 'Tonalidad no especificada');
        setText('fcRoleInstrumentName', role === 'accordionist' ? (instrument === 'guitar' ? 'Bloque Teclado · Guitarra' : 'Bloque Acordeón · Seguimiento') : role === 'keyboardist' ? (instrument === 'guitar' ? 'Bloque Acordeón · Acordes' : 'Bloque Teclado · Seguimiento') : 'Batería');
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
    var directorBtn = $('fcDirectorButton');
    if (directorBtn) directorBtn.style.display = memberRole === 'voice1' ? '' : 'none';
    var legacyAutoScroll = $('play');
    // Cuando el navegador ofrece seguimiento por voz, evitamos tener dos motores
    // de desplazamiento compitiendo. Si no hay API, el auto-scroll clásico queda como respaldo.
    if (legacyAutoScroll) legacyAutoScroll.style.display = memberRole === 'voice1' && speechApiConstructor() ? 'none' : '';
    renderVoiceFollowPanel();
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
    if (!isLiveSessionActive()) { banner.style.display = 'none'; return; }
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
    if (!isConnected() || !isLiveSessionActive() || !song || !ev) { mini.style.display = 'none'; return; }
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
    var index = (ev.songIds || []).indexOf(liveState.songId);
    var nextSong = index >= 0 && index + 1 < ev.songIds.length ? window.find(ev.songIds[index + 1]) : null;
    var previousSong = index > 0 ? window.find(ev.songIds[index - 1]) : null;
    setText('fcMiniNextSong', nextSong ? nextSong.title : 'Fin del repertorio');
    setText('fcMiniNextMeta', nextSong ? ((getSongSection(nextSong.id, ev) === 'keyboard' ? 'Teclado' : 'Acordeón') + (nextSong.key ? ' · Tono ' + displayKeyName(nextSong.key) : '')) : 'No hay otra canción en la cola');
    var action = $('fcMiniReturn');
    if (action) {
      action.textContent = memberRole === 'voice1' ? 'Abrir' : (!followDirector || browseOverride ? 'Volver a sincronía' : 'Ver en vivo');
      action.style.display = '';
    }
    var director = memberRole === 'voice1';
    ['fcMiniPrev','fcMiniPause','fcMiniNext'].forEach(function (id) { var b = $(id); if (b) b.style.display = director ? '' : 'none'; });
    var prevBtn = $('fcMiniPrev'); if (prevBtn) prevBtn.disabled = !previousSong;
    var nextBtn = $('fcMiniNext'); if (nextBtn) nextBtn.disabled = !nextSong;
    var pauseBtn = $('fcMiniPause');
    if (pauseBtn) { pauseBtn.textContent = liveState.paused ? '▶ Reanudar' : 'Ⅱ Pausar'; pauseBtn.setAttribute('aria-pressed', liveState.paused ? 'true' : 'false'); }
    var paused = !!liveState.paused;
    setText('fcMiniState', paused ? 'En pausa' : (speechWanted ? 'Voz activa' : 'En vivo'));
    mini.classList.toggle('is-free', memberRole !== 'voice1' && (!followDirector || browseOverride));
    mini.classList.toggle('is-paused', paused);
    var queueBtn = $('fcMiniQueue'); if (queueBtn) queueBtn.style.display = ev ? '' : 'none';
    var endBtn = $('fcMiniEnd'); if (endBtn) endBtn.style.display = canEndLiveEvent() ? '' : 'none';
  }
  function renderLiveBanner() {
    var banner = $('fcLiveBanner');
    if (banner) {
      if (!isLiveSessionActive()) banner.style.display = 'none';
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
    var relativeTop = r.top - container.top;
    var preferredTop = Math.max(38, rd.clientHeight * .28);
    // No reinicia la animación si la línea ya está en la zona cómoda de lectura.
    if (relativeTop < preferredTop - 24 || relativeTop > rd.clientHeight * .72) {
      var top = rd.scrollTop + relativeTop - preferredTop;
      var maxTop = Math.max(0, rd.scrollHeight - rd.clientHeight);
      rd.scrollTo({ top: Math.max(0, Math.min(maxTop, top)), behavior: 'smooth' });
    }
  }
  function handleLiveEventEnded(endedState) {
    var eventId = (endedState && endedState.eventId) || activeLiveEventOnThisClient;
    if (!eventId) { renderLiveBanner(); return; }
    var endKey = eventId + ':' + String((endedState && endedState.endedAt) || 'ended');
    var wasActiveHere = activeLiveEventOnThisClient === eventId;
    var readerWasOnEvent = !!(window.currentEventId === eventId && $('vr') && $('vr').classList.contains('on'));
    if (!wasActiveHere && !readerWasOnEvent) { renderLiveBanner(); return; }
    if (lastEndedLiveEventKey === endKey) { renderLiveBanner(); return; }
    lastEndedLiveEventKey = endKey;
    activeLiveEventOnThisClient = '';
    if (speechWanted) stopSpeechFollow('Evento finalizado. El micrófono se apagó.', false);
    if (scrollPublishTimer) { clearTimeout(scrollPublishTimer); scrollPublishTimer = null; }
    if (window.stopAll) window.stopAll();
    speechResumeAfterPause = false; speechCursor = -1; speechCandidate = -1; speechCandidateHits = 0; speechLastTranscript = '';
    lastHandledSong = ''; lastRemotePositionKey = ''; lastPublishedPositionKey = '';
    renderLiveBanner();
    var endedEvent = window.findEvent ? window.findEvent(eventId) : null;
    if (readerWasOnEvent) {
      if (endedEvent && window.renderEventPlaylist) { window.currentEventId = eventId; window.renderEventPlaylist(); window.show('vplaylist'); }
      else if (window.show) window.show('vl');
    }
    var eventName = endedEvent && endedEvent.name ? endedEvent.name : 'El evento';
    setStatus(eventName + ' finalizado. Se cerró el reproductor en los dispositivos conectados; el repertorio permanece guardado.', 'success');
  }
  function endLiveEvent() {
    if (!canEndLiveEvent()) { alert('Solo el propietario técnico o Voz 1 · Director pueden terminar el evento.'); return; }
    if (!isLiveSessionActive()) { setStatus('No hay un evento en vivo para terminar.', 'warning'); renderMiniPlayer(); return; }
    var eventId = liveState.eventId;
    var ev = window.findEvent ? window.findEvent(eventId) : null;
    var name = ev && ev.name ? ev.name : 'este evento';
    if (!confirm('¿Terminar "' + name + '" para todos los dispositivos?\n\nSe detendrá el seguimiento, se cerrará el reproductor y todos volverán al repertorio. El evento y sus canciones NO se eliminarán.')) return;
    var button = $('fcMiniEnd');
    if (button) { button.disabled = true; button.textContent = 'Finalizando…'; }
    var endedPayload = {
      status: 'ended', eventId: eventId, endedAt: firebase.database.ServerValue.TIMESTAMP,
      endedBy: currentUser.uid, endedByRole: memberRole,
      endedByName: roleName(memberRole), lastSongId: liveState.songId || null
    };
    db.ref(bandPath('live')).set(endedPayload).then(function () {
      liveState = Object.assign({}, endedPayload, { endedAt: Date.now() });
      handleLiveUpdate();
    }).catch(function (err) {
      setStatus('No se pudo terminar el evento: ' + (err && err.message ? err.message : 'error de Firebase'), 'error');
      alert('Firebase no permitió terminar el evento. No se cerró para los demás dispositivos.\n\n' + (err && err.message ? err.message : 'Comprueba los permisos y la conexión.'));
    }).finally(function () {
      if (button) { button.disabled = false; button.textContent = '■ Terminar evento'; }
    });
  }
  function handleLiveUpdate() {
    if (!isLiveSessionActive()) {
      renderLiveBanner();
      if (liveState && liveState.eventId && (liveState.status === 'ended' || liveState.endedAt)) handleLiveEventEnded(liveState);
      else if (!liveState && activeLiveEventOnThisClient) handleLiveEventEnded({ eventId: activeLiveEventOnThisClient });
      return;
    }
    activeLiveEventOnThisClient = liveState.eventId;
    lastEndedLiveEventKey = '';
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
      var payload = { status: 'active', eventId: eventId, songId: songId, position: index, rowIndex: 0, chordIndex: -1, paused: true, changedAt: firebase.database.ServerValue.TIMESTAMP, changedBy: currentUser.uid, changedByName: currentUser.displayName || 'Voz 1' };
      await db.ref(bandPath('live')).set(payload);
      liveState = Object.assign({}, payload, { changedAt: Date.now() });
      activeLiveEventOnThisClient = eventId; lastEndedLiveEventKey = '';
      window.currentEventId = eventId; lastHandledSong = eventId + ':' + songId; lastRemotePositionKey = '';
      lastPublishedPositionKey = '';
      speechCursor = -1; speechCandidate = -1; speechCandidateHits = 0; speechLastTranscript = '';
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
  // --- Seguimiento por voz (Voz 1) -----------------------------------------
  var SPEECH_STOP_WORDS = new Set('a al algo como con cual cuando de del desde donde el ella ellas ellos en entre era es esa ese eso esta estaba este esto fue ha hay la las le les lo los me mi mis muy ni no nos o para pero por que se sin su sus te tengo tu un una uno y ya yo'.split(' '));
  function speechApiConstructor() { return window.SpeechRecognition || window.webkitSpeechRecognition || null; }
  function normalizeSpeechTokens(text) {
    return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(function (token) { return token && !SPEECH_STOP_WORDS.has(token); });
  }
  function getSpeechLines(song) {
    song = song || window.cur;
    if (!song) return [];
    return String(song.text || '').split(/\r?\n/).map(function (raw, index) {
      var line = String(raw || '').replace(/^\s*##\s*/, '').replace(/\[[^\]]+\]/g, ' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
      if (!line || /^##/.test(raw)) return null;
      // Omite líneas que contienen únicamente acordes escritos sin letra.
      if (/^(?:[A-G](?:#|b)?(?:m|maj|min|dim|aug|sus\d?|add\d?|M|7|9|11|13|°|ø)?(?:\/[A-G](?:#|b)?)?\s*)+$/i.test(line)) return null;
      var tokens = normalizeSpeechTokens(line);
      if (tokens.length < 2) return null;
      return { rowIndex: index, text: line, tokens: tokens };
    }).filter(Boolean);
  }
  function speechLineScore(targetTokens, heardTokens) {
    if (!targetTokens.length || !heardTokens.length) return { score: 0, hits: 0 };
    var heardSet = new Set(heardTokens);
    var targetUnique = Array.from(new Set(targetTokens));
    var hits = targetUnique.filter(function (word) { return heardSet.has(word); }).length;
    var coverage = hits / Math.max(1, targetUnique.length);
    // Mayor subsecuencia contigua para conservar el orden de las palabras.
    var longest = 0;
    for (var i = 0; i < targetTokens.length; i++) {
      for (var j = 0; j < heardTokens.length; j++) {
        var n = 0;
        while (i + n < targetTokens.length && j + n < heardTokens.length && targetTokens[i + n] === heardTokens[j + n]) n++;
        if (n > longest) longest = n;
      }
    }
    var sequence = longest / Math.max(1, Math.min(4, targetUnique.length));
    return { score: Math.min(1, coverage * .66 + sequence * .34), hits: hits };
  }
  function setSpeechStatus(message, kind) {
    speechStatus = message;
    var status = $('fcVoiceStatus');
    if (status) { status.textContent = message; status.dataset.kind = kind || 'neutral'; }
    var start = $('fcVoiceStart'), stop = $('fcVoiceStop');
    if (start) { start.disabled = !!speechWanted; start.textContent = speechWanted ? 'Micrófono activo' : '🎤 Iniciar seguimiento por voz'; }
    if (stop) stop.disabled = !speechWanted;
    var panel = $('fcVoiceFollowPanel');
    if (panel) panel.classList.toggle('is-listening', !!speechWanted);
  }
  function renderVoiceFollowPanel() {
    var panel = $('fcVoiceFollowPanel');
    if (!panel) return;
    var eligible = isConnected() && memberRole === 'voice1' && !!window.cur && $('vr') && $('vr').classList.contains('on');
    panel.style.display = eligible ? '' : 'none';
    if (!eligible) return;
    var supported = !!speechApiConstructor();
    var support = $('fcVoiceSupport');
    if (support) support.textContent = supported
      ? 'El navegador solicitará permiso de micrófono. El audio no se guarda en tu Firebase; el servicio de reconocimiento del navegador puede procesarlo fuera del dispositivo.'
      : 'Este navegador no ofrece reconocimiento de voz. Puedes seguir usando los botones de avance manual.';
    var start = $('fcVoiceStart');
    if (start) { start.disabled = speechWanted || !supported; start.textContent = speechWanted ? 'Micrófono activo' : '🎤 Iniciar seguimiento por voz'; }
    var stop = $('fcVoiceStop'); if (stop) stop.disabled = !speechWanted;
    var mic = $('fcVoiceMicState'); if (mic) mic.textContent = speechWanted ? 'ESCUCHANDO' : 'MICRÓFONO INACTIVO';
    setSpeechStatus(speechStatus, speechWanted ? 'success' : 'neutral');
  }
  function scrollDirectorToRow(rowIndex) {
    if (!$('rt') || !$('rd')) return;
    var target = $('rt').querySelector('[data-line-index="' + Number(rowIndex) + '"]');
    if (!target) return;
    Array.prototype.forEach.call($('rt').querySelectorAll('[data-line-index]'), function (el) { el.classList.toggle('fc-live-row-current', el === target); });
    var rd = $('rd'), r = target.getBoundingClientRect(), container = rd.getBoundingClientRect();
    var top = rd.scrollTop + (r.top - container.top) - Math.max(35, rd.clientHeight * .28);
    rd.scrollTo({ top: Math.max(0, Math.min(Math.max(0, rd.scrollHeight - rd.clientHeight), top)), behavior: 'smooth' });
  }
  function tryMatchSpeech(transcript, isFinal) {
    if (memberRole !== 'voice1' || !window.cur || !liveState || liveState.songId !== window.cur.id || liveState.paused) return;
    var lines = getSpeechLines(window.cur);
    if (!lines.length) return;
    var currentRow = Number(liveState.rowIndex) || 0;
    var base = speechCursor >= 0 ? speechCursor + 1 : lines.findIndex(function (line) { return line.rowIndex >= currentRow; });
    if (base < 0) base = 0;
    var heard = normalizeSpeechTokens(transcript).slice(-34);
    if (heard.length < 3) return;
    var best = null;
    var limit = Math.min(lines.length - 1, base + 3);
    // Busca en orden desde la siguiente línea esperada. Así no salta al final
    // aunque el motor entregue varias frases anteriores en el mismo resultado.
    for (var i = base; i <= limit; i++) {
      var result = speechLineScore(lines[i].tokens, heard);
      var offset = i - base;
      var threshold = offset === 0 ? .58 : offset === 1 ? .73 : .84;
      var minimumHits = Math.min(2, new Set(lines[i].tokens).size);
      if (result.hits < minimumHits || result.score < threshold) continue;
      best = { index: i, line: lines[i], score: result.score, hits: result.hits };
      break;
    }
    if (!best) { speechCandidate = -1; speechCandidateHits = 0; return; }
    if (speechCandidate === best.index) speechCandidateHits++;
    else { speechCandidate = best.index; speechCandidateHits = 1; }
    // Requiere una frase final o dos resultados estables antes de mover la letra.
    var stable = isFinal || speechCandidateHits >= 2;
    if (!stable) return;
    speechCursor = best.index;
    speechCandidate = -1; speechCandidateHits = 0;
    if (Number(liveState.rowIndex) === best.line.rowIndex) return;
    publishLivePosition(best.line.rowIndex, -1, false);
    scrollDirectorToRow(best.line.rowIndex);
    setSpeechStatus('Reconocido: “' + best.line.text.slice(0, 58) + (best.line.text.length > 58 ? '…' : '') + '”', 'success');
  }
  function onSpeechResult(event) {
    if (!speechWanted) return;
    var parts = [], finalResult = false;
    var first = Math.max(Number(event.resultIndex) || 0, event.results.length - 2);
    for (var i = first; i < event.results.length; i++) {
      var result = event.results[i];
      if (result && result[0] && result[0].transcript) parts.push(result[0].transcript);
      if (i >= (event.resultIndex || 0) && result && result.isFinal) finalResult = true;
    }
    var transcript = parts.join(' ').trim();
    if (!transcript || transcript === speechLastTranscript) return;
    speechLastTranscript = transcript;
    tryMatchSpeech(transcript, finalResult);
  }
  function startSpeechInstance() {
    if (!speechWanted || document.visibilityState === 'hidden') return;
    var Ctor = speechApiConstructor();
    if (!Ctor) { speechWanted = false; setSpeechStatus('Reconocimiento de voz no disponible en este navegador. Usa avance manual.', 'warning'); return; }
    try {
      var recognition = new Ctor();
      speechRecognition = recognition;
      recognition.lang = 'es-MX';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 3;
      recognition.onstart = function () { if (speechRecognition === recognition) setSpeechStatus('Micrófono activo. Sigue cantando; la letra avanzará al reconocer cada frase.', 'success'); };
      recognition.onresult = function (event) { if (speechRecognition === recognition) onSpeechResult(event); };
      recognition.onerror = function (event) {
        if (speechRecognition !== recognition) return;
        var code = event && event.error || 'unknown';
        if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
          speechWanted = false;
          setSpeechStatus(code === 'audio-capture' ? 'No se encontró un micrófono disponible.' : 'Permiso de micrófono denegado. Actívalo en los ajustes del navegador.', 'error');
        } else if (code === 'network') {
          setSpeechStatus('El servicio de reconocimiento perdió conexión. Intentando reanudar…', 'warning');
        } else if (code !== 'no-speech' && code !== 'aborted') {
          setSpeechStatus('Reconocimiento interrumpido (' + code + '). Puedes usar el avance manual.', 'warning');
        }
      };
      recognition.onend = function () {
        if (speechRecognition === recognition) speechRecognition = null;
        if (!speechWanted || document.visibilityState === 'hidden') return;
        setSpeechStatus('Reanudando escucha…', 'neutral');
        if (speechRestartTimer) clearTimeout(speechRestartTimer);
        speechRestartTimer = setTimeout(startSpeechInstance, 850);
      };
      recognition.start();
    } catch (err) {
      speechRecognition = null;
      if (speechWanted) {
        setSpeechStatus('No se pudo iniciar el micrófono: ' + (err && err.message ? err.message : 'revisa el permiso del navegador.'), 'error');
        speechWanted = false;
      }
    }
  }
  async function startSpeechFollow() {
    if (memberRole !== 'voice1' || !isConnected()) { setSpeechStatus('Solo Voz 1 puede activar el seguimiento por voz.', 'warning'); return; }
    if (!speechApiConstructor()) { setSpeechStatus('Tu navegador no admite reconocimiento de voz. Usa el avance manual.', 'warning'); return; }
    if (!window.cur) { setSpeechStatus('Abre primero una canción del evento.', 'warning'); return; }
    var ev = getCurrentEvent();
    if (!ev || !ev.songIds || ev.songIds.indexOf(window.cur.id) < 0) { setSpeechStatus('Abre la canción desde el repertorio de un evento para sincronizarla.', 'warning'); return; }

    // Inicia SpeechRecognition directamente desde el clic del usuario. Safari/iOS
    // puede exigir activación de usuario para mostrar el permiso del micrófono;
    // no debemos esperar una escritura Firebase antes de llamar recognition.start().
    if (window.stopAll) window.stopAll();
    speechCursor = -1; speechCandidate = -1; speechCandidateHits = 0; speechLastTranscript = '';
    speechWanted = true;
    renderVoiceFollowPanel();
    setSpeechStatus('Solicitando permiso de micrófono…', 'neutral');
    startSpeechInstance();

    if (!liveState || liveState.eventId !== ev.id || liveState.songId !== window.cur.id) {
      await setLiveSong(ev.id, window.cur.id, ev.songIds.indexOf(window.cur.id));
    }
    if (!liveState || liveState.eventId !== ev.id || liveState.songId !== window.cur.id) {
      stopSpeechFollow('No se pudo poner esta canción en vivo. Comprueba la conexión y vuelve a intentarlo.', false);
      return;
    }
    // setLiveSong crea la nueva canción en pausa. Activamos el estado compartido
    // antes de procesar la primera frase para que el comparador no descarte voz.
    publishLivePosition(Number(liveState.rowIndex) || 0, Number(liveState.chordIndex) || -1, false);
    renderMiniPlayer();
  }
  function stopSpeechFollow(message, preserveForResume) {
    if (speechRestartTimer) { clearTimeout(speechRestartTimer); speechRestartTimer = null; }
    if (preserveForResume) speechResumeAfterPause = speechWanted;
    else speechResumeAfterPause = false;
    speechWanted = false;
    var rec = speechRecognition; speechRecognition = null;
    if (rec) { try { rec.onend = null; rec.onerror = null; rec.onresult = null; rec.stop(); } catch (e) { try { rec.abort(); } catch (e2) {} } }
    setSpeechStatus(message || 'Micrófono apagado.', 'neutral');
  }
  function advanceDirectorLine(delta) {
    if (memberRole !== 'voice1' || !window.cur || !liveState || liveState.songId !== window.cur.id) return;
    var lines = getSpeechLines(window.cur); if (!lines.length) return;
    var raw = Number(liveState.rowIndex) || 0;
    var current = speechCursor;
    if (current < 0) current = lines.findIndex(function (line) { return line.rowIndex >= raw; });
    if (current < 0) current = 0;
    var target = Math.max(0, Math.min(lines.length - 1, current + delta));
    speechCursor = target; speechCandidate = -1; speechCandidateHits = 0;
    publishLivePosition(lines[target].rowIndex, -1, false);
    scrollDirectorToRow(lines[target].rowIndex);
    setSpeechStatus('Posición manual: línea ' + (target + 1) + ' de ' + lines.length + '.', 'neutral');
  }
  function toggleLivePause() {
    if (memberRole !== 'voice1' || !liveState) return;
    if (!liveState.paused) {
      stopSpeechFollow('Reproducción en pausa.', true);
      if (window.stopAll) window.stopAll();
      publishLivePosition(Number(liveState.rowIndex) || 0, Number(liveState.chordIndex) || -1, true);
    } else {
      publishLivePosition(Number(liveState.rowIndex) || 0, Number(liveState.chordIndex) || -1, false);
      if (speechResumeAfterPause) { speechResumeAfterPause = false; startSpeechFollow(); }
    }
    renderMiniPlayer();
  }
  async function navigateLiveSong(offset) {
    if (memberRole !== 'voice1' || !liveState || !liveState.eventId) return;
    var ev = (window.events || []).find(function (item) { return item.id === liveState.eventId; });
    if (!ev || !Array.isArray(ev.songIds)) return;
    var index = ev.songIds.indexOf(liveState.songId), nextIndex = index + offset;
    if (index < 0 || nextIndex < 0 || nextIndex >= ev.songIds.length) { setStatus(offset > 0 ? 'Ya estás al final del repertorio.' : 'Ya estás al inicio del repertorio.', 'warning'); return; }
    var nextId = ev.songIds[nextIndex];
    var keepVoiceFollow = speechWanted;
    await setLiveSong(ev.id, nextId, nextIndex);
    window.currentEventId = ev.id;
    window.openSong(nextId, 'vplaylist');
    // Si Voz 1 estaba usando el micrófono, conserva el seguimiento al cambiar
    // de canción; el nuevo tema arranca en la primera línea sin pedir otro toque.
    if (keepVoiceFollow && speechWanted && liveState && liveState.songId === nextId) {
      speechCursor = -1; speechCandidate = -1; speechCandidateHits = 0; speechLastTranscript = '';
      publishLivePosition(0, -1, false);
    }
    renderMiniPlayer();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden' && speechWanted) stopSpeechFollow('Seguimiento por voz pausado al salir de la aplicación.', false);
  });

  // --- Cola del evento: editar y reordenar desde la lista en vivo -------------
  function persistQueueMutation(ev, previousIds, successText) {
    ev.updatedAt = Date.now();
    window.saveEvents().then(function () {
      window.renderEventPlaylist();
      if (successText) setStatus(successText, 'success');
    }).catch(function (err) {
      ev.songIds = previousIds;
      localSaveEvents();
      window.renderEventPlaylist();
      setStatus(err && err.message ? err.message : 'No se pudo guardar la cola del evento.', 'error');
    });
  }
  function bindPlaylistDragHandle(handle, row, container, index, ev) {
    handle.addEventListener('pointerdown', function (event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      playlistDragState = { pointerId: event.pointerId, from: index, to: index, row: row, container: container, handle: handle, eventId: ev.id };
      row.classList.add('is-drag-source'); handle.classList.add('is-dragging');
      try { handle.setPointerCapture(event.pointerId); } catch (e) {}
    });
    handle.addEventListener('pointermove', function (event) {
      if (!playlistDragState || playlistDragState.pointerId !== event.pointerId) return;
      var under = document.elementFromPoint(event.clientX, event.clientY);
      var target = under && under.closest ? under.closest('.fc-live-queue-row') : null;
      if (!target || !container.contains(target)) return;
      var targetIndex = Number(target.dataset.index);
      if (!Number.isFinite(targetIndex)) return;
      playlistDragState.to = targetIndex;
      Array.prototype.forEach.call(container.querySelectorAll('.fc-live-queue-row'), function (item) { item.classList.toggle('is-drop-target', item === target && targetIndex !== playlistDragState.from); });
    });
    function finish(event) {
      if (!playlistDragState || playlistDragState.pointerId !== event.pointerId) return;
      var state = playlistDragState; playlistDragState = null;
      if (state.handle) state.handle.classList.remove('is-dragging');
      if (state.row) state.row.classList.remove('is-drag-source');
      Array.prototype.forEach.call(container.querySelectorAll('.fc-live-queue-row'), function (item) { item.classList.remove('is-drop-target'); });
      var currentEvent = window.findEvent(state.eventId);
      if (!currentEvent || state.to === state.from || state.to < 0 || state.to >= currentEvent.songIds.length) return;
      var previous = currentEvent.songIds.slice();
      var moved = currentEvent.songIds.splice(state.from, 1)[0];
      currentEvent.songIds.splice(state.to, 0, moved);
      persistQueueMutation(currentEvent, previous, 'Orden del repertorio actualizado. La canción que está sonando no se interrumpió.');
    }
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', function (event) { if (playlistDragState && playlistDragState.pointerId === event.pointerId) finish(event); });
    handle.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      var currentEvent = window.findEvent(ev.id); if (!currentEvent) return;
      var to = index + (event.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= currentEvent.songIds.length) return;
      var previous = currentEvent.songIds.slice(), moved = currentEvent.songIds.splice(index, 1)[0];
      currentEvent.songIds.splice(to, 0, moved); persistQueueMutation(currentEvent, previous, 'Orden actualizado.');
    });
  }
  function ensureQueueTools() {
    var list = $('playlistSongs'); if (!list) return null;
    var tools = $('fcQueueTools');
    if (!tools) {
      tools = document.createElement('section'); tools.id = 'fcQueueTools'; tools.className = 'fc-queue-tools';
      tools.innerHTML = '<div class="fc-queue-tools-head"><div><strong>Cola del evento</strong><small>Ordena y añade canciones sin salir de esta pantalla.</small></div><button type="button" id="fcQueueAddToggle" class="p">＋ Añadir</button></div><div id="fcQueueAddPanel" class="fc-queue-add-panel" hidden><input id="fcQueueSearch" type="search" placeholder="Buscar canción del catálogo…" aria-label="Buscar canción para agregar"><div id="fcQueueSearchResults" class="fc-queue-search-results"></div></div>';
      list.parentNode.insertBefore(tools, list);
    }
    return tools;
  }
  function renderQueueSearch() {
    var result = $('fcQueueSearchResults'), search = $('fcQueueSearch');
    if (!result || !search) return;
    result.innerHTML = '';
    var ev = getCurrentEvent(); if (!ev) return;
    var q = normalizeSpeechTokens(search.value).join(' ');
    var existing = new Set(ev.songIds || []);
    var found = (window.songs || []).filter(function (song) {
      if (existing.has(song.id)) return false;
      var haystack = (song.title || '') + ' ' + (song.key || '') + ' ' + (song.section === 'keyboard' ? 'teclado' : 'acordeon');
      return !q || normalizeSpeechTokens(haystack).join(' ').includes(q);
    }).slice(0, 30);
    if (!found.length) { var empty = document.createElement('p'); empty.className = 'fc-inline-hint'; empty.textContent = 'No hay canciones disponibles con esa búsqueda.'; result.appendChild(empty); return; }
    found.forEach(function (song) {
      var row = document.createElement('div'); row.className = 'fc-queue-search-row';
      var info = document.createElement('span'); info.textContent = song.title + ' · ' + (song.section === 'keyboard' ? 'Teclado' : 'Acordeón') + (song.key ? ' · ' + displayKeyName(song.key) : '');
      var add = document.createElement('button'); add.type = 'button'; add.textContent = 'Agregar';
      add.onclick = function () {
        var currentEvent = getCurrentEvent(); if (!currentEvent || currentEvent.songIds.indexOf(song.id) >= 0) return;
        var previous = currentEvent.songIds.slice(); currentEvent.songIds.push(song.id);
        currentEvent.assignments = currentEvent.assignments || {};
        if (!currentEvent.assignments[song.id]) currentEvent.assignments[song.id] = eventAssignmentDefaults(song.id);
        persistQueueMutation(currentEvent, previous, 'Canción agregada al final de la cola.');
      };
      row.append(info, add); result.appendChild(row);
    });
  }
  function removeSongFromLiveQueue(songId) {
    var ev = getCurrentEvent(); if (!ev) return;
    if (liveState && liveState.eventId === ev.id && liveState.songId === songId) { alert('No puedes quitar la canción que está sonando. Primero avanza a otra canción o detén el evento.'); return; }
    var previous = ev.songIds.slice(); ev.songIds = ev.songIds.filter(function (id) { return id !== songId; });
    if (ev.assignments) delete ev.assignments[songId];
    persistQueueMutation(ev, previous, 'Canción retirada de la cola.');
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

  // Guarda localmente y publica el catálogo compartido desde el propietario
  // o desde uno de sus dispositivos QR vinculados. Las reglas Firebase deben
  // autorizar explícitamente esos dispositivos en /catalog.
  window.save = function () {
    if (!isConnected() || accessRevoked || accessVerificationPending) { maybeShowFirstProfileGate(); setStatus('El catálogo solo está disponible para integrantes aprobados.', 'warning'); return; }
    if (typeof originalSave === 'function') originalSave();
    if (applyingRemote || !db || !bandId) return;
    if (!isTechnicalOwner()) {
      setStatus('Este perfil no tiene permiso para modificar el catálogo compartido. Solicita al propietario que edite las canciones.', 'warning');
      return;
    }
    var payload = mapById(window.songs || []), serialized = safeJson(payload);
    // No se marca como sincronizado hasta que Firebase confirma el set.
    // La cola conserva el orden si se guardan varias canciones rápidamente.
    if (serialized === lastCatalogJson || serialized === catalogWriteQueuedJson) return;
    catalogWriteQueuedJson = serialized;
    var targetBand = bandId;
    catalogWriteQueue = catalogWriteQueue.catch(function () {}).then(function () {
      if (accessRevoked || accessVerificationPending || !db || bandId !== targetBand) return;
      return db.ref(bandPath('catalog')).set(payload).then(function () {
        lastCatalogJson = serialized;
        if (catalogWriteQueuedJson === serialized) catalogWriteQueuedJson = '';
        setStatus('Catálogo guardado y sincronizado con Firebase.', 'success');
      }).catch(function (err) {
        if (catalogWriteQueuedJson === serialized) catalogWriteQueuedJson = '';
        var detail = err && err.code === 'PERMISSION_DENIED'
          ? 'Firebase rechazó la escritura del catálogo desde este dispositivo vinculado. Publica las reglas V21 de Realtime Database para permitir al dispositivo QR del propietario.'
          : 'No se pudo publicar el catálogo: ' + (err && err.message ? err.message : 'error de conexión.');
        setStatus(detail, 'error');
        if (err && err.code === 'PERMISSION_DENIED' && $('ve') && $('ve').classList.contains('on')) {
          alert('La canción quedó guardada solamente en este navegador; no se sincronizó con los demás dispositivos. ' + detail);
        }
      });
    });
  };
  window.saveEvents = function () {
    if (!isConnected() || accessRevoked || accessVerificationPending) return Promise.reject(new Error('Este dispositivo no tiene autorización para guardar eventos.'));
    if (typeof originalSaveEvents === 'function') originalSaveEvents();
    if (applyingRemote) return Promise.resolve(true);
    if (!db || !bandId) return Promise.reject(new Error('No hay una banda autorizada conectada a Firebase.'));
    if (!(isTechnicalOwner() || memberRole === 'voice1')) {
      var denied = new Error('Este perfil no tiene permiso para crear o modificar eventos.');
      setStatus(denied.message, 'warning');
      return Promise.reject(denied);
    }
    var payload = mapById(window.events || []), serialized = safeJson(payload);
    if (serialized === lastEventsJson) return Promise.resolve(true);
    if (serialized === eventsWriteQueuedJson) return eventsWriteQueue;
    eventsWriteQueuedJson = serialized;
    var targetBand = bandId;
    eventsWriteQueue = eventsWriteQueue.catch(function () {}).then(function () {
      if (accessRevoked || accessVerificationPending || !db || bandId !== targetBand) throw new Error('La conexión con la banda cambió antes de guardar el evento.');
      return db.ref(bandPath('events')).set(payload);
    }).then(function () {
      if (bandId === targetBand) lastEventsJson = serialized;
      if (eventsWriteQueuedJson === serialized) eventsWriteQueuedJson = '';
      setStatus('Evento guardado y sincronizado con Firebase.', 'success');
      return true;
    }).catch(function (err) {
      if (eventsWriteQueuedJson === serialized) eventsWriteQueuedJson = '';
      var detail = err && err.code === 'PERMISSION_DENIED'
        ? 'Firebase rechazó el guardado. Publica las reglas V24 de Realtime Database para permitir al dispositivo vinculado al propietario guardar eventos.'
        : 'No se pudo sincronizar el evento: ' + (err && err.message ? err.message : 'error de conexión.');
      setStatus(detail, 'error');
      throw new Error(detail);
    });
    return eventsWriteQueue;
  };
  window.openSong = function (id, backTo) {
    if (!isConnected() || accessRevoked || accessVerificationPending) { maybeShowFirstProfileGate(); return; }
    if (!openingFromLive && memberRole === 'voice1' && speechWanted && liveState && id !== liveState.songId) {
      stopSpeechFollow('Seguimiento por voz detenido al abrir una canción fuera de la canción en vivo.', false);
    }
    if (!openingFromLive && memberRole !== 'voice1' && liveState && liveState.songId) {
      if (id !== liveState.songId) browseOverride = true;
      else browseOverride = false;
    }
    if (typeof originalOpenSong === 'function') originalOpenSong(id, backTo);
    applyRoleToCurrentSong();
    renderMiniPlayer();
  };
  window.show = function (id) {
    if ((!isConnected() || accessRevoked || accessVerificationPending) && id !== 'vm') { if (typeof originalShow === 'function') originalShow('vl'); maybeShowFirstProfileGate(); return; }
    if (typeof originalShow === 'function') originalShow(id);
    document.body.classList.toggle('fc-reader-open', id === 'vr');
    if (id === 'vm') updateSyncButtons();
    else if (id === 'vl' || id === 'vse' || id === 'vplaylist' || id === 'vr') setTimeout(handleLiveUpdate, 0);
    renderMiniPlayer();
  };

  // Editor de evento: asignación independiente por canción para acordeonista y tecladista.
  window.editEvent = function (id) {
    if (!isConnected()) { maybeShowFirstProfileGate(); return; }
    if (!canManageEvents()) { alert('Solo Voz 1 · Director o el propietario técnico pueden editar los eventos.'); return; }
    var ev = id ? window.findEvent(id) : null;
    window.eventEditId = id || null;
    window.eventDraftSongIds = ev ? (ev.songIds || []).slice() : [];
    eventDraftAssignments = ev && ev.assignments ? JSON.parse(JSON.stringify(ev.assignments)) : {};
    window.eventDraftSongIds.forEach(function (songId) {
      if (!eventDraftAssignments[songId]) eventDraftAssignments[songId] = eventAssignmentDefaults(songId);
      var assignment = eventDraftAssignments[songId];
      if (assignment.section !== 'accordion' && assignment.section !== 'keyboard') {
        assignment.section = catalogSongSection(songId);
        assignment.manualSection = false;
      } else if (assignment.manualSection == null) {
        // Migración segura desde V19: Teclado se conserva como excepción manual;
        // Acordeón se considera el valor heredado por defecto del catálogo antiguo.
        assignment.manualSection = assignment.section === 'keyboard';
        if (!assignment.manualSection) assignment.section = catalogSongSection(songId);
      }
    });
    $('eventEditorHeading').textContent = ev ? 'Editar evento' : 'Nuevo evento';
    $('eventName').value = ev ? ev.name : '';
    $('eventSongSearch').value = '';
    $('eventDelete').style.display = ev ? '' : 'none';
    window.renderEventEditor();
    window.show('vset');
  };
  function bindEventDragHandle(handle, row, container, index) {
    handle.addEventListener('pointerdown', function (event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (event.target && event.target.closest && event.target.closest('button:not(.fc-drag-handle)')) return;
      event.preventDefault();
      eventDragState = { pointerId: event.pointerId, from: index, to: index, handle: handle, row: row, container: container };
      handle.classList.add('is-dragging');
      row.classList.add('is-drag-source');
      try { handle.setPointerCapture(event.pointerId); } catch (e) {}
    });
    handle.addEventListener('pointermove', function (event) {
      if (!eventDragState || eventDragState.pointerId !== event.pointerId) return;
      var under = document.elementFromPoint(event.clientX, event.clientY);
      var targetRow = under && under.closest ? under.closest('.event-selected-row') : null;
      if (!targetRow || !container.contains(targetRow)) return;
      var nextIndex = Number(targetRow.dataset.index);
      if (!Number.isFinite(nextIndex)) return;
      eventDragState.to = nextIndex;
      Array.prototype.forEach.call(container.querySelectorAll('.event-selected-row'), function (item) {
        item.classList.toggle('is-drop-target', item === targetRow && nextIndex !== eventDragState.from);
      });
    });
    function finish(event) {
      if (!eventDragState || eventDragState.pointerId !== event.pointerId) return;
      var state = eventDragState;
      eventDragState = null;
      if (state.handle) state.handle.classList.remove('is-dragging');
      if (state.row) state.row.classList.remove('is-drag-source');
      Array.prototype.forEach.call(container.querySelectorAll('.event-selected-row'), function (item) { item.classList.remove('is-drop-target'); });
      if (state.to !== state.from && state.to >= 0 && state.to < window.eventDraftSongIds.length) {
        var moved = window.eventDraftSongIds.splice(state.from, 1)[0];
        window.eventDraftSongIds.splice(state.to, 0, moved);
        window.renderEventEditor();
      }
    }
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', function (event) {
      if (eventDragState && eventDragState.pointerId === event.pointerId) finish(event);
    });
    handle.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      window.moveDraftSong(index, event.key === 'ArrowUp' ? -1 : 1);
    });
  }

  window.renderEventEditor = function () {
    var chosen = $('eventSelected'); chosen.innerHTML = '';
    $('eventSelectedCount').textContent = window.eventDraftSongIds.length + ' seleccionadas · aprox. ' + window.formatDurationLong(window.eventDuration(window.eventDraftSongIds));
    if (!window.eventDraftSongIds.length) { var msg = document.createElement('p'); msg.className = 'note'; msg.textContent = 'Aún no agregas canciones. Selecciónalas en el catálogo de abajo.'; chosen.appendChild(msg); }
    window.eventDraftSongIds.forEach(function (id, i) {
      var s = window.find(id), row = document.createElement('div'); row.className = 'event-selected-row fc-event-selected-row'; row.dataset.index = String(i);
      var head = document.createElement('div'); head.className = 'fc-event-song-head';
      var handle = document.createElement('button'); handle.type = 'button'; handle.className = 'fc-drag-handle'; handle.textContent = '☰'; handle.title = 'Mantén pulsado y arrastra para ordenar'; handle.setAttribute('aria-label', 'Mover ' + (s ? s.title : 'canción'));
      var pos = document.createElement('span'); pos.className = 'event-position'; pos.textContent = i + 1;
      var title = document.createElement('span'); title.className = 'event-selected-title'; title.textContent = s ? s.title : 'Canción no disponible';
      var duration = document.createElement('small'); duration.className = 'event-selected-time'; duration.textContent = s ? window.formatDuration(window.songDuration(s)) : '--:--';
      var remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = 'Quitar del evento'; remove.setAttribute('aria-label', 'Quitar ' + (s ? s.title : 'canción') + ' del evento'); remove.onclick = function () { window.eventDraftSongIds.splice(i, 1); window.renderEventEditor(); };
      head.append(handle, pos, title, duration, remove); row.appendChild(head);
      var controls = document.createElement('div'); controls.className = 'fc-section-control';
      var keyMeta = document.createElement('span'); keyMeta.className = 'fc-section-key';
      keyMeta.textContent = s && s.key ? 'Tono ' + displayKeyName(s.key) : 'Tono no especificado';
      var sectionLabel = document.createElement('label'); sectionLabel.textContent = 'Bloque del repertorio';
      var section = document.createElement('select'); section.setAttribute('aria-label', 'Bloque musical de ' + (s ? s.title : 'la canción'));
      [['auto','Según bloque del catálogo'],['accordion','🪗 Acordeón'],['keyboard','🎹 Teclado']].forEach(function (item) { var option = document.createElement('option'); option.value = item[0]; option.textContent = item[1]; section.appendChild(option); });
      var existing = eventDraftAssignments[id] || eventAssignmentDefaults(id);
      section.value = existing.manualSection === true ? existing.section : 'auto';
      section.onchange = function () {
        if (!eventDraftAssignments[id]) eventDraftAssignments[id] = eventAssignmentDefaults(id);
        if (section.value === 'auto') {
          eventDraftAssignments[id].manualSection = false;
          eventDraftAssignments[id].section = catalogSongSection(id);
        } else {
          eventDraftAssignments[id].manualSection = true;
          eventDraftAssignments[id].section = section.value;
        }
        var prefix = (window.currentEventId || 'catalog') + ':' + id + ':';
        delete instrumentOverrides[prefix + 'accordionist'];
        delete instrumentOverrides[prefix + 'keyboardist'];
        localStorage.setItem(OVERRIDE_KEY, safeJson(instrumentOverrides));
      };
      sectionLabel.appendChild(section); controls.append(keyMeta, sectionLabel); row.appendChild(controls); chosen.appendChild(row);
      bindEventDragHandle(handle, row, chosen, i);
    });
    window.renderSongPicker();
  };
  window.saveEventEditor = async function () {
    if (!isConnected()) { maybeShowFirstProfileGate(); alert('Debes tener una solicitud aprobada para crear eventos.'); return; }
    if (!canManageEvents()) { alert('Solo Voz 1 · Director o el propietario técnico pueden guardar eventos.'); return; }
    var name = $('eventName').value.trim();
    if (!name) { alert('Escribe el nombre del evento.'); $('eventName').focus(); return; }
    var previousEvents = JSON.parse(safeJson(window.events || []));
    var ev = window.eventEditId ? window.findEvent(window.eventEditId) : null;
    if (!ev) { ev = { id: 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), name: name, songIds: [], assignments: {}, createdAt: Date.now() }; window.events.push(ev); }
    ev.name = name; ev.songIds = window.eventDraftSongIds.slice(); ev.assignments = {};
    ev.songIds.forEach(function (id) { ev.assignments[id] = eventDraftAssignments[id] || eventAssignmentDefaults(id); });
    ev.updatedAt = Date.now();
    var saveButton = $('eventSave');
    if (saveButton) { saveButton.disabled = true; saveButton.textContent = 'Guardando…'; }
    try {
      await window.saveEvents();
      window.renderEvents(); window.currentEventId = ev.id; window.openEvent(ev.id);
    } catch (err) {
      window.events = previousEvents;
      localSaveEvents();
      window.renderEvents();
      setStatus(err && err.message ? err.message : 'El evento no pudo guardarse.', 'error');
      alert('El evento no se guardó en la banda. No se perderá tu repertorio: revisa tu conexión y los permisos de Firebase e inténtalo otra vez.\n\n' + (err && err.message ? err.message : 'Error desconocido.'));
    } finally {
      if (saveButton) { saveButton.disabled = false; saveButton.textContent = 'Guardar evento'; }
    }
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
      var isLive = isLiveSessionActive() && liveState.eventId === ev.id;
      meta.textContent = (ev.songIds || []).length + ' canciones · aprox. ' + window.formatDurationLong(window.eventDuration(ev.songIds)) + (isLive ? ' · EN VIVO' : '');
      main.append(name, meta); main.onclick = function () { window.openEvent(ev.id); };
      row.append(icon, main);
      if (isConnected() && canManageEvents()) { var edit = document.createElement('button'); edit.className = 'event-folder-edit'; edit.textContent = 'Editar'; edit.onclick = function () { window.editEvent(ev.id); }; row.appendChild(edit); }
      l.appendChild(row);
    });
  };
  window.openEvent = function (id) { if (!isConnected() || accessRevoked || accessVerificationPending) { maybeShowFirstProfileGate(); return; } var ev = window.findEvent(id); if (!ev) return; window.currentEventId = id; window.fcPlaylistCategoryFilter = 'all'; window.renderEventPlaylist(); window.show('vplaylist'); };
  window.renderEventPlaylist = function () {
    var ev = window.findEvent(window.currentEventId); if (!ev) return;
    $('playlistName').textContent = ev.name;
    var accordionCount = (ev.songIds || []).filter(function (id) { return getSongSection(id, ev) === 'accordion'; }).length;
    var keyboardCount = (ev.songIds || []).filter(function (id) { return getSongSection(id, ev) === 'keyboard'; }).length;
    $('playlistMeta').textContent = (ev.songIds || []).length + ' canciones · ' + accordionCount + ' Acordeón · ' + keyboardCount + ' Teclado · duración: ' + window.formatDurationLong(window.eventDuration(ev.songIds)) + (isConnected() ? ' · Banda sincronizada' : ' · Guardado en este teléfono');
    $('playlistMode').textContent = isConnected() ? roleName(memberRole) : (window.mode === 's' ? 'Vista cantante' : 'Vista bajista');
    $('playlistModeToggle').style.display = 'none';
    $('playlistEdit').style.display = (isConnected() && canManageEvents()) ? '' : 'none';
    $('eventShare').style.display = isConnected() ? 'none' : '';
    var shareArea = document.querySelector('.event-share-area'); if (shareArea) shareArea.style.display = isConnected() ? 'none' : '';
    var l = $('playlistSongs');
    var filters = $('playlistCategoryFilters');
    if (!filters) { filters = document.createElement('div'); filters.id = 'playlistCategoryFilters'; filters.className = 'fc-category-filters'; l.parentNode.insertBefore(filters, l); }
    filters.innerHTML = '';
    var activeFilter = window.fcPlaylistCategoryFilter || 'all';
    [['all','Todas (' + (ev.songIds || []).length + ')'],['accordion','Acordeón (' + accordionCount + ')'],['keyboard','Teclado (' + keyboardCount + ')']].forEach(function (item) {
      var button = document.createElement('button'); button.type = 'button'; button.textContent = item[1]; button.className = activeFilter === item[0] ? 'active' : '';
      button.setAttribute('aria-pressed', activeFilter === item[0] ? 'true' : 'false');
      button.onclick = function () { window.fcPlaylistCategoryFilter = item[0]; window.renderEventPlaylist(); };
      filters.appendChild(button);
    });
    var tools = ensureQueueTools();
    if (tools) {
      var canEditQueue = isConnected() && canManageEvents();
      tools.style.display = canEditQueue ? '' : 'none';
      var toggle = $('fcQueueAddToggle'), panel = $('fcQueueAddPanel'), search = $('fcQueueSearch');
      if (toggle) toggle.onclick = function () { queueAddOpen = !queueAddOpen; if (panel) panel.hidden = !queueAddOpen; if (queueAddOpen && search) { renderQueueSearch(); search.focus(); } };
      if (panel) panel.hidden = !queueAddOpen;
      if (search) { search.oninput = renderQueueSearch; if (queueAddOpen) renderQueueSearch(); }
    }
    l.innerHTML = '';
    if (!ev.songIds || !ev.songIds.length) { var empty = document.createElement('div'); empty.className = 'playlist-empty'; empty.textContent = 'Esta carpeta todavía no tiene canciones. Usa Añadir para agregarlas desde el catálogo.'; l.appendChild(empty); renderMiniPlayer(); return; }
    var visibleCount = 0, currentIndex = isLiveSessionActive() && liveState.eventId === ev.id ? ev.songIds.indexOf(liveState.songId) : -1;
    if (activeFilter !== 'all' && isConnected() && canManageEvents()) {
      var filterNote = document.createElement('p'); filterNote.className = 'fc-inline-hint'; filterNote.textContent = 'Para reordenar la cola completa, selecciona “Todas”.'; l.appendChild(filterNote);
    }
    ev.songIds.forEach(function (id, i) {
      var section = getSongSection(id, ev);
      if (activeFilter !== 'all' && section !== activeFilter) return;
      var song = window.find(id); if (!song) return;
      visibleCount++;
      var row = document.createElement('div'); row.className = 'playlist-song fc-live-queue-row'; row.dataset.index = String(i);
      var isCurrent = currentIndex === i;
      var isNext = currentIndex >= 0 && i === currentIndex + 1;
      if (isCurrent) row.classList.add('fc-live-song');
      var number = document.createElement('span'); number.className = 'playlist-number'; number.textContent = String(i + 1).padStart(2, '0');
      var canEditQueue = isConnected() && canManageEvents();
      if (canEditQueue && activeFilter === 'all') {
        var handle = document.createElement('button'); handle.type = 'button'; handle.className = 'fc-live-queue-handle'; handle.textContent = '☰'; handle.title = 'Mantén pulsado y arrastra para reordenar'; handle.setAttribute('aria-label', 'Mover ' + song.title); row.appendChild(handle);
        bindPlaylistDragHandle(handle, row, l, i, ev);
      }
      var open = document.createElement('button'); open.className = 'playlist-open';
      var title = document.createElement('strong'); title.textContent = song.title;
      var detail = document.createElement('small');
      var instrumentForThisRole = memberRole === 'accordionist' ? getAssignment(id, 'accordionist') : memberRole === 'keyboardist' ? getAssignment(id, 'keyboardist') : '';
      detail.textContent = (section === 'keyboard' ? 'TECLADO' : 'ACORDEÓN') + ' · ' + (song.key ? 'Tono ' + displayKeyName(song.key) : 'Sin tonalidad') + ' · ' + window.formatDuration(window.songDuration(song)) + ' aprox.' + (instrumentForThisRole ? ' · Tú: ' + (instrumentForThisRole === 'guitar' ? 'Guitarra / acordes' : instrumentForThisRole === 'accordion' ? 'Acordeón / letra en vivo' : 'Teclado / letra en vivo') : '');
      open.append(title, detail); open.onclick = function () { window.openSong(song.id, 'vplaylist'); };
      row.append(number, open);
      if (isCurrent) { var currentBadge = document.createElement('span'); currentBadge.className = 'fc-queue-badge current'; currentBadge.textContent = 'SONANDO'; row.appendChild(currentBadge); }
      else if (isNext) { var nextBadge = document.createElement('span'); nextBadge.className = 'fc-queue-badge next'; nextBadge.textContent = 'SIGUIENTE'; row.appendChild(nextBadge); }
      if (isConnected() && memberRole === 'voice1' && db && bandId) {
        var play = document.createElement('button'); play.className = 'p fc-play-song'; play.textContent = isCurrent ? 'En curso' : '▶ Tocar'; play.disabled = isCurrent;
        play.onclick = async function () {
          var keepVoiceFollow = speechWanted;
          await setLiveSong(ev.id, song.id, i);
          window.openSong(song.id, 'vplaylist');
          if (keepVoiceFollow && speechWanted && liveState && liveState.songId === song.id) {
            speechCursor = -1; speechCandidate = -1; speechCandidateHits = 0; speechLastTranscript = '';
            publishLivePosition(0, -1, false);
          }
          renderMiniPlayer();
        };
        row.appendChild(play);
      }
      if (canEditQueue) {
        var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'fc-queue-remove'; remove.textContent = '×'; remove.title = isCurrent ? 'La canción actual no se puede quitar' : 'Quitar de la cola'; remove.disabled = isCurrent; remove.onclick = function () { removeSongFromLiveQueue(song.id); }; row.appendChild(remove);
      }
      l.appendChild(row);
    });
    if (!visibleCount) { var filteredEmpty = document.createElement('div'); filteredEmpty.className = 'playlist-empty'; filteredEmpty.textContent = 'No hay canciones en este bloque.'; l.appendChild(filteredEmpty); }
    renderLiveBanner(); renderMiniPlayer();
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
    if (document.body) document.body.classList.remove('fc-session-pending');
  }
  function handleAccessRevoked(message, revokedKind) {
    if (handlingRevocation || (accessRevoked && !bandId && !memberProfile)) return;
    handlingRevocation = true;
    accessRevoked = true; accessVerificationPending = false;
    revocationMode = revokedKind || identityKind || localStorage.getItem(IDENTITY_KIND_KEY) || 'member';
    if (revocationMode !== 'devices') revocationMode = 'member';
    try { localStorage.setItem(ACCESS_REVOKED_KEY, '1'); localStorage.setItem(ACCESS_REVOKED_MODE_KEY, revocationMode); } catch (e) {}
    // Detén los controles locales y elimina todos los listeners de la banda.
    try { if (window.stopAll) window.stopAll(); } catch (e) {}
    try { stopPairScanner(); } catch (e) {}
    try { closePairQr(); } catch (e) {}
    Object.keys(refs || {}).forEach(function (key) { try { refs[key].off(); } catch (e) {} });
    refs = {}; attachedUid = ''; watchingIdentity = false;
    // Conserva la identidad anónima de Firebase, pero elimina la autorización local.
    bandId = ''; bandMeta = null; memberRole = 'unjoined'; memberProfile = null;
    memberList = {}; deviceList = {}; presenceMap = {}; joinRequestList = {};
    liveState = null; inviteCode = ''; identityKind = 'members';
    selectedProfileRole = ''; window.fcJoinRequestPending = false;
    try {
      localStorage.removeItem(BAND_KEY);
      localStorage.removeItem(PROFILE_KEY);
      localStorage.removeItem(IDENTITY_KIND_KEY);
      localStorage.removeItem(window.KEY || 'letras_frecuencia_cero_v3');
      localStorage.removeItem(window.EVENT_KEY || 'frecuencia_cero_eventos_v1');
      localStorage.removeItem('letras_v1');
      localStorage.removeItem('letras_fc_v2');
    } catch (e) {}
    // Borra la copia local que había descargado esta banda; no borra la identidad Firebase.
    window.songs = []; window.events = []; window.cur = null; window.currentEventId = null;
    lastCatalogJson = ''; lastEventsJson = ''; lastHandledSong = ''; lastRemotePositionKey = '';
    if ($('rt')) $('rt').innerHTML = '';
    if ($('fcMiniPlayer')) $('fcMiniPlayer').style.display = 'none';
    if ($('fcLiveBanner')) $('fcLiveBanner').style.display = 'none';
    if (typeof window.render === 'function') window.render();
    if (typeof window.renderEvents === 'function') window.renderEvents();
    if (typeof window.show === 'function') window.show('vl');
    setStatus(message || 'Tu acceso fue retirado. Selecciona tu perfil y solicita nuevamente la incorporación.', 'warning');
    firstProfileGateShown = false;
    var gate = $('fcFirstProfileGate');
    if (gate) {
      var notice = $('fcGateRevokedNotice'); if (notice) { notice.style.display = ''; notice.textContent = revocationMode === 'devices' ? 'Este dispositivo fue desvinculado. Para recuperar el acceso, escanea un nuevo QR que genere otro dispositivo autorizado de tu perfil.' : 'Tu acceso a la banda fue retirado. Elige tu función y solicita nuevamente la incorporación. No podrás ver canciones ni eventos hasta que el propietario te apruebe.'; }
      var status = $('fcGateStatus'); if (status) status.textContent = message || (revocationMode === 'devices' ? 'Este dispositivo ya no está vinculado.' : 'Tu acceso fue retirado. Selecciona tu función y solicita nuevamente la incorporación.');
      var grid = gate.querySelector('.fc-profile-grid'); if (grid) grid.style.display = revocationMode === 'devices' ? 'none' : '';
      var requestButton = $('fcGateRequestJoin'); if (requestButton) { requestButton.style.display = revocationMode === 'devices' ? 'none' : ''; requestButton.disabled = true; requestButton.textContent = 'Solicitar reincorporación'; }
      var qrButton = $('fcProfileGateQr'); if (qrButton) qrButton.style.display = revocationMode === 'devices' ? '' : 'none';
    }
    updateSyncButtons();
    maybeShowFirstProfileGate();
    // Los listeners propios vuelven a quedar activos para detectar una aprobación posterior.
    watchingIdentity = false;
    watchOwnMembership();
    handlingRevocation = false;
  }

  function maybeShowFirstProfileGate() {
    if (memberProfile || !currentUser || firstProfileGateShown) return;
    try { if (new URL(window.location.href).searchParams.get('fc_pair')) return; } catch (e) {}
    var gate = $('fcFirstProfileGate');
    if (!gate) return;
    var grid = gate.querySelector('.fc-profile-grid');
    var requestButton = $('fcGateRequestJoin');
    var qrButton = $('fcProfileGateQr');
    var ownerSetup = $('fcGateOwnerSetup');
    var status = $('fcGateStatus');
    var notice = $('fcGateRevokedNotice');
    if (accessVerificationPending) {
      if (notice) { notice.style.display = ''; notice.textContent = 'Verificando que este dispositivo siga autorizado. El repertorio permanecerá bloqueado hasta confirmar el acceso.'; }
      if (grid) grid.style.display = 'none';
      if (requestButton) requestButton.style.display = 'none';
      if (qrButton) qrButton.style.display = 'none';
      if (ownerSetup) ownerSetup.style.display = 'none';
    } else if (accessRevoked) {
      if (notice) { notice.style.display = ''; notice.textContent = revocationMode === 'devices' ? 'Este dispositivo fue desvinculado. Escanea un nuevo QR de un dispositivo autorizado para volver a conectarlo.' : 'Tu acceso a la banda fue retirado. Selecciona tu función y solicita nuevamente la incorporación. No podrás ver canciones ni eventos hasta que el propietario te apruebe.'; }
      if (grid) grid.style.display = revocationMode === 'devices' ? 'none' : '';
      if (requestButton) { requestButton.style.display = revocationMode === 'devices' ? 'none' : (selectedProfileRole && selectedProfileRole !== 'accordionist' ? '' : 'none'); requestButton.disabled = !!window.fcJoinRequestPending; requestButton.textContent = window.fcJoinRequestPending ? 'Solicitud pendiente' : 'Solicitar reincorporación'; }
      if (qrButton) qrButton.style.display = revocationMode === 'devices' ? '' : 'none';
      if (ownerSetup) ownerSetup.style.display = 'none';
    } else if (currentUser.uid === OWNER_UID) {
      if (notice) notice.style.display = 'none';
      if (grid) grid.style.display = 'none';
      if (status) status.textContent = 'Este es el dispositivo propietario. Abre la configuración para crear la banda o administrar sus integrantes.';
      if (requestButton) requestButton.style.display = 'none';
      if (qrButton) qrButton.style.display = 'none';
      if (ownerSetup) ownerSetup.style.display = '';
    } else {
      if (notice) notice.style.display = 'none';
      if (grid) grid.style.display = '';
      if (ownerSetup) ownerSetup.style.display = 'none';
      if (qrButton) qrButton.style.display = '';
      if (incomingMemberInviteToken && incomingMemberInvite) {
        if (grid) grid.style.display = 'none';
        if (status) status.textContent = 'Te invitaron como ' + roleName(incomingMemberInvite.role) + '. Solicita acceso; el repertorio se desbloqueará solamente cuando el propietario te apruebe.';
        if (requestButton) { requestButton.style.display = ''; requestButton.disabled = !!window.fcJoinRequestPending; requestButton.textContent = window.fcJoinRequestPending ? 'Solicitud pendiente' : 'Solicitar incorporación como ' + roleName(incomingMemberInvite.role); }
      } else if (window.fcJoinRequestPending) {
        if (status) status.textContent = 'Tu solicitud está pendiente de aprobación. El catálogo y los eventos permanecerán bloqueados hasta que el propietario te autorice.';
        if (requestButton) { requestButton.style.display = ''; requestButton.disabled = true; requestButton.textContent = 'Solicitud pendiente'; }
      } else if (selectedProfileRole && selectedProfileRole !== 'accordionist') {
        if (status) status.textContent = 'Seleccionaste ' + roleName(selectedProfileRole) + '. Pulsa Solicitar incorporación. No necesitas QR ni enlace especial; el propietario aprobará el acceso antes de mostrarte canciones y eventos.';
        if (requestButton) { requestButton.style.display = canRequestMembership() ? '' : 'none'; requestButton.disabled = !!window.fcJoinRequestPending; requestButton.textContent = window.fcJoinRequestPending ? 'Solicitud pendiente' : 'Solicitar incorporación'; }
      } else {
        if (status) status.textContent = genericJoinLink
          ? 'Invitación general reconocida. Selecciona tu función y solicita incorporación; el propietario debe aprobarte.'
          : 'Selecciona tu función y pulsa Solicitar incorporación. No necesitas escanear un QR para entrar como integrante nuevo. El acceso se activa únicamente después de la aprobación del propietario.';
        if (requestButton) { requestButton.style.display = 'none'; requestButton.textContent = 'Solicitar incorporación'; }
      }
    }
    if (grid && selectedProfileRole && !incomingMemberInviteToken) {
      var selectedButton = grid.querySelector('[data-role="' + selectedProfileRole + '"]');
      if (selectedButton) selectedButton.classList.add('selected');
    }
    firstProfileGateShown = true;
    gate.style.display = 'grid';
    if (document.body) document.body.classList.remove('fc-session-pending');
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
      if (!registration) registration = await navigator.serviceWorker.register('./sw.js?v=27');
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
      panel.innerHTML = `
        <div class="fc-panel-head">
          <div><span class="fc-eyebrow">FRECUENCIA CERO</span><strong>Mi banda y acceso</strong><p class="note">Administra tu perfil, invita integrantes y añade dispositivos sin confundir los dos procesos.</p></div>
          <span class="fc-panel-icon">☁️</span>
        </div>
        <div id="fcSyncStatus" class="fc-status neutral">Conectando con Firebase…</div>

        <section class="fc-access-card">
          <div class="fc-access-card-head">
            <div><span class="fc-eyebrow">TU SESIÓN</span><strong>Perfil en Frecuencia Cero</strong></div>
            <span id="fcProfileIdentityBadge" class="fc-access-badge is-pending">Comprobando acceso…</span>
          </div>
          <p id="fcBandSummary" class="fc-current-profile">Comprobando tu perfil…</p>
          <div id="fcProfileEditor" class="fc-profile-editor" style="display:none">
            <label class="fc-field-label" for="fcProfileSelect">¿Qué función utilizas?</label>
            <select id="fcProfileSelect"><option value="">Seleccionar perfil…</option><option value="voice1">Voz 1 · Director</option><option value="voice2">Voz 2 · Cantante</option><option value="bass">Bajista</option><option value="drummer">Baterista</option><option value="keyboardist">Tecladista</option><option value="accordionist">Acordeonista · Propietario</option></select>
            <button id="fcProfileSave" class="p" type="button">Solicitar incorporación</button>
          </div>
          <div id="fcOwnerCreateCard" class="fc-owner-create" style="display:none">
            <p class="fc-inline-hint">Este es el dispositivo propietario. Crea la banda una sola vez; después podrás invitar integrantes y vincular otros dispositivos.</p>
            <label class="fc-field-label" for="fcBandName">Nombre de la banda</label>
            <input id="fcBandName" placeholder="Frecuencia Cero" value="Frecuencia Cero">
            <button id="fcCreateBand" class="p" type="button" style="display:none">＋ Crear banda</button>
          </div>
          <div id="fcOwnerMismatch" class="fc-pair-box" style="display:none"><strong>Este dispositivo todavía no está reconocido como propietario.</strong><p class="note">No selecciones Acordeonista en otro UID. Usa un enlace de dispositivo generado desde la sesión propietaria.</p><code id="fcCurrentOwnerUid"></code><button type="button" id="fcCopyCurrentOwnerUid">Copiar ID técnico</button></div>
          <details class="fc-tech-details"><summary>Información técnica del dispositivo</summary><div class="fc-tech-uid"><code id="fcDeviceUid">Preparando identidad…</code><button id="fcCopyUid" type="button" style="display:none">Copiar ID</button></div></details>
        </section>

        <section id="fcPairActions" class="fc-access-card fc-device-access" style="display:none">
          <div class="fc-access-card-head"><div><span class="fc-eyebrow">PARA TU PERFIL ACTUAL</span><strong>Añadir otro dispositivo</strong></div><span class="fc-access-icon">📱</span></div>
          <p id="fcPairHelp" class="fc-inline-hint">Genera un enlace o QR para añadir una laptop, tablet o teléfono a este mismo perfil. No crea otro integrante y no necesita aprobación.</p>
          <button id="fcLinkDevice" class="p fc-secondary-action" type="button" style="display:none">▦ Generar QR o enlace para este perfil</button>
          <p class="fc-inline-hint">Importante: el enlace se genera desde el perfil que quieres duplicar. Si quieres añadir un dispositivo a Voz 2, primero abre una sesión autorizada de Voz 2.</p>
          <button id="fcScanDeviceLink" type="button" style="display:none">Escanear QR</button>
        </section>
        <div id="fcPairQrBox" class="fc-pair-box" style="display:none"></div>
        <div id="fcPairScannerWrap" class="fc-pair-box" style="display:none"><div id="fcPairScanner"></div><p id="fcPairScannerStatus" class="note">Preparando cámara…</p><button type="button" id="fcPairScannerClose">Cerrar cámara</button></div>

        <section id="fcMemberInvitePanel" class="fc-access-card fc-owner-section" style="display:none">
          <div class="fc-access-card-head"><div><span class="fc-eyebrow">SOLO PROPIETARIO</span><strong>Invitar a un integrante nuevo</strong></div><span class="fc-access-icon">✉️</span></div>
          <p class="fc-inline-hint">Esto crea una solicitud de integrante nuevo. La persona elige su función (o recibe una preseleccionada) y tú apruebas su acceso. No uses el QR de tu perfil para invitar a otro músico.</p>
          <label class="fc-field-label" for="fcMemberInviteRole">Tipo de invitación</label>
          <select id="fcMemberInviteRole"><option value="choose">Enlace general · la persona elige su función</option><option value="voice1">Voz 1 · Director</option><option value="voice2">Voz 2 · Cantante</option><option value="bass">Bajista</option><option value="drummer">Baterista</option><option value="keyboardist">Tecladista</option></select>
          <button id="fcCreateMemberInvite" class="p" type="button">Crear enlace de invitación</button>
          <div id="fcMemberInviteOutput" class="fc-invite-output" style="display:none"><label class="fc-field-label" for="fcMemberInviteUrl">Enlace listo para compartir</label><input id="fcMemberInviteUrl" type="text" readonly aria-label="Enlace de invitación"><div class="fc-invite-actions"><button id="fcCopyMemberInvite" type="button" style="display:none">Copiar enlace</button><button id="fcShareMemberInvite" type="button" style="display:none">Compartir…</button></div></div>
          <p class="fc-inline-hint">Para iPhone: la persona debe abrir Frecuencia Cero desde el icono de inicio y usar ahí su invitación. Safari y la app instalada pueden tener IDs distintos. Si abrió el enlace en Safari, puede copiarlo y pegarlo en la opción «Ya tengo un enlace» de la app instalada.</p>
          <p id="fcMemberInviteResult" class="note" aria-live="polite"></p>
        </section>

        <section id="fcJoinRequests" class="fc-access-card" style="display:none"><div class="fc-access-card-head"><div><span class="fc-eyebrow">PENDIENTES DE APROBACIÓN</span><strong>Solicitudes de integrantes</strong></div><span class="fc-access-icon">📝</span></div><div id="fcJoinRequestsList"></div></section>
        <section id="fcMemberAdmin" class="fc-access-card" style="display:none"><div class="fc-access-card-head"><div><span class="fc-eyebrow">ADMINISTRACIÓN</span><strong>Integrantes y funciones</strong></div><span id="fcOnlineCount" class="fc-inline-hint"></span></div><p class="fc-inline-hint">El propietario administra perfiles y accesos. Cada integrante puede tener varios dispositivos vinculados a su propia función.</p><div id="fcMembers"></div></section>
        <section id="fcMyDevicesBox" class="fc-access-card" style="display:none"><div class="fc-access-card-head"><div><span class="fc-eyebrow">TUS EQUIPOS</span><strong>Dispositivos vinculados a tu perfil</strong></div><span class="fc-access-icon">💻</span></div><p class="fc-inline-hint">Puedes revocar una laptop, tablet o teléfono sin quitar el acceso de los demás dispositivos de tu perfil.</p><div id="fcMyDevices"></div></section>
        <section class="fc-access-card"><label class="fc-follow-row"><input type="checkbox" id="fcFollow" checked> Seguir automáticamente la canción que elija Voz 1</label></section>`;
      var insertion = $('mi'); menu.insertBefore(panel, insertion);
    }
    if (!$('fcFirstProfileGate')) {
      var gate = document.createElement('div'); gate.id = 'fcFirstProfileGate'; gate.className = 'fc-profile-gate'; gate.style.display = 'none';
      gate.innerHTML = `
        <div class="fc-profile-card">
          <div class="fc-profile-brand">♫</div>
          <span class="fc-eyebrow">ACCESO A LA BANDA</span>
          <strong class="fc-profile-title">Frecuencia Cero</strong>
          <p id="fcGateRevokedNotice" class="fc-gate-revoked" style="display:none">Tu acceso necesita verificarse.</p>
          <p id="fcGateIntro" class="note">¿Qué función vas a utilizar en este dispositivo? Seleccionar un perfil no abre el repertorio; primero debes solicitar incorporación y esperar la aprobación del propietario.</p>
          <div class="fc-profile-grid">
            <button type="button" data-role="voice1"><b>🎤 Voz 1</b><small>Director musical</small></button>
            <button type="button" data-role="voice2"><b>🎤 Voz 2</b><small>Cantante</small></button>
            <button type="button" data-role="bass"><b>🎸 Bajista</b><small>Bajo</small></button>
            <button type="button" data-role="drummer"><b>🥁 Baterista</b><small>Seguimiento</small></button>
            <button type="button" data-role="keyboardist"><b>🎹 Tecladista</b><small>Teclado / guitarra</small></button>
            <button type="button" data-role="accordionist"><b>🪗 Acordeonista</b><small>Propietario técnico</small></button>
          </div>
          <p id="fcGateStatus" class="note fc-profile-foot" aria-live="polite">Selecciona tu función para continuar.</p>
          <button type="button" id="fcGateRequestJoin" class="p fc-gate-primary" style="display:none">Solicitar incorporación</button>
          <button type="button" id="fcGateOwnerSetup" class="p fc-gate-primary" style="display:none">Abrir configuración del propietario</button>
          <details class="fc-gate-alt">
            <summary>Ya tengo una invitación o quiero añadir este dispositivo a mi perfil</summary>
            <p class="fc-inline-hint">Pega aquí un enlace de invitación para un integrante nuevo o un enlace de dispositivo generado desde otro equipo donde ya tienes acceso. En iPhone, hazlo desde la app abierta en la pantalla de inicio para autorizar su propio ID.</p>
            <input id="fcGateAccessLinkInput" type="url" placeholder="Pega aquí el enlace completo" autocomplete="url">
            <button type="button" id="fcGateAccessLinkButton" class="p">Continuar con enlace</button>
            <p id="fcGateAccessLinkStatus" class="fc-inline-hint" aria-live="polite"></p>
            <button type="button" id="fcProfileGateQr">Escanear QR de un perfil ya autorizado</button>
          </details>
          <details class="fc-gate-tech"><summary>Información técnica de este dispositivo</summary><div class="fc-tech-uid"><code id="fcGateUid">Preparando…</code><button type="button" id="fcGateCopyUid">Copiar ID</button></div></details>
        </div>`;
      document.body.appendChild(gate);
      if (accessRevoked || accessVerificationPending) {
        gate.style.display = 'grid'; firstProfileGateShown = true;
        var initialNotice = $('fcGateRevokedNotice'); if (initialNotice) { initialNotice.style.display = ''; initialNotice.textContent = accessVerificationPending ? 'Verificando que este dispositivo siga autorizado. El catálogo permanecerá bloqueado hasta confirmar el acceso.' : (revocationMode === 'devices' ? 'Este dispositivo fue desvinculado. Escanea un nuevo QR de un dispositivo autorizado para volver a conectarlo.' : 'Tu acceso a la banda fue retirado. Selecciona tu función y solicita nuevamente la incorporación.'); }
        var initialGrid = gate.querySelector('.fc-profile-grid'); if (initialGrid) initialGrid.style.display = accessVerificationPending || revocationMode === 'devices' ? 'none' : ''; 
        var initialRequest = $('fcGateRequestJoin'); if (initialRequest) initialRequest.style.display = accessRevoked && revocationMode !== 'devices' ? '' : 'none';
        var initialQr = $('fcProfileGateQr'); if (initialQr) initialQr.style.display = accessRevoked && revocationMode === 'devices' ? '' : 'none';
      }
      Array.prototype.forEach.call(gate.querySelectorAll('[data-role]'), function (button) {
        button.onclick = function () {
          var role = button.dataset.role;
          selectedProfileRole = role; localStorage.setItem(PROFILE_KEY, role);
          Array.prototype.forEach.call(gate.querySelectorAll('[data-role]'), function (other) { other.classList.toggle('selected', other === button); });
          var notice = $('fcGateStatus');
          var requestButton = $('fcGateRequestJoin');
          var ownerButton = $('fcGateOwnerSetup');
          if (role === 'accordionist' && (!currentUser || currentUser.uid !== OWNER_UID)) {
            if (notice) notice.textContent = 'Acordeonista está reservado al propietario técnico. Selecciona otra función para solicitar acceso.';
            if (requestButton) requestButton.style.display = 'none';
            if (ownerButton) ownerButton.style.display = 'none';
            return;
          }
          if (role === 'accordionist' && currentUser && currentUser.uid === OWNER_UID) {
            if (notice) notice.textContent = 'Este es el perfil del propietario. Abre la configuración para crear o administrar la banda.';
            if (requestButton) requestButton.style.display = 'none';
            if (ownerButton) ownerButton.style.display = '';
            return;
          }
          if (notice) notice.textContent = 'Perfil seleccionado: ' + roleName(role) + '. Puedes solicitar incorporación sin QR ni enlace especial. El propietario aprobará el acceso antes de mostrarte el repertorio.';
          if (requestButton) { requestButton.style.display = canRequestMembership() ? '' : 'none'; requestButton.disabled = !!window.fcJoinRequestPending; requestButton.textContent = window.fcJoinRequestPending ? 'Solicitud pendiente' : 'Solicitar incorporación'; }
          if (ownerButton) ownerButton.style.display = 'none';
          updateSyncButtons();
        };
      });
      var gateOwnerSetup = $('fcGateOwnerSetup'); if (gateOwnerSetup) gateOwnerSetup.onclick = function () { hideFirstProfileGate(); if (typeof window.show === 'function') window.show('vm'); };
      var gateQr = $('fcProfileGateQr'); if (gateQr) gateQr.onclick = function () { hideFirstProfileGate(); if (typeof window.show === 'function') window.show('vm'); setTimeout(function () { startPairScanner(); }, 250); };
      var gateAccessLink = $('fcGateAccessLinkButton'); if (gateAccessLink) gateAccessLink.onclick = continueWithPastedAccessLink;
      var gateRequest = $('fcGateRequestJoin'); if (gateRequest) gateRequest.onclick = function () { if (!selectedProfileRole) { var status = $('fcGateStatus'); if (status) status.textContent = 'Primero selecciona tu función.'; return; } requestJoin(); };
      var gateCopy = $('fcGateCopyUid'); if (gateCopy) gateCopy.onclick = function () { var uid = currentUser && currentUser.uid || ''; if (!uid) return; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(uid).then(function () { alert('ID copiado: ' + uid); }).catch(function () { alert('ID de este teléfono: ' + uid); }); else alert('ID de este teléfono: ' + uid); };
    }
    if (!$('fcMiniPlayer')) {
      var mini = document.createElement('aside'); mini.id = 'fcMiniPlayer'; mini.className = 'fc-mini-player'; mini.style.display = 'none';
      mini.innerHTML = '<div class="fc-mini-top"><span class="fc-mini-live-dot"></span><span id="fcMiniMode">EN VIVO</span><span class="fc-mini-event" id="fcMiniEvent"></span><span class="fc-mini-state" id="fcMiniState"></span></div><div class="fc-mini-main"><div class="fc-mini-copy"><strong id="fcMiniSong">—</strong><span id="fcMiniLine">Esperando canción del director…</span></div><button type="button" id="fcMiniReturn">Ver en vivo</button></div><div class="fc-mini-next"><span>SIGUIENTE</span><strong id="fcMiniNextSong">Fin del repertorio</strong><small id="fcMiniNextMeta"></small></div><div class="fc-mini-controls"><button type="button" id="fcMiniPrev" title="Canción anterior">⏮</button><button type="button" id="fcMiniPause" title="Pausar o reanudar">Ⅱ Pausar</button><button type="button" id="fcMiniNext" class="p" title="Siguiente canción">⏭ Siguiente</button><button type="button" id="fcMiniQueue" title="Abrir repertorio">☷ Lista</button></div><div class="fc-mini-end-row"><button type="button" id="fcMiniEnd" class="fc-mini-end" title="Terminar el evento para todos">■ Terminar evento</button></div><div class="fc-mini-progress-track"><span id="fcMiniProgress"></span></div><span class="fc-mini-progress-text" id="fcMiniProgressText"></span>';
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
      var voicePanel = document.createElement('section'); voicePanel.id = 'fcVoiceFollowPanel'; voicePanel.className = 'fc-voice-panel'; voicePanel.style.display = 'none';
      voicePanel.innerHTML = '<div class="fc-voice-panel-head"><div><strong>Seguimiento automático por voz</strong><small id="fcVoiceMicState">MICRÓFONO INACTIVO</small></div><span class="fc-voice-indicator" aria-hidden="true">🎤</span></div><p id="fcVoiceStatus" class="fc-voice-status" aria-live="polite">Listo. Inicia el micrófono cuando comience la canción.</p><div class="fc-voice-actions"><button type="button" id="fcVoiceStart" class="p">🎤 Iniciar seguimiento por voz</button><button type="button" id="fcVoiceStop" disabled>Detener</button></div><div class="fc-voice-manual"><button type="button" id="fcVoicePrevLine">↑ Línea anterior</button><button type="button" id="fcVoiceNextLine">↓ Siguiente línea</button></div><p id="fcVoiceSupport" class="fc-inline-hint">El navegador solicitará permiso de micrófono.</p>';
      reader.insertBefore(voicePanel, $('rd'));
    }
  }

  function bindUi() {
    if ($('fcConnect')) $('fcConnect').onclick = connectFirebase;
    if ($('fcSignIn')) $('fcSignIn').onclick = signIn;
    if ($('fcSignOut')) $('fcSignOut').onclick = signOut;
    if ($('fcCreateBand')) $('fcCreateBand').onclick = handleOwnerBandAction;
    if ($('fcRequestJoin')) $('fcRequestJoin').onclick = requestJoin;
    if ($('fcCreateMemberInvite')) $('fcCreateMemberInvite').onclick = createMemberInviteLink;
    if ($('fcShareMemberInvite')) $('fcShareMemberInvite').onclick = shareMemberInviteLink;
    if ($('fcGateAccessLinkButton')) $('fcGateAccessLinkButton').onclick = continueWithPastedAccessLink;
    if ($('fcLinkDevice')) $('fcLinkDevice').onclick = handleGeneratePairQr;
    if ($('fcCheckUpdates')) $('fcCheckUpdates').onclick = checkForAppUpdates;
    if ($('fcScanDeviceLink')) $('fcScanDeviceLink').onclick = startPairScanner;
    if ($('fcPairScannerClose')) $('fcPairScannerClose').onclick = stopPairScanner;
    if ($('fcProfileSave')) $('fcProfileSave').onclick = function () {
      var role = $('fcProfileSelect').value;
      if (!role) { alert('Selecciona una función.'); return; }
      if (isConnected()) { alert('Tu función ya fue asignada por el propietario técnico. Para cambiarla, solicita que actualice tu perfil.'); return; }
      selectedProfileRole = role; localStorage.setItem(PROFILE_KEY, role);
      maybeShowFirstProfileGate();
      var gateStatus = $('fcGateStatus'); if (gateStatus) gateStatus.textContent = 'Perfil seleccionado: ' + roleName(role) + '. Solicita acceso y espera la aprobación del propietario.';
      var gateRequest = $('fcGateRequestJoin'); if (gateRequest) { gateRequest.style.display = (role !== 'accordionist' && role !== 'pending' && currentUser && !bandId) ? '' : 'none'; gateRequest.disabled = !!window.fcJoinRequestPending; gateRequest.textContent = window.fcJoinRequestPending ? 'Solicitud pendiente' : 'Solicitar incorporación'; }
      updateSyncButtons();
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
    if ($('fcMiniPrev')) $('fcMiniPrev').onclick = function () { navigateLiveSong(-1); };
    if ($('fcMiniNext')) $('fcMiniNext').onclick = function () { navigateLiveSong(1); };
    if ($('fcMiniPause')) $('fcMiniPause').onclick = toggleLivePause;
    if ($('fcMiniQueue')) $('fcMiniQueue').onclick = function () { if (liveState && liveState.eventId) window.openEvent(liveState.eventId); };
    if ($('fcMiniEnd')) $('fcMiniEnd').onclick = endLiveEvent;
    if ($('fcVoiceStart')) $('fcVoiceStart').onclick = startSpeechFollow;
    if ($('fcVoiceStop')) $('fcVoiceStop').onclick = function () { stopSpeechFollow('Micrófono apagado. El avance manual sigue disponible.', false); };
    if ($('fcVoicePrevLine')) $('fcVoicePrevLine').onclick = function () { advanceDirectorLine(-1); };
    if ($('fcVoiceNextLine')) $('fcVoiceNextLine').onclick = function () { advanceDirectorLine(1); };
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
      '.fc-voice-panel{margin:0 10px 8px;padding:12px;border:1px solid color-mix(in srgb,var(--acc) 30%,var(--line));border-radius:14px;background:color-mix(in srgb,var(--acc) 5%,var(--card));display:flex;flex-direction:column;gap:8px}.fc-voice-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.fc-voice-panel-head>div{display:flex;flex-direction:column;gap:3px}.fc-voice-panel-head strong{font-size:13px}.fc-voice-panel-head small{font-size:9px;letter-spacing:.1em;font-weight:900;color:var(--mut)}.fc-voice-indicator{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:var(--bg);font-size:18px}.fc-voice-panel.is-listening .fc-voice-indicator{background:rgba(22,163,106,.12);box-shadow:0 0 0 4px rgba(22,163,106,.06)}.fc-voice-status{margin:0;padding:8px 10px;border-radius:9px;background:var(--bg);font-size:11px;line-height:1.4;color:var(--mut)}.fc-voice-status[data-kind=success]{color:#168451}.fc-voice-status[data-kind=error]{color:#bd3e35}.fc-voice-status[data-kind=warning]{color:#9a6a00}.fc-voice-actions,.fc-voice-manual{display:grid;grid-template-columns:1fr 1fr;gap:7px}.fc-voice-actions button,.fc-voice-manual button{min-height:38px;padding:7px 9px;font-size:11px;font-weight:850}.fc-voice-manual button{background:var(--bg)}.fc-voice-panel .fc-inline-hint{font-size:10px;margin:0}.fc-live-queue-row{display:flex;align-items:center;gap:7px;min-width:0}.fc-live-queue-handle{width:30px;min-width:30px;min-height:38px;padding:0;border:0!important;background:transparent!important;box-shadow:none!important;color:var(--mut);font-size:20px;font-weight:900;letter-spacing:-3px;touch-action:none;user-select:none;-webkit-user-select:none;cursor:grab}.fc-live-queue-handle:active,.fc-live-queue-handle.is-dragging{color:var(--acc);cursor:grabbing}.fc-live-queue-row.is-drag-source{opacity:.45}.fc-live-queue-row.is-drop-target{outline:2px dashed var(--acc);background:color-mix(in srgb,var(--acc) 7%,var(--card))}.fc-queue-badge{font-size:9px;font-weight:950;letter-spacing:.05em;border-radius:7px;padding:5px 6px;white-space:nowrap}.fc-queue-badge.current{background:rgba(22,163,106,.12);color:#168451}.fc-queue-badge.next{background:color-mix(in srgb,var(--acc) 11%,var(--card));color:var(--acc)}.fc-queue-remove{min-width:30px!important;width:30px;min-height:32px!important;padding:3px!important;border-radius:8px!important;color:var(--mut)}.fc-queue-remove:disabled{opacity:.35}.fc-queue-tools{margin:8px 12px 6px;padding:11px;border:1px solid var(--line);border-radius:13px;background:var(--card)}.fc-queue-tools-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.fc-queue-tools-head>div{display:flex;flex-direction:column;gap:3px;min-width:0}.fc-queue-tools-head strong{font-size:13px}.fc-queue-tools-head small{font-size:10px;color:var(--mut)}.fc-queue-tools-head button{min-height:35px;padding:6px 10px;font-size:11px}.fc-queue-add-panel{display:flex;flex-direction:column;gap:8px;padding-top:10px}.fc-queue-add-panel[hidden]{display:none}.fc-queue-add-panel input{min-height:38px;font-size:12px}.fc-queue-search-results{display:flex;flex-direction:column;gap:5px;max-height:220px;overflow:auto}.fc-queue-search-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);font-size:11px}.fc-queue-search-row span{flex:1;min-width:0;line-height:1.35}.fc-queue-search-row button{min-height:32px;padding:5px 9px;font-size:10px}' +
      '.fc-mini-next{display:flex;align-items:center;gap:8px;min-width:0;padding:5px 7px;border-radius:8px;background:var(--bg)}.fc-mini-next>span{font-size:8px;letter-spacing:.09em;font-weight:950;color:var(--mut);white-space:nowrap}.fc-mini-next strong{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}.fc-mini-next small{font-size:9px;color:var(--mut);white-space:nowrap}.fc-mini-controls{display:flex;align-items:center;justify-content:center;gap:7px}.fc-mini-controls button{min-height:32px;padding:5px 9px;font-size:10px;font-weight:850;border-radius:9px}.fc-mini-controls button:disabled{opacity:.35}.fc-mini-end-row{display:flex;justify-content:flex-end}.fc-mini-end{min-height:30px!important;padding:4px 9px!important;border-radius:8px!important;border:1px solid rgba(190,65,50,.35)!important;background:rgba(190,65,50,.08)!important;color:#bd473c!important;font-size:10px!important;font-weight:900!important}.fc-mini-end:active{background:rgba(190,65,50,.16)!important}.fc-mini-end:disabled{opacity:.55}.fc-mini-player{gap:6px}.fc-mini-player .fc-mini-main button{min-height:32px}.fc-live-queue-row .playlist-open{flex:1;min-width:0}.fc-live-queue-row .playlist-open strong,.fc-live-queue-row .playlist-open small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fc-live-queue-row .fc-play-song{flex:0 0 auto;min-width:62px}' +
      '.fc-sync-panel{border:1px solid var(--line);border-radius:16px;padding:13px;background:var(--card);display:flex;flex-direction:column;gap:9px}' +
      '.fc-drag-handle{width:32px;min-width:32px;height:36px;min-height:36px;padding:0;border:0!important;background:transparent!important;box-shadow:none!important;color:var(--mut);font-size:22px;font-weight:900;letter-spacing:-3px;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}.fc-drag-handle:active,.fc-drag-handle.is-dragging{cursor:grabbing;color:var(--acc);background:color-mix(in srgb,var(--acc) 10%,transparent)!important}.fc-event-selected-row{transition:transform .12s ease,border-color .12s ease}.fc-event-selected-row.is-drop-target{border:2px dashed var(--acc);background:color-mix(in srgb,var(--acc) 8%,var(--card))}.fc-event-selected-row.is-drag-source{opacity:.45}.event-selected-row .fc-event-song-head{min-width:0}.event-selected-row .fc-event-song-head .event-selected-title{min-width:0}.event-selected-row .fc-event-song-head>button:not(.fc-drag-handle){min-width:36px}' +
      '.fc-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.fc-panel-head strong{font-size:17px}.fc-panel-icon{font-size:25px}' +
      '.fc-status{padding:9px 11px;border-radius:10px;font-size:13px;font-weight:700;background:var(--bg)}.fc-status.success{color:#16764b;background:rgba(22,139,88,.10)}.fc-status.warning{color:#946200;background:rgba(220,160,30,.13)}.fc-status.error{color:#b3261e;background:rgba(179,38,30,.10)}' +
      '.fc-field-label{font-size:12px;color:var(--mut);font-weight:800;margin-top:3px}.fc-auth-row,.fc-invite-row{display:flex;gap:7px}.fc-auth-row button,.fc-invite-row button{flex:1;min-width:0}.fc-band-box{border-top:1px solid var(--line);padding-top:10px;display:flex;flex-direction:column;gap:8px}.fc-member-admin{border-top:1px solid var(--line);padding-top:10px}.fc-member-head{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px}.fc-member-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line)}.fc-member-info{flex:1;min-width:0}.fc-member-info strong,.fc-member-info small{display:block;overflow-wrap:anywhere}.fc-member-info small{font-size:11px;color:var(--mut)}.fc-member-row select{width:47%;min-width:128px;padding:7px;font-size:12px}.fc-sync-panel code{font-size:10px;overflow-wrap:anywhere}.fc-sync-panel #fcProfileSelect{width:100%}.fc-sync-panel #fcCopyUid{font-size:11px;min-height:30px;padding:4px 8px}.fc-follow-row{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700}.fc-follow-row input{width:18px;min-height:18px;height:18px}.fc-live-banner{width:calc(100% - 24px);margin:0 12px 8px;text-align:left;background:rgba(22,139,88,.12);border-color:rgba(22,139,88,.35);color:var(--fg);font-size:13px;font-weight:850;display:flex;align-items:center;gap:8px}.fc-live-banner span:nth-child(2){flex:1}.fc-live-dot{width:9px;height:9px;border-radius:100%;background:#16a36a;display:inline-block}.fc-role-bar{padding:8px 12px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--bg)}.fc-role-line{display:flex;align-items:center;justify-content:space-between;gap:7px;width:100%;font-size:12px}.fc-role-line button{font-size:12px;min-height:36px;padding:6px 9px}.fc-role-bar select{min-height:38px;font-size:13px}.fc-next-only{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px 18px;gap:12px;overflow:auto}.fc-next-chip{padding:6px 12px;border-radius:20px;background:var(--acc);color:var(--accfg);font-weight:900;font-size:12px}.fc-next-caption{font-size:11px;color:var(--mut);font-weight:900;letter-spacing:.12em}.fc-next-current{font-size:clamp(25px,6vw,38px);font-weight:900;line-height:1.1}.fc-next-title{font-size:clamp(28px,8vw,48px);font-weight:950;color:var(--acc);line-height:1.08}.fc-next-key{font-size:14px;color:var(--mut);font-weight:800}.fc-event-selected-row{display:block}.fc-event-song-head{display:flex;align-items:center;gap:7px}.fc-assignment-controls{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:7px 3px 2px 29px}.fc-assignment-controls label{font-size:10px;color:var(--mut);font-weight:800}.fc-assignment-controls select{display:block;min-height:35px;font-size:12px;padding:5px;margin-top:3px}.fc-live-song{background:rgba(22,139,88,.09);border-radius:10px;padding-left:8px;padding-right:8px}.fc-play-song{font-size:12px;padding:7px 9px;min-height:36px}' +
      '.fc-member-device{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 8px 8px 28px;font-size:11px;color:var(--mut)}.fc-member-device button{min-height:30px;padding:4px 8px;font-size:11px}.fc-pair-actions{border:1px solid var(--line);border-radius:13px;padding:12px;background:var(--bg);display:flex;flex-direction:column;gap:9px}.fc-pair-actions p{margin:0}.fc-pair-actions button{width:100%;min-height:44px}.fc-pair-box{border:1px solid var(--line);border-radius:13px;padding:12px;background:var(--bg);display:flex;flex-direction:column;gap:9px}.fc-pair-title{font-size:16px;font-weight:900}.fc-pair-qr{display:flex;justify-content:center;align-items:center;background:#fff;border-radius:10px;padding:12px;min-height:230px}.fc-pair-qr img{max-width:100%;height:auto}.fc-pair-url{font-size:10px;color:var(--mut);overflow-wrap:anywhere;user-select:text}.fc-pair-box button{width:100%}' +
      '.fc-live-row-current{outline:1px solid color-mix(in srgb,var(--acc) 25%,transparent);outline-offset:3px;border-radius:7px}.fc-profile-gate{position:fixed;inset:0;z-index:2000;display:grid;place-items:center;padding:18px;background:var(--bg);backdrop-filter:none}.fc-profile-card{width:min(100%,480px);max-height:90dvh;overflow:auto;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:22px;padding:20px;box-shadow:0 18px 60px rgba(0,0,0,.3);display:flex;flex-direction:column;gap:12px}.fc-profile-brand{width:48px;height:48px;border-radius:15px;display:grid;place-items:center;background:var(--acc);color:var(--accfg);font-size:28px}.fc-profile-title{font-size:24px}.fc-profile-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.fc-profile-grid button{min-height:76px;text-align:left;display:flex;flex-direction:column;gap:4px;padding:11px}.fc-profile-grid button b{font-size:14px}.fc-profile-grid button small{color:var(--mut);font-size:11px}.fc-profile-foot{margin:0}.fc-request-row{display:grid;grid-template-columns:minmax(0,1fr);gap:9px;align-items:stretch}.fc-request-info{min-width:0;width:100%}.fc-request-info strong{white-space:normal;overflow-wrap:normal;word-break:normal}.fc-request-info small{white-space:normal;overflow-wrap:anywhere;word-break:normal;line-height:1.35}.fc-request-actions{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:7px;align-items:center;min-width:0}.fc-request-actions select{width:100%;min-width:0;max-width:100%;font-size:12px;padding:7px}.fc-request-actions button{min-width:0;white-space:nowrap}.fc-request-reject{padding-left:10px;padding-right:10px}.fc-admin-member-row{min-width:0}.fc-admin-member-row .fc-member-info{min-width:0}.fc-admin-member-row .fc-member-info small{overflow-wrap:normal;word-break:normal;line-height:1.35}.fc-section-control{display:grid;grid-template-columns:minmax(0,1fr) minmax(145px, .9fr);align-items:center;gap:9px;padding:8px 4px 3px 29px}.fc-section-key{font-size:11px;color:var(--mut);font-weight:800}.fc-section-control label{display:flex;align-items:center;gap:7px;justify-content:flex-end;font-size:11px;color:var(--mut);font-weight:800}.fc-section-control select{width:100%;min-width:0;min-height:36px;font-size:12px;padding:5px}.fc-category-filters{display:flex;gap:7px;overflow-x:auto;padding:9px 12px 4px;scrollbar-width:none}.fc-category-filters::-webkit-scrollbar{display:none}.fc-category-filters button{flex:1 0 auto;min-height:35px;padding:6px 12px;border-radius:11px;font-size:12px;font-weight:850;white-space:nowrap;background:var(--bg);color:var(--mut);box-shadow:none}.fc-category-filters button.active{background:var(--acc);color:var(--accfg)}.fc-mini-player{position:fixed;left:10px;right:10px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:1100;display:flex;flex-direction:column;gap:5px;padding:9px 11px 7px;border:1px solid color-mix(in srgb,var(--acc) 38%,var(--line));border-radius:14px;background:color-mix(in srgb,var(--card) 94%,transparent);color:var(--fg);box-shadow:0 8px 26px rgba(0,0,0,.18);backdrop-filter:blur(12px)}body.fc-reader-open .fc-mini-player{bottom:calc(98px + env(safe-area-inset-bottom))}.fc-mini-top{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:900;letter-spacing:.06em;color:var(--mut);min-width:0}.fc-mini-live-dot{width:8px;height:8px;border-radius:50%;background:#18a66a;flex:0 0 auto}.fc-mini-player.is-paused .fc-mini-live-dot{background:#d49b2e}.fc-mini-event{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-weight:700;letter-spacing:0}.fc-mini-state{white-space:nowrap}.fc-mini-main{display:flex;align-items:center;gap:9px;min-width:0}.fc-mini-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.fc-mini-copy strong{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fc-mini-copy span{font-size:11px;color:var(--mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fc-mini-main button{min-height:35px;padding:6px 9px;font-size:11px;font-weight:850;white-space:nowrap}.fc-mini-player.is-free{border-color:color-mix(in srgb,#d49b2e 55%,var(--line))}.fc-mini-progress-track{height:3px;background:var(--line);border-radius:99px;overflow:hidden}.fc-mini-progress-track span{height:100%;display:block;width:0;background:var(--acc);transition:width .2s}.fc-mini-progress-text{position:absolute;right:11px;top:8px;font-size:9px;color:var(--mut);display:none}.fc-sync-panel .fc-request-row{display:grid;grid-template-columns:minmax(0,1fr);}.fc-sync-panel .fc-request-actions{grid-template-columns:minmax(0,1fr) auto auto}#list{padding-bottom:100px}.event-list{padding-bottom:100px}@media(max-width:480px){.fc-sync-panel .fc-request-actions{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.fc-sync-panel .fc-request-actions select{grid-column:1/-1}.fc-sync-panel .fc-request-actions button{width:100%;min-height:39px}.fc-sync-panel .fc-admin-member-row{display:grid;grid-template-columns:minmax(0,1fr);gap:7px}.fc-sync-panel .fc-admin-member-row select{width:100%;min-width:0;max-width:100%}.fc-sync-panel .fc-admin-member-row button{width:100%}.fc-section-control{grid-template-columns:1fr;gap:5px;padding-left:29px}.fc-section-control label{justify-content:space-between}.fc-section-control select{max-width:100%}}' +
      '.fc-pair-invite-overlay{position:fixed;inset:0;z-index:3000;display:grid;place-items:center;padding:18px;background:rgba(8,13,22,.72);padding-top:calc(18px + env(safe-area-inset-top));padding-bottom:calc(18px + env(safe-area-inset-bottom))}.fc-pair-invite-card{width:min(100%,440px);max-height:calc(100dvh - 36px - env(safe-area-inset-top) - env(safe-area-inset-bottom));overflow:auto;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:22px;padding:22px;box-shadow:0 20px 70px rgba(0,0,0,.38);display:flex;flex-direction:column;gap:13px}.fc-pair-invite-card h2{font-size:22px;line-height:1.15;margin:0}.fc-pair-invite-card p{margin:0;font-size:14px;line-height:1.45}.fc-pair-invite-note{padding:10px 12px;border-radius:11px;background:var(--bg);color:var(--mut);font-size:12px;line-height:1.45}.fc-pair-invite-status{padding:10px 12px;border-radius:10px;background:var(--bg);font-size:13px!important;font-weight:700}.fc-pair-invite-card button{width:100%;min-height:46px}.fc-pair-invite-card button:disabled{opacity:.55;cursor:wait}';
    css += '.fc-sync-panel{max-width:980px;margin:0 auto;padding:12px 14px 28px;display:flex;flex-direction:column;gap:12px}.fc-panel-head{align-items:flex-start;padding:8px 2px}.fc-panel-head strong{font-size:20px;letter-spacing:-.02em}.fc-panel-head .note{max-width:680px;line-height:1.45;margin:5px 0 0}.fc-access-card{border:1px solid var(--line);border-radius:17px;background:var(--card);padding:16px;display:flex;flex-direction:column;gap:11px;min-width:0;box-shadow:0 4px 18px rgba(0,0,0,.045)}.fc-access-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.fc-access-card-head>div{display:flex;flex-direction:column;gap:3px;min-width:0}.fc-access-card-head strong{font-size:16px}.fc-eyebrow{font-size:10px;letter-spacing:.11em;font-weight:900;color:var(--mut)}.fc-access-badge{font-size:10px;font-weight:900;border-radius:999px;padding:6px 9px;white-space:nowrap;background:var(--bg);border:1px solid var(--line)}.fc-access-badge.is-ok{color:#148451;background:rgba(20,132,81,.1);border-color:rgba(20,132,81,.25)}.fc-access-badge.is-owner{color:var(--acc);background:color-mix(in srgb,var(--acc) 10%,var(--card))}.fc-access-badge.is-pending{color:var(--mut)}.fc-current-profile{font-size:15px;font-weight:800;margin:0;color:var(--fg)}.fc-profile-editor,.fc-owner-create{display:flex;flex-direction:column;gap:8px}.fc-tech-details,.fc-gate-tech{border-top:1px solid var(--line);padding-top:9px;margin-top:2px}.fc-tech-details summary,.fc-gate-tech summary,.fc-gate-alt summary{cursor:pointer;font-size:12px;font-weight:800;color:var(--mut);padding:4px 0}.fc-tech-uid{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}.fc-tech-uid code{font-size:10px;overflow-wrap:anywhere;flex:1;min-width:0}.fc-tech-uid button{min-height:30px;padding:4px 8px;font-size:11px}.fc-device-access{border-color:color-mix(in srgb,var(--acc) 28%,var(--line))}.fc-access-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:var(--bg);font-size:20px}.fc-device-access .fc-secondary-action{width:100%;min-height:46px}.fc-inline-hint{font-size:11px;color:var(--mut);line-height:1.45;margin:0}.fc-owner-section{gap:12px}.fc-invite-output{display:flex;flex-direction:column;gap:8px;padding:11px;border-radius:12px;background:var(--bg);border:1px solid var(--line)}.fc-invite-output input{width:100%;min-width:0;font-size:12px}.fc-invite-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.fc-invite-actions button{min-height:40px}.fc-pair-share-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.fc-pair-share-actions button{min-height:42px}.fc-profile-card{width:min(100%,520px);max-height:min(92dvh,900px);padding:24px;gap:13px}.fc-profile-card .fc-profile-title{line-height:1.14;letter-spacing:-.025em}.fc-profile-card .fc-eyebrow{margin-top:2px}.fc-profile-grid button{border:1px solid var(--line);border-radius:13px;background:var(--bg);color:var(--fg);transition:border-color .15s,background .15s,transform .15s}.fc-profile-grid button.selected{border:2px solid var(--acc);background:color-mix(in srgb,var(--acc) 10%,var(--card));transform:translateY(-1px)}.fc-profile-grid button small{line-height:1.25}.fc-gate-primary{width:100%;min-height:48px;font-size:15px;font-weight:900}.fc-profile-foot{padding:10px 12px;border-radius:11px;background:var(--bg);line-height:1.45}.fc-gate-revoked{padding:10px 12px;background:rgba(190,65,50,.1);border:1px solid rgba(190,65,50,.22);border-radius:11px;color:#c45b38;font-weight:800}.fc-gate-alt{border:1px solid var(--line);border-radius:13px;padding:10px 12px;background:var(--bg);display:flex;flex-direction:column;gap:9px}.fc-gate-alt[open]{background:var(--card)}.fc-gate-alt p{margin:0;line-height:1.45}.fc-gate-alt input{width:100%;min-width:0;min-height:42px}.fc-gate-alt button{width:100%;min-height:42px}.fc-gate-alt #fcProfileGateQr{background:transparent;border:1px solid var(--line);color:var(--fg)}#fcGateAccessLinkStatus{overflow-wrap:anywhere}@media(max-width:560px){.fc-sync-panel{padding:8px 10px 24px}.fc-access-card{padding:13px;border-radius:14px}.fc-access-card-head{align-items:flex-start}.fc-invite-actions,.fc-pair-share-actions{grid-template-columns:1fr}.fc-profile-card{padding:18px;max-height:94dvh}.fc-profile-grid{gap:7px}.fc-profile-grid button{min-height:70px;padding:9px}.fc-profile-grid button b{font-size:13px}}';
    css += '@media(max-width:520px){.fc-mini-next small{display:none}.fc-mini-controls{gap:5px}.fc-mini-controls button{flex:1;padding:5px 4px;font-size:9px}.fc-live-queue-row{gap:4px}.fc-queue-badge{font-size:8px;padding:4px}.fc-live-queue-row .fc-play-song{min-width:52px;padding:5px 6px}.fc-voice-actions,.fc-voice-manual{gap:6px}}';
    css += 'body.fc-reader-open .fc-mini-player{bottom:calc(54px + env(safe-area-inset-bottom)) !important}';
    var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  }

  window.addEventListener('storage', function (event) {
    if (event.key === ACCESS_REVOKED_KEY && event.newValue === '1' && !accessRevoked) {
      handleAccessRevoked('El acceso a esta banda fue revocado en otro dispositivo.');
    }
  });

  function startAutoConnect() {
    if (window.firebase) connectFirebase();
    else setStatus('Firebase no se ha cargado. Comprueba Internet y vuelve a abrir la página.', 'error');
    if ($('fcProfileSelect') && selectedProfileRole) $('fcProfileSelect').value = selectedProfileRole;
    if (currentUser) { setText('fcGateUid', currentUser.uid); setText('fcCurrentOwnerUid', currentUser.uid); }
    if (accessRevoked || accessVerificationPending) { var revokedNotice = $('fcGateRevokedNotice'); if (revokedNotice) revokedNotice.style.display = ''; maybeShowFirstProfileGate(); }
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
  setTimeout(maybeShowFirstProfileGate, 400);
  if (accessRevoked || accessVerificationPending) { var rn = $('fcGateRevokedNotice'); if (rn) rn.style.display = ''; }
})();
