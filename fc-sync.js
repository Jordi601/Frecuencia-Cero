/* Frecuencia Cero - roles y sincronizacion en vivo.
   La app sigue funcionando localmente si Firebase no esta configurado.
   Para sincronizar varios telefonos hay que configurar Firebase una sola vez por proyecto. */
(function () {
  'use strict';

  var CFG_KEY = 'fc_firebase_config_v1';
  var BAND_KEY = 'fc_band_id_v1';
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
  var bandId = localStorage.getItem(BAND_KEY) || '';
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
  function isDirector() { return isConnected() ? memberRole === 'voice1' : !currentUser; }
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
    if ($('fcSignIn')) $('fcSignIn').style.display = signed ? 'none' : '';
    if ($('fcSignOut')) $('fcSignOut').style.display = signed ? '' : 'none';
    if ($('fcCreateBand')) $('fcCreateBand').disabled = !signed || !!bandId;
    if ($('fcJoinBand')) $('fcJoinBand').disabled = !signed || !!bandId;
    if ($('fcInviteWrap')) $('fcInviteWrap').style.display = memberRole === 'voice1' && bandId ? '' : 'none';
    if ($('fcMemberAdmin')) $('fcMemberAdmin').style.display = memberRole === 'voice1' && bandId ? '' : 'none';
    if ($('fcBandActions')) $('fcBandActions').style.display = bandId ? '' : 'none';
    if ($('fcBandName')) $('fcBandName').value = bandMeta && bandMeta.name ? bandMeta.name : ($('fcBandName') ? $('fcBandName').value : '');
    if ($('fcBandSummary')) $('fcBandSummary').textContent = bandId ? ((bandMeta && bandMeta.name) || 'Banda conectada') + ' · ' + roleName(memberRole) : 'Aún no estás unido a una banda.';
    if ($('fcFollow')) $('fcFollow').checked = followDirector;
    var profileBar = $('fcRoleBar');
    if (profileBar) profileBar.style.display = (currentUser && memberRole !== 'pending') ? '' : 'none';
    if ($('fcDirectorButton')) $('fcDirectorButton').style.display = memberRole === 'voice1' ? '' : 'none';
    if ($('eventNew')) $('eventNew').style.display = isConnected() && memberRole !== 'voice1' ? 'none' : '';
    var legacyImport = document.querySelector('.event-import'); if (legacyImport) legacyImport.style.display = isConnected() ? 'none' : '';
    if ($('playlistEdit')) $('playlistEdit').style.display = isConnected() && memberRole !== 'voice1' ? 'none' : '';
    if ($('bnew')) $('bnew').style.display = isConnected() && memberRole !== 'voice1' ? 'none' : '';
    if ($('bedit')) $('bedit').style.display = isConnected() && memberRole !== 'voice1' ? 'none' : '';
    if ($('tmode') && isConnected()) $('tmode').style.display = 'none';
    renderMemberAdmin();
  }
  function configFromInput() {
    var raw = $('fcFirebaseConfig') ? $('fcFirebaseConfig').value.trim() : '';
    if (!raw) raw = localStorage.getItem(CFG_KEY) || '';
    if (!raw) throw new Error('Pega primero la configuración web de Firebase.');
    raw = raw.replace(/^const\s+firebaseConfig\s*=\s*/, '').replace(/^var\s+firebaseConfig\s*=\s*/, '').replace(/^let\s+firebaseConfig\s*=\s*/, '').replace(/;\s*$/, '');
    var cfg;
    try { cfg = JSON.parse(raw); }
    catch (parseError) {
      // Acepta también el objeto JavaScript copiado desde Firebase Console (claves sin comillas).
      cfg = {};
      var fields = ['apiKey','authDomain','databaseURL','projectId','storageBucket','messagingSenderId','appId','measurementId'];
      fields.forEach(function (key) {
        var escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        var match = raw.match(new RegExp('(?:[\"\']?' + escaped + '[\"\']?)\\s*:\\s*[\"\']([^\"\']*)[\"\']'));
        if (match) cfg[key] = match[1];
      });
    }
    ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId'].forEach(function (key) {
      if (!cfg[key]) throw new Error('La configuración no incluye ' + key + '.');
    });
    return cfg;
  }
  function connectFirebase() {
    try {
      if (!window.firebase || !firebase.initializeApp) throw new Error('No se pudo cargar Firebase. Comprueba tu conexión a Internet y vuelve a abrir la página.');
      var cfg = configFromInput();
      localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
      if ($('fcFirebaseConfig')) $('fcFirebaseConfig').value = JSON.stringify(cfg, null, 2);
      firebaseApp = firebase.apps.length ? firebase.app() : firebase.initializeApp(cfg);
      auth = firebase.auth();
      db = firebase.database();
      setStatus('Firebase conectado. Inicia sesión con Google.', 'success');
      auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(function () {});
      if (!authWatcherStarted) { auth.onAuthStateChanged(onAuthChanged); authWatcherStarted = true; }
      auth.getRedirectResult().catch(function (err) { if (err && err.code) setStatus('No se completó el acceso: ' + err.message, 'error'); });
      updateSyncButtons();
    } catch (err) {
      setStatus(err.message || 'No se pudo conectar Firebase.', 'error');
    }
  }
  function signIn() {
    if (!auth) { connectFirebase(); if (!auth) return; }
    var provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    // El redireccionamiento funciona mejor en Safari/iPhone como PWA que una ventana emergente.
    auth.signInWithRedirect(provider).catch(function (err) { setStatus('Error al iniciar sesión: ' + err.message, 'error'); });
  }
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
    if (!user) {
      memberRole = 'local'; memberProfile = null;
      setStatus(db ? 'Firebase listo. Inicia sesión con Google.' : 'Sincronización sin configurar; la aplicación sigue funcionando localmente.', 'neutral');
      updateSyncButtons(); return;
    }
    setStatus('Sesión iniciada como ' + (user.displayName || user.email || 'integrante') + '.', 'success');
    if (bandId) attachBand(bandId);
    else { memberRole = 'unjoined'; updateSyncButtons(); setText('fcJoinHint', 'Ahora crea la banda o únete una sola vez con el código de invitación.'); }
  }
  async function createBand() {
    try {
      if (!currentUser || !db) throw new Error('Conecta Firebase e inicia sesión primero.');
      if (bandId) throw new Error('Este teléfono ya está asociado a una banda. Cierra sesión o desconecta la banda antes de crear otra.');
      var name = $('fcBandName').value.trim() || 'Frecuencia Cero';
      var id = db.ref('bands').push().key;
      var now = firebase.database.ServerValue.TIMESTAMP;
      var initialEvents = {};
      (window.events || []).forEach(function (ev) { initialEvents[ev.id] = Object.assign({}, ev, { assignments: ev.assignments || {} }); });
      var initial = {
        meta: { name: name, ownerUid: currentUser.uid, createdAt: now, schema: 1 },
        members: {},
        catalog: mapById(window.songs || []),
        events: initialEvents,
        live: { eventId: null, songId: null, changedAt: now, changedBy: currentUser.uid }
      };
      initial.members[currentUser.uid] = { role: 'voice1', name: currentUser.displayName || 'Voz 1', email: currentUser.email || '', joinedAt: now };
      await db.ref('bands/' + id).set(initial);
      bandId = id; localStorage.setItem(BAND_KEY, bandId);
      memberRole = 'voice1'; memberProfile = initial.members[currentUser.uid]; bandMeta = initial.meta;
      lastCatalogJson = safeJson(mapById(window.songs || []));
      lastEventsJson = safeJson(mapById(window.events || []));
      await createInviteCode();
      await attachBand(id);
      setStatus('Banda creada. Tú eres Voz 1 · Director.', 'success');
    } catch (err) { setStatus('No se pudo crear la banda: ' + err.message, 'error'); }
  }
  async function createInviteCode() {
    if (!db || !bandId || memberRole !== 'voice1') return;
    try {
      if (!inviteCode) inviteCode = localStorage.getItem(inviteStorageKey()) || '';
      if (inviteCode) await db.ref('bandInvites/' + inviteCode).update({ active: false });
      inviteCode = randomCode();
      localStorage.setItem(inviteStorageKey(), inviteCode);
      await db.ref('bandInvites/' + inviteCode).set({ bandId: bandId, active: true, createdBy: currentUser.uid, createdAt: firebase.database.ServerValue.TIMESTAMP });
      if ($('fcInviteCode')) $('fcInviteCode').value = inviteCode;
      setText('fcInviteMsg', 'Comparte esta invitación con los otros cinco integrantes. Cada uno la utiliza una sola vez; después todos los eventos aparecerán automáticamente.');
    } catch (err) { setStatus('No se pudo crear el código de invitación: ' + err.message, 'error'); }
  }
  async function joinBand() {
    try {
      if (!currentUser || !db) throw new Error('Conecta Firebase e inicia sesión primero.');
      if (bandId) throw new Error('Este teléfono ya está asociado a una banda.');
      var code = ($('fcJoinCode').value || '').trim().toUpperCase();
      if (!code) throw new Error('Escribe el código de invitación de la banda.');
      var inviteSnap = await db.ref('bandInvites/' + code).once('value');
      var invite = inviteSnap.val();
      if (!invite || !invite.active || !invite.bandId) throw new Error('El código no existe o fue desactivado. Pide uno nuevo al director.');
      // No se consulta la lista antes de unirse: las reglas de Firebase permiten
      // la lectura de miembros solo a quienes ya pertenecen a la banda. El limite
      // de seis integrantes se valida de forma segura en las reglas de escritura.
      var member = { role: 'pending', name: currentUser.displayName || currentUser.email || 'Integrante', email: currentUser.email || '', joinedAt: firebase.database.ServerValue.TIMESTAMP, inviteCode: code };
      try { await db.ref('bands/' + invite.bandId + '/members/' + currentUser.uid).set(member); }
      catch (joinError) {
        if (joinError && joinError.code === 'PERMISSION_DENIED') {
          throw new Error('No se pudo incorporar la cuenta. Comprueba que la invitacion siga activa y que las reglas de Firebase esten publicadas.');
        }
        throw joinError;
      }
      bandId = invite.bandId; localStorage.setItem(BAND_KEY, bandId);
      await attachBand(bandId);
      $('fcJoinCode').value = '';
      setStatus('Solicitud registrada. El director debe asignarte un instrumento.', 'success');
    } catch (err) { setStatus('No se pudo unir a la banda: ' + err.message, 'error'); }
  }
  async function attachBand(id) {
    if (!db || !currentUser) return;
    Object.keys(refs).forEach(function (key) { try { refs[key].off(); } catch (e) {} }); refs = {};
    bandId = id; localStorage.setItem(BAND_KEY, id);
    var root = db.ref('bands/' + id);
    refs.meta = root.child('meta');
    refs.members = root.child('members');
    refs.mine = root.child('members/' + currentUser.uid);
    refs.catalog = root.child('catalog');
    refs.events = root.child('events');
    refs.live = root.child('live');
    refs.presence = root.child('presence/' + currentUser.uid);
    refs.meta.on('value', function (snap) { bandMeta = snap.val() || {}; updateSyncButtons(); });
    refs.mine.on('value', function (snap) {
      memberProfile = snap.val(); memberRole = memberProfile && memberProfile.role || 'pending';
      if (memberRole === 'voice1') { inviteCode = localStorage.getItem(inviteStorageKey()) || ''; if ($('fcInviteCode') && inviteCode) $('fcInviteCode').value = inviteCode; }
      setStatus(memberRole === 'pending' ? 'Estás dentro de la banda, esperando que Voz 1 te asigne tu función.' : 'Conectado · ' + roleName(memberRole), memberRole === 'pending' ? 'warning' : 'success');
      updateSyncButtons(); if (window.cur) applyRoleToCurrentSong();
    });
    refs.members.on('value', function (snap) { memberList = snap.val() || {}; Object.keys(memberList).forEach(function (uid) { memberList[uid].online = !!(presenceMap[uid] && presenceMap[uid].online); }); renderMemberAdmin(); });
    refs.allPresence = root.child('presence');
    refs.allPresence.on('value', function (snap) {
      presenceMap = snap.val() || {};
      Object.keys(memberList || {}).forEach(function (uid) { memberList[uid].online = !!(presenceMap[uid] && presenceMap[uid].online); });
      renderMemberAdmin(); renderMembersStatus();
    });
    refs.catalog.on('value', function (snap) {
      var data = snap.val(); if (!data) return;
      applyingRemote = true;
      window.songs = objectValues(data).sort(function (a, b) { return (a.catalogOrder == null ? 999999 : a.catalogOrder) - (b.catalogOrder == null ? 999999 : b.catalogOrder); });
      lastCatalogJson = safeJson(mapById(window.songs));
      localSaveSongs(); applyingRemote = false;
      if (typeof window.render === 'function') window.render();
      if (window.cur) { var latest = window.find(window.cur.id); if (latest) { window.cur = latest; window.paint(); applyRoleToCurrentSong(); } }
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
    });
    refs.live.on('value', function (snap) { liveState = snap.val() || null; renderLiveBanner(); handleLiveUpdate(); });
    refs.presence.set({ name: currentUser.displayName || currentUser.email || 'Integrante', role: memberRole, online: true, since: firebase.database.ServerValue.TIMESTAMP }).catch(function () {});
    refs.presence.onDisconnect().remove().catch(function () {});
    updateSyncButtons();
  }
  async function setMemberRole(uid, role) {
    if (memberRole !== 'voice1' || !db || !bandId) return;
    var allowed = ROLE_OPTIONS.some(function (r) { return r[0] === role; });
    if (!allowed) return;
    var ownerUid = bandMeta && bandMeta.ownerUid;
    if (role !== 'pending') {
      var occupied = Object.keys(memberList || {}).find(function (otherUid) { return otherUid !== uid && memberList[otherUid] && memberList[otherUid].role === role; });
      if (occupied) { alert('La función ' + roleName(role) + ' ya está asignada a otro integrante. Cada una de las seis funciones debe tener una sola persona.'); renderMemberAdmin(); return; }
    }
    if (uid === ownerUid && role !== 'voice1') { alert('La cuenta que creó la banda conserva el rol de Voz 1 · Director.'); renderMemberAdmin(); return; }
    if (uid !== ownerUid && role === 'voice1') { alert('Voz 1 · Director queda reservado para la cuenta que creó la banda.'); renderMemberAdmin(); return; }
    try { await db.ref(memberPath() + '/' + uid).update({ role: role }); }
    catch (err) { setStatus('No se pudo cambiar el rol: ' + err.message, 'error'); }
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
      var detail = document.createElement('small'); detail.textContent = (m.email || '') + (uid === currentUser.uid ? ' · Este teléfono' : '') + (m.online ? ' · En línea' : ' · Desconectado');
      info.append(name, detail);
      var select = document.createElement('select'); select.setAttribute('aria-label', 'Rol de ' + (m.name || 'integrante'));
      ROLE_OPTIONS.forEach(function (r) { if (r[0] === 'voice1' && bandMeta && uid !== bandMeta.ownerUid) return; var o = document.createElement('option'); o.value = r[0]; o.textContent = r[1]; if (r[0] !== 'pending' && r[0] !== m.role) { var used = Object.keys(memberList || {}).some(function (otherUid) { return otherUid !== uid && memberList[otherUid] && memberList[otherUid].role === r[0]; }); if (used) o.disabled = true; } select.appendChild(o); });
      select.value = m.role || 'pending'; select.disabled = memberRole !== 'voice1' || (bandMeta && uid === bandMeta.ownerUid);
      select.onchange = function () { setMemberRole(uid, select.value); };
      row.append(info, select); box.appendChild(row);
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
    if (followBtn) { followBtn.style.display = (memberRole === 'voice1') ? 'none' : ''; followBtn.textContent = followDirector ? 'Siguiendo director' : 'Vista libre'; }
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
  function handleLiveUpdate() {
    if (!liveState || !liveState.eventId || !liveState.songId) { renderLiveBanner(); return; }
    renderLiveBanner();
    if (memberRole === 'voice1' || !followDirector) return;
    var s = window.find(liveState.songId); if (!s) return;
    var changed = lastHandledSong !== liveState.eventId + ':' + liveState.songId;
    window.currentEventId = liveState.eventId;
    if ($('vplaylist') && $('vplaylist').classList.contains('on')) window.renderEventPlaylist();
    var editing = ($('ve') && $('ve').classList.contains('on')) || ($('vset') && $('vset').classList.contains('on')) || ($('vm') && $('vm').classList.contains('on'));
    var alreadyOnLiveSong = window.cur && window.cur.id === liveState.songId && window.currentEventId === liveState.eventId && $('vr') && $('vr').classList.contains('on');
    if (!editing && !alreadyOnLiveSong) {
      lastHandledSong = liveState.eventId + ':' + liveState.songId;
      window.openSong(liveState.songId, 'vplaylist');
    }
    applyRoleToCurrentSong();
  }
  async function setLiveSong(eventId, songId, index) {
    if (memberRole !== 'voice1' || !db || !bandId) { alert('Solo Voz 1 · Director puede cambiar la canción compartida.'); return; }
    try {
      await db.ref(bandPath('live')).set({ eventId: eventId, songId: songId, position: index, changedAt: firebase.database.ServerValue.TIMESTAMP, changedBy: currentUser.uid, changedByName: currentUser.displayName || 'Voz 1' });
      liveState = { eventId: eventId, songId: songId, position: index, changedBy: currentUser.uid };
      window.currentEventId = eventId; lastHandledSong = eventId + ':' + songId;
      renderEventPlaylist(); renderLiveBanner();
    } catch (err) { setStatus('No se pudo actualizar la canción en vivo: ' + err.message, 'error'); }
  }
  function renderMembersStatus() {
    var online = 0;
    Object.keys(memberList || {}).forEach(function (uid) { if (memberList[uid] && memberList[uid].online) online++; });
    setText('fcOnlineCount', Object.keys(memberList || {}).length + '/6 integrantes · ' + online + ' en línea');
  }

  // Las escrituras locales del director se publican en la base compartida.
  window.save = function () {
    if (typeof originalSave === 'function') originalSave();
    if (!applyingRemote && db && bandId && memberRole === 'voice1') {
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
    if (!applyingRemote && db && bandId && memberRole === 'voice1') {
      var payload = mapById(window.events || []), serialized = safeJson(payload);
      if (serialized !== lastEventsJson) {
        lastEventsJson = serialized;
        db.ref(bandPath('events')).set(payload).catch(function (err) { setStatus('Error al publicar los eventos: ' + err.message, 'error'); });
      }
    }
  };
  window.openSong = function (id, backTo) {
    if (typeof originalOpenSong === 'function') originalOpenSong(id, backTo);
    applyRoleToCurrentSong();
  };
  window.show = function (id) {
    if (typeof originalShow === 'function') originalShow(id);
    if (id === 'vm') updateSyncButtons();
    else if (id === 'vl' || id === 'vse' || id === 'vplaylist' || id === 'vr') setTimeout(handleLiveUpdate, 0);
  };

  // Editor de evento: asignación independiente por canción para acordeonista y tecladista.
  window.editEvent = function (id) {
    if (isConnected() && memberRole !== 'voice1') { alert('Solo Voz 1 · Director puede editar los eventos.'); return; }
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
    if (isConnected() && memberRole !== 'voice1') { alert('Solo Voz 1 · Director puede guardar eventos.'); return; }
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
      if (!isConnected() || memberRole === 'voice1') { var edit = document.createElement('button'); edit.className = 'event-folder-edit'; edit.textContent = 'Editar'; edit.onclick = function () { window.editEvent(ev.id); }; row.appendChild(edit); }
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
    $('playlistEdit').style.display = (!isConnected() || memberRole === 'voice1') ? '' : 'none';
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
    if ($('fcFollow')) $('fcFollow').onchange = function () { followDirector = this.checked; localStorage.setItem(FOLLOW_KEY, String(followDirector)); renderRoleBar(effectiveInstrument(window.cur && window.cur.id)); if (followDirector) handleLiveUpdate(); };
    if ($('fcFollowToggle')) $('fcFollowToggle').onclick = function () { followDirector = !followDirector; localStorage.setItem(FOLLOW_KEY, String(followDirector)); if ($('fcFollow')) $('fcFollow').checked = followDirector; renderRoleBar(effectiveInstrument(window.cur && window.cur.id)); if (followDirector) handleLiveUpdate(); };
    if ($('fcDirectorButton')) $('fcDirectorButton').onclick = function () { if (!window.cur || !window.currentEventId) { alert('Abre primero la canción desde una carpeta de evento.'); return; } var ev = window.findEvent(window.currentEventId); var index = ev ? ev.songIds.indexOf(window.cur.id) : -1; if (index >= 0) setLiveSong(ev.id, window.cur.id, index); };
  }
  function initUi() {
    var menu = document.querySelector('#vm .menu-content');
    if (menu && !$('fcSyncPanel')) {
      var panel = document.createElement('section'); panel.id = 'fcSyncPanel'; panel.className = 'fc-sync-panel';
      panel.innerHTML = '<div class="fc-panel-head"><div><strong>Mi banda y sincronización</strong><p class="note">Configura Firebase una sola vez en cada teléfono. Después, los eventos aparecerán automáticamente.</p></div><span class="fc-panel-icon">☁️</span></div>' +
        '<div id="fcSyncStatus" class="fc-status neutral">Sincronización sin configurar; la aplicación funciona localmente.</div>' +
        '<label class="fc-field-label" for="fcFirebaseConfig">Configuración web de Firebase</label><textarea id="fcFirebaseConfig" rows="5" placeholder="Pega aquí el objeto firebaseConfig de tu aplicación web de Firebase"></textarea><button id="fcConnect" class="p">Guardar configuración y conectar</button>' +
        '<div class="fc-auth-row"><button id="fcSignIn">Iniciar sesión con Google</button><button id="fcSignOut" style="display:none">Cerrar sesión</button></div>' +
        '<div class="fc-band-box"><strong>Mi banda</strong><p id="fcBandSummary" class="note">Aún no estás unido a una banda.</p><input id="fcBandName" placeholder="Nombre de la banda" value="Frecuencia Cero"><div class="fc-auth-row"><button id="fcCreateBand" class="p">Crear banda</button></div><div id="fcJoinHint" class="note">La primera cuenta crea la banda y queda como Voz 1 · Director.</div><label class="fc-field-label" for="fcJoinCode">Código de incorporación (solo la primera vez)</label><input id="fcJoinCode" autocomplete="off" placeholder="Código que te dio el director"><button id="fcJoinBand">Unirme a Frecuencia Cero</button><div id="fcBandActions" style="display:none"><div id="fcInviteWrap" style="display:none"><label class="fc-field-label" for="fcInviteCode">Invitación para integrantes</label><div class="fc-invite-row"><input id="fcInviteCode" readonly><button id="fcCopyInvite">Copiar</button><button id="fcNewInvite">Renovar</button></div><p id="fcInviteMsg" class="note">Cada integrante usa este código una sola vez. No se usa para entrar a cada evento.</p></div></div></div>' +
        '<div id="fcMemberAdmin" class="fc-member-admin" style="display:none"><div class="fc-member-head"><strong>Integrantes y funciones (6 plazas)</strong><span id="fcOnlineCount" class="note"></span></div><p class="note">Asigna una sola persona a cada función: Voz 1, Voz 2, Bajista, Acordeonista, Baterista y Tecladista.</p><div id="fcMembers"></div></div>' +
        '<label class="fc-follow-row"><input type="checkbox" id="fcFollow" checked> Seguir automáticamente la canción que elija Voz 1</label>';
      var insertion = $('mi'); menu.insertBefore(panel, insertion);
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
    if ($('fcCreateBand')) $('fcCreateBand').onclick = createBand;
    if ($('fcJoinBand')) $('fcJoinBand').onclick = joinBand;
    if ($('fcNewInvite')) $('fcNewInvite').onclick = createInviteCode;
    if ($('fcCopyInvite')) $('fcCopyInvite').onclick = function () {
      var text = $('fcInviteCode').value;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { setText('fcInviteMsg', 'Código copiado. Cada músico lo utiliza una sola vez para incorporarse.'); });
      else { $('fcInviteCode').focus(); $('fcInviteCode').select(); setText('fcInviteMsg', 'Copia el código seleccionado.'); }
    };
    profileButtonActions();
  }

  function addStyles() {
    var css = '' +
      '.fc-sync-panel{border:1px solid var(--line);border-radius:16px;padding:13px;background:var(--card);display:flex;flex-direction:column;gap:9px}' +
      '.fc-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.fc-panel-head strong{font-size:17px}.fc-panel-icon{font-size:25px}' +
      '.fc-status{padding:9px 11px;border-radius:10px;font-size:13px;font-weight:700;background:var(--bg)}.fc-status.success{color:#16764b;background:rgba(22,139,88,.10)}.fc-status.warning{color:#946200;background:rgba(220,160,30,.13)}.fc-status.error{color:#b3261e;background:rgba(179,38,30,.10)}' +
      '.fc-field-label{font-size:12px;color:var(--mut);font-weight:800;margin-top:3px}.fc-auth-row,.fc-invite-row{display:flex;gap:7px}.fc-auth-row button,.fc-invite-row button{flex:1;min-width:0}.fc-band-box{border-top:1px solid var(--line);padding-top:10px;display:flex;flex-direction:column;gap:8px}.fc-member-admin{border-top:1px solid var(--line);padding-top:10px}.fc-member-head{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px}.fc-member-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--line)}.fc-member-info{flex:1;min-width:0}.fc-member-info strong,.fc-member-info small{display:block;overflow-wrap:anywhere}.fc-member-info small{font-size:11px;color:var(--mut)}.fc-member-row select{width:47%;min-width:128px;padding:7px;font-size:12px}.fc-follow-row{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700}.fc-follow-row input{width:18px;min-height:18px;height:18px}.fc-live-banner{width:calc(100% - 24px);margin:0 12px 8px;text-align:left;background:rgba(22,139,88,.12);border-color:rgba(22,139,88,.35);color:var(--fg);font-size:13px;font-weight:850;display:flex;align-items:center;gap:8px}.fc-live-banner span:nth-child(2){flex:1}.fc-live-dot{width:9px;height:9px;border-radius:100%;background:#16a36a;display:inline-block}.fc-role-bar{padding:8px 12px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--bg)}.fc-role-line{display:flex;align-items:center;justify-content:space-between;gap:7px;width:100%;font-size:12px}.fc-role-line button{font-size:12px;min-height:36px;padding:6px 9px}.fc-role-bar select{min-height:38px;font-size:13px}.fc-next-only{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px 18px;gap:12px;overflow:auto}.fc-next-chip{padding:6px 12px;border-radius:20px;background:var(--acc);color:var(--accfg);font-weight:900;font-size:12px}.fc-next-caption{font-size:11px;color:var(--mut);font-weight:900;letter-spacing:.12em}.fc-next-current{font-size:clamp(25px,6vw,38px);font-weight:900;line-height:1.1}.fc-next-title{font-size:clamp(28px,8vw,48px);font-weight:950;color:var(--acc);line-height:1.08}.fc-next-key{font-size:14px;color:var(--mut);font-weight:800}.fc-event-selected-row{display:block}.fc-event-song-head{display:flex;align-items:center;gap:7px}.fc-assignment-controls{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:7px 3px 2px 29px}.fc-assignment-controls label{font-size:10px;color:var(--mut);font-weight:800}.fc-assignment-controls select{display:block;min-height:35px;font-size:12px;padding:5px;margin-top:3px}.fc-live-song{background:rgba(22,139,88,.09);border-radius:10px;padding-left:8px;padding-right:8px}.fc-play-song{font-size:12px;padding:7px 9px;min-height:36px}';
    var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
  }

  function startAutoConnect() {
    var savedConfig = localStorage.getItem(CFG_KEY);
    if ($('fcFirebaseConfig') && savedConfig) $('fcFirebaseConfig').value = JSON.stringify(JSON.parse(savedConfig), null, 2);
    if (savedConfig && window.firebase) connectFirebase();
    else if (!window.firebase) setStatus('La aplicación está lista en modo local. Para sincronizar, configura Firebase con Internet.', 'neutral');
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
    if (isConnected() && memberRole !== 'voice1') { alert('Solo Voz 1 · Director puede borrar eventos.'); return; }
    if (oldDelete) oldDelete();
  };
  $('eventNew').onclick = function () { window.editEvent(null); };
  $('eventSave').onclick = window.saveEventEditor;
  $('playlistEdit').onclick = function () { window.editEvent(window.currentEventId); };
  $('eventEditBack').onclick = function () { window.renderEvents(); window.show('vse'); };
  $('eventCancel').onclick = function () { window.renderEvents(); window.show('vse'); };
  $('eventShare').style.display = 'none';
  if ($('playlistBack')) $('playlistBack').onclick = function () { window.show('vse'); };
  if ($('fcLiveBanner')) $('fcLiveBanner').onclick = function () {
    if (liveState && liveState.eventId && liveState.songId) { window.currentEventId = liveState.eventId; window.openEvent(liveState.eventId); window.openSong(liveState.songId, 'vplaylist'); }
  };
  if ($('tmode')) $('tmode').addEventListener('click', function () { if (isConnected()) { setTimeout(applyRoleToCurrentSong, 0); } });
  window.addEventListener('online', function () { if (currentUser && bandId && db) setStatus('Conexión recuperada. Sincronizando…', 'success'); });
  window.addEventListener('offline', function () { if (currentUser && bandId) setStatus('Sin Internet. Se conserva la última información descargada; los cambios se sincronizarán al reconectar.', 'warning'); });
  renderEvents(); renderLiveBanner(); startAutoConnect(); updateSyncButtons();
})();
