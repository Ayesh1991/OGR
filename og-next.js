/* ═══════════════════════════════════════════════════════════════════
   OG REVISE — NEXT LAYER  (og-next.js)
   ═══════════════════════════════════════════════════════════════════
   Loads AFTER the main app script and upgrades it in place:

   1. TODAY DASHBOARD  — exam countdown, streak, due-now, per-subject
      mastery bars and a review-activity heatmap on the welcome screen.
   2. ACTIVITY ENGINE  — every flashcard/topic grade is logged per-day
      (localStorage, mirrored into the Drive-synced SM-2 file).
   3. COMMAND PALETTE  — Ctrl/Cmd+K: topics + app actions, keyboard-first.
   4. VIEW TRANSITIONS — tab/mode/topic navigation animates via the
      View Transitions API (graceful no-op elsewhere).
   5. HAPTICS          — subtle vibration on card grades (mobile).

   Everything here is progressive enhancement: it only wraps existing
   functions, never replaces behaviour. If this file fails to load,
   the app works exactly as before.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__OG_NEXT__) return; window.__OG_NEXT__ = 1;

  var $id = function (i) { return document.getElementById(i); };
  var REDUCED = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ────────────────────────────────────────────────────────────────
     1. VIEW TRANSITIONS — wrap the app's navigation entry points
     ──────────────────────────────────────────────────────────────── */
  function vt(fn) {
    if (document.startViewTransition && !REDUCED && !document.hidden) {
      try { return document.startViewTransition(fn); } catch (e) { return fn(); }
    }
    return fn();
  }

  ['switchTab', 'switchMode'].forEach(function (name) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () {
      var a = arguments;
      return vt(function () { return orig.apply(null, a); });
    };
  });

  if (typeof window.pickTopic === 'function') {
    var _pickTopic = window.pickTopic;
    window.pickTopic = function (id, name, type) {
      if (id && name) rememberTopic({ id: id, name: name, type: type });
      var a = arguments;
      return vt(function () { return _pickTopic.apply(null, a); });
    };
  }
  if (typeof window.pickTog === 'function') {
    var _pickTog = window.pickTog;
    window.pickTog = function (id, name, year, issue) {
      if (year) rememberTopic({ id: 'tog|' + year, name: name || ('TOG ' + year), type: 'tog' });
      var a = arguments;
      return vt(function () { return _pickTog.apply(null, a); });
    };
  }

  function rememberTopic(t) {
    try { localStorage.setItem('og_last_topic', JSON.stringify({ id: t.id, name: t.name, type: t.type, ts: Date.now() })); } catch (e) {}
    renderResume();
  }

  /* ────────────────────────────────────────────────────────────────
     2. ACTIVITY ENGINE + haptics
     ──────────────────────────────────────────────────────────────── */
  var ACT = { days: {} };
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function actLoad() {
    try { var c = localStorage.getItem('og_activity_v1'); if (c) ACT.days = JSON.parse(c) || {}; } catch (e) { ACT.days = {}; }
  }
  function actSave() {
    try { localStorage.setItem('og_activity_v1', JSON.stringify(ACT.days)); } catch (e) {}
  }
  window.ogActRecord = function (ok) {
    var k = todayKey();
    var d = ACT.days[k] || (ACT.days[k] = { r: 0, g: 0 });
    d.r++; if (ok) d.g++;
    actSave(); renderStreak(); renderHeat();
  };
  /* Hooks for the SM-2 Drive file so history follows you across devices. */
  window.ogNextActivity = function () { return ACT.days; };
  window.ogNextMergeActivity = function (remote) {
    if (!remote || typeof remote !== 'object') return;
    var changed = false;
    Object.keys(remote).forEach(function (k) {
      var r = remote[k] || {}, l = ACT.days[k];
      if (!l || (r.r || 0) > (l.r || 0)) { ACT.days[k] = { r: r.r || 0, g: r.g || 0 }; changed = true; }
    });
    if (changed) { actSave(); renderStreak(); renderHeat(); }
  };

  function buzz(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {} }

  if (typeof window.rateCard === 'function') {
    var _rateCard = window.rateCard;
    window.rateCard = function (q) {
      window.ogActRecord(q >= 2);
      buzz(q >= 2 ? 8 : [10, 40, 10]);
      return _rateCard(q);
    };
  }
  if (typeof window.spdGrade === 'function') {
    var _spdGrade = window.spdGrade;
    window.spdGrade = function (name, q) {
      window.ogActRecord(q >= 3);
      buzz(q >= 3 ? 8 : [10, 40, 10]);
      return _spdGrade(name, q);
    };
  }

  /* ────────────────────────────────────────────────────────────────
     Streak + heatmap
     ──────────────────────────────────────────────────────────────── */
  function dayShift(base, n) {
    var d = new Date(base + 'T00:00:00'); d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function streaks() {
    var cur = 0, k = todayKey();
    if (!ACT.days[k] || !ACT.days[k].r) k = dayShift(k, -1);  // today not studied *yet* — count from yesterday
    while (ACT.days[k] && ACT.days[k].r > 0) { cur++; k = dayShift(k, -1); }
    var best = 0, run = 0, prev = null;
    Object.keys(ACT.days).sort().forEach(function (day) {
      if (!ACT.days[day].r) { prev = null; return; }
      run = (prev && dayShift(prev, 1) === day) ? run + 1 : 1;
      best = Math.max(best, run); prev = day;
    });
    return { current: cur, best: Math.max(best, cur) };
  }
  function renderStreak() {
    var el = $id('dash-streak-n'); if (!el) return;
    var s = streaks();
    countUp(el, s.current);
    var sub = $id('dash-streak-sub');
    var today = ACT.days[todayKey()];
    if (sub) sub.textContent = (today && today.r ? today.r + ' reviews today' : 'no reviews yet today') + ' · best ' + s.best + 'd';
    var flame = $id('dash-streak-ico');
    if (flame) flame.textContent = s.current >= 7 ? '🔥' : s.current >= 3 ? '✨' : '🌱';
  }
  function renderHeat() {
    var box = $id('dash-heat-grid'); if (!box) return;
    var WEEKS = 20, cells = [];
    var end = todayKey();
    var total = WEEKS * 7; /* last WEEKS×7 days, ending today */
    var first = dayShift(end, -(total - 1));
    var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var k = first, sum = 0;
    for (var i = 0; i < total; i++) {
      var d = ACT.days[k], r = d ? d.r : 0; sum += r;
      var lvl = r === 0 ? 0 : r < 5 ? 1 : r < 15 ? 2 : r < 30 ? 3 : 4;
      var dt = new Date(k + 'T00:00:00');
      cells.push('<i data-l="' + lvl + '" title="' + r + ' review' + (r === 1 ? '' : 's') + ' · ' + dt.getDate() + ' ' + monthNames[dt.getMonth()] + '"></i>');
      k = dayShift(k, 1);
    }
    box.innerHTML = cells.join('');
    var cap = $id('dash-heat-sum');
    if (cap) cap.textContent = sum + ' reviews in the last ' + WEEKS + ' weeks';
  }

  /* ────────────────────────────────────────────────────────────────
     Exam countdown
     ──────────────────────────────────────────────────────────────── */
  function examGet() { try { return JSON.parse(localStorage.getItem('og_exam') || 'null'); } catch (e) { return null; } }
  function examSet(v) { try { localStorage.setItem('og_exam', JSON.stringify(v)); } catch (e) {} renderExam(); }
  function renderExam() {
    var card = $id('dc-exam'); if (!card) return;
    var ex = examGet();
    if (!ex || !ex.date) {
      card.className = 'dash-card';
      card.innerHTML =
        '<div class="dash-lbl">🎯 Exam countdown</div>' +
        '<div class="dash-sub" style="margin:6px 0 10px">Set your exam date — the dashboard keeps you honest.</div>' +
        '<button class="dash-ghost" id="dash-exam-set">＋ Set exam date</button>';
      var b = $id('dash-exam-set'); if (b) b.onclick = examEdit;
      return;
    }
    var days = Math.ceil((new Date(ex.date + 'T00:00:00') - new Date(new Date().toDateString())) / 86400000);
    var tone = days < 0 ? '' : days <= 21 ? 'hot' : days <= 60 ? 'warm' : 'cool';
    card.className = 'dash-card exam-' + tone;
    card.innerHTML =
      '<div class="dash-lbl">🎯 ' + esc2(ex.name || 'Exam') + '</div>' +
      (days >= 0
        ? '<div class="dash-big" id="dash-exam-n">' + days + '</div><div class="dash-sub">day' + (days === 1 ? '' : 's') + ' to go · ' + esc2(ex.date) + '</div>'
        : '<div class="dash-big">🎓</div><div class="dash-sub">Exam day has passed — set the next one.</div>') +
      '<button class="dash-edit" id="dash-exam-edit" title="Edit exam">✎</button>';
    var e = $id('dash-exam-edit'); if (e) e.onclick = examEdit;
    var n = $id('dash-exam-n'); if (n && days >= 0) countUp(n, days);
  }
  function examEdit() {
    var ex = examGet() || {};
    var card = $id('dc-exam'); if (!card) return;
    card.innerHTML =
      '<div class="dash-lbl">🎯 Exam countdown</div>' +
      '<input class="dash-input" id="dash-exam-name" placeholder="Exam name (e.g. MD Part 2)" value="' + esc2(ex.name || '') + '">' +
      '<input class="dash-input" id="dash-exam-date" type="date" value="' + esc2(ex.date || '') + '">' +
      '<div style="display:flex;gap:8px;margin-top:10px">' +
      '<button class="dash-ghost" id="dash-exam-cancel">Cancel</button>' +
      '<button class="dash-cta sm" id="dash-exam-save">Save</button></div>';
    $id('dash-exam-save').onclick = function () {
      var d = $id('dash-exam-date').value;
      if (!d) { if (typeof toast === 'function') toast('Pick a date', 'err'); return; }
      examSet({ name: $id('dash-exam-name').value.trim() || 'Exam', date: d });
    };
    $id('dash-exam-cancel').onclick = renderExam;
  }
  function esc2(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ────────────────────────────────────────────────────────────────
     Count-up number animation (GSAP if present, instant otherwise)
     ──────────────────────────────────────────────────────────────── */
  function countUp(el, target) {
    target = Number(target) || 0;
    if (!window.gsap || REDUCED) { el.textContent = target; return; }
    var o = { v: Number(el.textContent.replace(/\D/g, '')) || 0 };
    window.gsap.to(o, {
      v: target, duration: 0.8, ease: 'power2.out',
      onUpdate: function () { el.textContent = Math.round(o.v); }
    });
  }

  /* ────────────────────────────────────────────────────────────────
     3. DASHBOARD SCAN — replaces loadWelcomeFcStats with a single
        Drive pass that also computes per-subject mastery.
     ──────────────────────────────────────────────────────────────── */
  /* The taxonomy arrays and app state are declared with const/let in the
     main script — global *lexical* bindings, not window properties. These
     getters read them safely from inside this separate script. */
  function T_OBS() { try { return typeof OBSTETRICS !== 'undefined' ? OBSTETRICS : null; } catch (e) { return null; } }
  function T_GYN() { try { return typeof GYNAECOLOGY !== 'undefined' ? GYNAECOLOGY : null; } catch (e) { return null; } }
  function T_GOV() { try { return typeof CLINICAL_GOV !== 'undefined' ? CLINICAL_GOV : null; } catch (e) { return null; } }
  function T_TOG() { try { return typeof TOG_YEARS !== 'undefined' ? TOG_YEARS : []; } catch (e) { return []; } }
  function appS() { try { return typeof S !== 'undefined' ? S : null; } catch (e) { return null; } }

  var subjectIndex = null;
  function buildSubjectIndex() {
    subjectIndex = [];
    function addTree(tree, subj) {
      if (!Array.isArray(tree)) return;
      tree.forEach(function (g) {
        (g.topics || []).forEach(function (t) { subjectIndex.push({ n: norm(t), s: subj }); });
        (g.subgroups || []).forEach(function (sg) {
          (sg.topics || []).forEach(function (t) { subjectIndex.push({ n: norm(t), s: subj }); });
        });
      });
    }
    try {
      addTree(T_OBS(), 'obs');
      addTree(T_GYN(), 'gyn');
      addTree(T_GOV(), 'gov');
    } catch (e) {}
  }
  function subjectOf(folderName) {
    if (!subjectIndex) buildSubjectIndex();
    var n = norm(folderName || '');
    if (/^tog\b/.test(n)) return 'tog';
    for (var i = 0; i < subjectIndex.length; i++) if (subjectIndex[i].n === n) return subjectIndex[i].s;
    var best = null, bs = 0;
    for (var j = 0; j < subjectIndex.length; j++) {
      var v = sim(subjectIndex[j].n, n);
      if (v > bs) { bs = v; best = subjectIndex[j].s; }
    }
    return bs >= 0.6 ? best : 'other';
  }

  function emptyBuckets() {
    return { obs: { m: 0, l: 0, f: 0 }, gyn: { m: 0, l: 0, f: 0 }, gov: { m: 0, l: 0, f: 0 }, tog: { m: 0, l: 0, f: 0 }, other: { m: 0, l: 0, f: 0 } };
  }

  async function dashScan() {
    var st = appS();
    if (!st || !st.token || !st.folderId) return;
    try {
      var today = new Date().toISOString().split('T')[0];
      var q = encodeURIComponent("'" + st.folderId + "' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false");
      var r = await gf('https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name)&pageSize=300');
      var d = await r.json();
      var folders = d.files || [];
      var totalCards = 0, dueToday = 0, deckCount = 0;
      var buckets = emptyBuckets();
      await Promise.all(folders.map(async function (folder) {
        try {
          var q2 = encodeURIComponent("'" + folder.id + "' in parents and name contains 'flashcards__' and trashed=false");
          var r2 = await gf('https://www.googleapis.com/drive/v3/files?q=' + q2 + '&fields=files(id)&pageSize=50');
          var d2 = await r2.json();
          var subj = null;
          for (var fi = 0; fi < (d2.files || []).length; fi++) {
            try {
              var r3 = await gf('https://www.googleapis.com/drive/v3/files/' + d2.files[fi].id + '?alt=media');
              var data = await r3.json();
              var cards = data.cards || [];
              if (!cards.length) continue;
              if (subj === null) subj = subjectOf(folder.name);
              var b = buckets[subj] || buckets.other;
              totalCards += cards.length; deckCount++;
              cards.forEach(function (c) {
                var reps = c.reps || 0, iv = c.interval || 0;
                if (reps > 0 && c.due && c.due <= today) dueToday++;
                if (reps === 0) b.f++;
                else if (iv >= 21) b.m++;
                else b.l++;
              });
            } catch (e) {}
          }
        } catch (e) {}
      }));

      applyDashStats({ due: dueToday, total: totalCards, decks: deckCount, buckets: buckets });
      try { localStorage.setItem('og_dash_cache', JSON.stringify({ t: Date.now(), due: dueToday, total: totalCards, decks: deckCount, buckets: buckets })); } catch (e) {}
    } catch (e) { console.warn('dash scan:', e.message); }
  }

  function applyDashStats(st) {
    var due = $id('w-fc-due'), tot = $id('w-fc-total'), dk = $id('w-fc-decks');
    if (st.decks > 0) {
      if (due) countUp(due, st.due);
      if (tot) countUp(tot, st.total);
      if (dk) countUp(dk, st.decks);
      var row = $id('w-fc-stats'); if (row) row.style.display = 'flex';
      var hint = $id('dash-fc-hint'); if (hint) hint.style.display = 'none';
    }
    var badge = $id('due-badge');
    if (badge) {
      if (st.due > 0) { badge.textContent = st.due > 99 ? '99+' : st.due; badge.style.display = 'block'; }
      else badge.style.display = 'none';
    }
    var chip = $id('dash-due-chip');
    if (chip) chip.textContent = st.due > 0 ? st.due + ' due' : 'all clear';
    renderMastery(st.buckets);
  }

  /* Replace the app's welcome stats loader — every existing call site
     (init, OAuth return, cloud token) now feeds the dashboard. */
  if (typeof window.loadWelcomeFcStats === 'function') window.loadWelcomeFcStats = dashScan;

  function renderMastery(buckets) {
    var box = $id('dash-mastery'); if (!box) return;
    buckets = buckets || emptyBuckets();
    var rows = [
      ['obs', 'OBS', 'Obstetrics'], ['gyn', 'GYN', 'Gynaecology'],
      ['gov', 'GOV', 'Clinical governance'], ['tog', 'TOG', 'TOG articles']
    ];
    var any = false;
    var html = rows.map(function (row) {
      var b = buckets[row[0]] || { m: 0, l: 0, f: 0 };
      var n = b.m + b.l + b.f;
      if (!n) return '';
      any = true;
      var pm = Math.round(b.m / n * 100), pl = Math.round(b.l / n * 100);
      return '<div class="mast-row" title="' + row[2] + ': ' + b.m + ' mastered · ' + b.l + ' learning · ' + b.f + ' new">' +
        '<span class="mast-tag">' + row[1] + '</span>' +
        '<span class="mast-bar"><i class="m" style="width:' + pm + '%"></i><i class="l" style="width:' + pl + '%"></i></span>' +
        '<span class="mast-pct">' + pm + '%</span></div>';
    }).join('');
    box.innerHTML = any ? html :
      '<div class="dash-sub">Mastery appears here once flashcards have been reviewed — cards at a 3-week interval count as mastered.</div>';
  }

  /* ────────────────────────────────────────────────────────────────
     Resume + random topic
     ──────────────────────────────────────────────────────────────── */
  function renderResume() {
    var btn = $id('dash-resume'); if (!btn) return;
    var t = null;
    try { t = JSON.parse(localStorage.getItem('og_last_topic') || 'null'); } catch (e) {}
    if (!t || !t.name || Date.now() - (t.ts || 0) > 30 * 86400000) { btn.style.display = 'none'; return; }
    btn.style.display = '';
    var nm = $id('dash-resume-name'); if (nm) nm.textContent = t.name.length > 26 ? t.name.slice(0, 25) + '…' : t.name;
    btn.onclick = function () { if (typeof jumpTo === 'function') jumpTo(t.id, t.name, t.type); };
  }

  function allTopics() {
    var out = [];
    function walk(tree, type) {
      if (!Array.isArray(tree)) return;
      tree.forEach(function (g, gi) {
        (g.topics || []).forEach(function (t, ti) { out.push({ id: type + '|' + gi + '|0|' + ti, name: t, type: type, path: g.group }); });
        (g.subgroups || []).forEach(function (sg) {
          (sg.topics || []).forEach(function (t, ti) { out.push({ id: type + '|' + gi + '|0|' + ti, name: t, type: type, path: g.group + ' › ' + sg.name }); });
        });
      });
    }
    try {
      walk(T_OBS(), 'obs'); walk(T_GYN(), 'gyn'); walk(T_GOV(), 'gov');
      (T_TOG() || []).forEach(function (y) { out.push({ id: 'tog|' + y.year, name: 'TOG ' + y.year, type: 'tog', path: (y.articles || []).length + ' articles' }); });
    } catch (e) {}
    return out;
  }
  function randomTopic() {
    var all = allTopics().filter(function (t) { return t.type !== 'tog'; });
    if (!all.length) return;
    var t = all[Math.floor(Math.random() * all.length)];
    if (typeof toast === 'function') toast('🎲 ' + t.name, 'info');
    if (typeof jumpTo === 'function') jumpTo(t.id, t.name, t.type);
  }

  /* ────────────────────────────────────────────────────────────────
     4. COMMAND PALETTE (Ctrl/Cmd+K)
     ──────────────────────────────────────────────────────────────── */
  var palOpen = false, palSel = 0, palItems = [];
  function palActions() {
    var a = [
      { ico: '▶', name: 'Start today\'s review', hint: 'due cards + topics', run: function () { if (typeof goToDue === 'function') goToDue(); } },
      { ico: '🎲', name: 'Random topic', hint: 'serendipity mode', run: randomTopic },
      { ico: '🛠', name: 'Open uploader', hint: 'add content', run: function () { if (typeof openUploaderTools === 'function') openUploaderTools(); } },
      { ico: '↻', name: 'Sync Drive now', hint: 'refresh current topic', run: function () { if (typeof syncNow === 'function') syncNow(); } },
      { ico: '⚙', name: 'Settings', hint: 'Drive · cache · account', run: function () { if (typeof openSP === 'function') openSP(); } }
    ];
    [['obs', 'OBS syllabus'], ['gyn', 'GYN syllabus'], ['gov', 'Clinical governance'], ['tog', 'TOG library'],
     ['plan', 'Study planner'], ['pp', 'Exam papers'], ['os', 'OSCE simulator'], ['es', 'Essays']].forEach(function (t) {
      a.push({ ico: '⇥', name: 'Go to ' + t[1], hint: 'tab', run: function () { if (typeof switchTab === 'function') switchTab(t[0]); } });
    });
    return a;
  }
  function palBuild() {
    var el = document.createElement('div');
    el.id = 'og-pal';
    el.innerHTML =
      '<div class="pal-back"></div>' +
      '<div class="pal-box" role="dialog" aria-label="Command palette">' +
        '<div class="pal-inrow"><span class="pal-glass">⌕</span>' +
        '<input id="pal-in" placeholder="Search topics or type a command…" autocomplete="off" spellcheck="false">' +
        '<kbd>esc</kbd></div>' +
        '<div id="pal-list"></div>' +
        '<div class="pal-foot"><span><kbd>↑↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>ctrl</kbd>+<kbd>k</kbd> toggle</span></div>' +
      '</div>';
    document.body.appendChild(el);
    el.querySelector('.pal-back').addEventListener('click', palClose);
    var inp = $id('pal-in');
    inp.addEventListener('input', function () { palFilter(inp.value); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); palMove(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); palMove(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); palRun(palSel); }
      else if (e.key === 'Escape') { palClose(); }
    });
  }
  window.ogPalOpen = function () {
    if (!$id('og-pal')) palBuild();
    var el = $id('og-pal');
    el.classList.add('on'); palOpen = true;
    var inp = $id('pal-in'); inp.value = ''; palFilter('');
    setTimeout(function () { inp.focus(); }, 60);
    if (window.gsap && !REDUCED) window.gsap.fromTo('.pal-box', { y: -14, opacity: 0, scale: 0.98 }, { y: 0, opacity: 1, scale: 1, duration: 0.28, ease: 'power3.out' });
    buzz(6);
  };
  function palClose() {
    var el = $id('og-pal'); if (el) el.classList.remove('on');
    palOpen = false;
  }
  function palScore(name, q) {
    var n = name.toLowerCase();
    if (n.startsWith(q)) return 3;
    if (n.indexOf(' ' + q) >= 0) return 2;
    if (n.indexOf(q) >= 0) return 1;
    return 0;
  }
  function palFilter(qraw) {
    var q = qraw.trim().toLowerCase();
    var items = [];
    if (!q) {
      items = palActions().slice(0, 7).map(function (a) { return { kind: 'act', a: a }; });
      var t = null; try { t = JSON.parse(localStorage.getItem('og_last_topic') || 'null'); } catch (e) {}
      if (t && t.name) items.splice(1, 0, { kind: 'top', t: t, hint: 'continue where you left off' });
    } else {
      palActions().forEach(function (a) {
        if (palScore(a.name, q)) items.push({ kind: 'act', a: a, s: palScore(a.name, q) });
      });
      allTopics().forEach(function (t) {
        var s = palScore(t.name, q);
        if (s) items.push({ kind: 'top', t: t, s: s });
      });
      items.sort(function (x, y) { return (y.s || 0) - (x.s || 0); });
      items = items.slice(0, 12);
    }
    palItems = items; palSel = 0;
    var icons = { obs: '🤱', gyn: '🩺', gov: '🏛️', tog: '📄' };
    $id('pal-list').innerHTML = items.length ? items.map(function (it, i) {
      if (it.kind === 'act') {
        return '<div class="pal-item' + (i === palSel ? ' on' : '') + '" data-i="' + i + '"><span class="pal-ico">' + it.a.ico + '</span>' +
          '<span class="pal-nm">' + esc2(it.a.name) + '</span><span class="pal-hint">' + esc2(it.a.hint) + '</span></div>';
      }
      return '<div class="pal-item' + (i === palSel ? ' on' : '') + '" data-i="' + i + '"><span class="pal-ico">' + (icons[it.t.type] || '📋') + '</span>' +
        '<span class="pal-nm">' + esc2(it.t.name) + '</span><span class="pal-hint">' + esc2(it.hint || it.t.path || it.t.type.toUpperCase()) + '</span></div>';
    }).join('') : '<div class="pal-none">No matches — try a shorter term</div>';
    Array.prototype.forEach.call(document.querySelectorAll('.pal-item'), function (n) {
      n.addEventListener('click', function () { palRun(parseInt(n.getAttribute('data-i'))); });
      n.addEventListener('mousemove', function () { palHighlight(parseInt(n.getAttribute('data-i'))); });
    });
  }
  function palHighlight(i) {
    palSel = i;
    Array.prototype.forEach.call(document.querySelectorAll('.pal-item'), function (n, idx) {
      n.classList.toggle('on', idx === i);
    });
  }
  function palMove(d) {
    if (!palItems.length) return;
    palHighlight((palSel + d + palItems.length) % palItems.length);
    var n = document.querySelector('.pal-item.on');
    if (n) n.scrollIntoView({ block: 'nearest' });
  }
  function palRun(i) {
    var it = palItems[i]; if (!it) return;
    palClose(); buzz(8);
    if (it.kind === 'act') { it.a.run(); return; }
    if (typeof jumpTo === 'function') jumpTo(it.t.id, it.t.name, it.t.type);
  }
  window.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      palOpen ? palClose() : window.ogPalOpen();
    }
  });

  /* ────────────────────────────────────────────────────────────────
     Boot
     ──────────────────────────────────────────────────────────────── */
  function bootDash() {
    actLoad();
    renderExam(); renderStreak(); renderHeat(); renderResume();
    /* instant render from last scan, refresh follows when Drive answers */
    try {
      var c = JSON.parse(localStorage.getItem('og_dash_cache') || 'null');
      if (c) applyDashStats(c);
      else renderMastery(null);
    } catch (e) { renderMastery(null); }
    var sb = $id('dash-start'); if (sb) sb.onclick = function () { if (typeof goToDue === 'function') goToDue(); };
    var rb = $id('dash-random'); if (rb) rb.onclick = randomTopic;
    var pb = $id('dash-pal'); if (pb) pb.onclick = window.ogPalOpen;
    var hb = $id('hdr-pal-btn'); if (hb) hb.onclick = window.ogPalOpen;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootDash);
  else bootDash();

})();
