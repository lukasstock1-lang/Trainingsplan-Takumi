// Takumi 74 – Trainingsplan
// Einstiegspunkt: Ansichten rendern und Benutzeraktionen verarbeiten.
import { CONFIG } from './config.js';
import { store, TAB_ID } from './store.js';
import { icon, logo } from './icons.js';
import { addDays, fmt, isoWeek, relativeDay, sameDay, startOfWeek } from './dates.js';
import {
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  groupList,
  isWeekend,
  nextOccurrence,
  occDateLabel,
  occurrenceByKey,
  occurrencesForWeek,
  timeLabel,
  trainerNames,
} from './schedule.js';
import { isIos, isStandalone, notifier, registerServiceWorker, subscribeServerPush } from './notify.js';

const $app = document.getElementById('app');
const $dialog = document.getElementById('dialog');
const $toasts = document.getElementById('toasts');

const ui = {
  view: store.device.role ? 'schedule' : 'welcome', // welcome | pin | groups | schedule | settings
  weekOffset: 0,
  addingTrainerFor: null, // Termin, bei dem gerade ein weiterer Trainer gewählt wird
  editingTrainerId: null, // Trainer, der gerade umbenannt wird
  pinError: false,
  groupsOnboarding: false,
};

let seenEventId = store.device.seenEventId || 0;
let renderPending = false;

// ---------------------------------------------------------------------------
// Helfer
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const isTrainer = () => store.device.role === 'trainer';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function isVisible(session) {
  if (isTrainer()) return true;
  const groups = store.device.groups || [];
  return groups.length === 0 || groups.includes(session.title);
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('');
}

function avatarHue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function mapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function isTyping() {
  const el = document.activeElement;
  return !!el && $app.contains(el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

// ---------------------------------------------------------------------------
// Toasts & Dialoge
// ---------------------------------------------------------------------------

function toast(html, type = 'info', ms = 4000) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', 'status');
  el.innerHTML = html;
  // Höchstens zwei Meldungen gleichzeitig zeigen
  [...$toasts.children].slice(0, -1).forEach((old) => old.remove());
  $toasts.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// Öffnet ein Bottom-Sheet. Löst mit { value, form } auf, oder null bei Abbruch.
function openDialog(html) {
  return new Promise((resolve) => {
    let done = false;
    $dialog.innerHTML = `<form class="sheet" method="dialog" novalidate>${html}</form>`;
    const form = $dialog.querySelector('form');

    const finish = (value) => {
      if (done) return;
      done = true;
      const data = value ? Object.fromEntries(new FormData(form)) : null;
      $dialog.close();
      resolve(value ? { value, form: data } : null);
    };

    $dialog.onclick = (e) => {
      if (e.target === $dialog) return finish(null); // Klick auf den Hintergrund
      const fill = e.target.closest('[data-fill]');
      if (fill) {
        const input = form.elements[fill.dataset.fill];
        input.value = fill.dataset.value;
        input.focus();
        return;
      }
      const btn = e.target.closest('[data-close]');
      if (btn) {
        e.preventDefault();
        finish(btn.dataset.close === 'cancel' ? null : btn.dataset.close);
      }
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const primary = form.querySelector('[data-primary]');
      if (primary) finish(primary.dataset.close);
    };
    $dialog.oncancel = (e) => {
      e.preventDefault();
      finish(null);
    };
    $dialog.showModal();
  });
}

// ---------------------------------------------------------------------------
// Push-Benachrichtigungen bei Absagen
// ---------------------------------------------------------------------------

function cancellationMessage(occ) {
  const s = occ.session;
  return {
    title: '❌ Training fällt aus',
    body: `${s.title}\n${occDateLabel(occ)} · ${timeLabel(s)}${occ.reason ? `\nGrund: ${occ.reason}` : ''}`,
    tag: occ.key,
  };
}

// Prüft, ob neue Absagen eingegangen sind (eigener Tab, anderer Tab oder später: Server).
function handleNewEvents({ initial = false } = {}) {
  const events = (store.state.events || []).filter((ev) => ev.id > seenEventId);
  if (!events.length) return;
  seenEventId = Math.max(...events.map((ev) => ev.id));
  store.setDevice({ seenEventId: Math.max(seenEventId, store.device.seenEventId || 0) }, { silent: true });

  const relevant = events
    .map((ev) => ({ ev, occ: occurrenceByKey(store.state, ev.key) }))
    .filter(({ occ }) => occ && occ.canceled && !occ.isPast && isVisible(occ.session));
  if (!relevant.length || !store.device.role) return;

  if (initial) {
    const n = relevant.length;
    toast(`${icon('alert')}<span>${n === 1 ? 'Ein Training wurde' : `${n} Trainings wurden`} abgesagt – siehe rot markierte Termine.</span>`, 'bad', 6000);
    return;
  }

  for (const { ev, occ } of relevant) {
    const msg = cancellationMessage(occ);
    if (ev.origin !== TAB_ID) {
      toast(`${icon('alert')}<span><strong>Training fällt aus</strong><br>${esc(occ.session.title)} · ${esc(occDateLabel(occ))}</span>`, 'bad', 7000);
    }
    if (store.device.notify) notifier.show(msg);
  }
}

async function enableNotifications() {
  if (!notifier.supported) {
    toast(
      isIos() && !isStandalone()
        ? 'Auf dem iPhone: Erst über „Teilen → Zum Home-Bildschirm“ installieren und die App dann von dort öffnen.'
        : 'Dieser Browser unterstützt leider keine Benachrichtigungen.',
      'info',
      7000,
    );
    return;
  }
  const permission = await notifier.request();
  if (permission === 'granted') {
    store.setDevice({ notify: true });
    subscribeServerPush(store.device.groups).catch(() => {});
    toast(`${icon('check')}<span>Benachrichtigungen sind aktiv.</span>`, 'ok');
    notifier.show({
      title: 'Takumi 74',
      body: 'Super! Du bekommst ab jetzt eine Nachricht, wenn ein Training ausfällt.',
      tag: 'welcome',
    });
  } else if (permission === 'denied') {
    toast('Benachrichtigungen sind blockiert. Du kannst sie in den Browser-Einstellungen erlauben.', 'bad', 7000);
  }
}

// ---------------------------------------------------------------------------
// Ansichten
// ---------------------------------------------------------------------------

function viewWelcome() {
  return `
  <main class="welcome">
    <div class="welcome-logo">${logo()}</div>
    <h1 class="welcome-title">Trainingsplan<span>Takumi 74</span></h1>
    <p class="welcome-question">Wer bist du?</p>
    <div class="role-buttons">
      <button class="role-btn" data-action="choose-member">
        <span class="role-emoji" aria-hidden="true">👨‍👩‍👧</span>
        <span class="role-text"><strong>Eltern &amp; Kinder</strong><small>Trainingsplan ansehen und bei Ausfall benachrichtigt werden</small></span>
        ${icon('chevR', 'role-chev')}
      </button>
      <button class="role-btn" data-action="choose-trainer">
        <span class="role-emoji" aria-hidden="true">🥋</span>
        <span class="role-text"><strong>Trainer</strong><small>Trainings absagen und Trainer einteilen</small></span>
        ${icon('chevR', 'role-chev')}
      </button>
    </div>
  </main>`;
}

function viewPin() {
  const showDemoPin = String(store.state.pin) === CONFIG.demoPin;
  return `
  <main class="narrow">
    <button class="link-btn back-btn" data-action="pin-back">${icon('back')} Zurück</button>
    <div class="pin-head">
      <div class="pin-icon">${icon('lock')}</div>
      <h1>Trainer-Zugang</h1>
      <p class="muted">Bitte gib die Trainer-PIN ein.</p>
    </div>
    <form data-form="pin" class="pin-form" autocomplete="off">
      <input class="pin-input ${ui.pinError ? 'has-error' : ''}" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" aria-label="PIN" autocomplete="off" required>
      ${ui.pinError ? '<p class="error-text">Falsche PIN – bitte nochmal versuchen.</p>' : ''}
      <button class="btn btn-primary btn-block" type="submit">Anmelden</button>
    </form>
    ${showDemoPin ? `<p class="hint center">Demo-PIN: <strong>${esc(CONFIG.demoPin)}</strong></p>` : ''}
  </main>`;
}

function groupChips() {
  const selected = store.device.groups || [];
  const all = selected.length === 0;
  return `
  <div class="group-chips">
    <button class="group-chip ${all ? 'is-on' : ''}" data-action="groups-all" aria-pressed="${all}">
      <span class="group-check">${icon('check')}</span>
      <span><strong>Alle Gruppen</strong><small>Ganzer Trainingsplan</small></span>
    </button>
    ${groupList(store.state)
      .map(({ title, days }) => {
        const on = selected.includes(title);
        return `
        <button class="group-chip ${on ? 'is-on' : ''}" data-action="toggle-group" data-group="${esc(title)}" aria-pressed="${on}">
          <span class="group-check">${icon('check')}</span>
          <span><strong>${esc(title)}</strong><small>${esc(days.join(' · '))}</small></span>
        </button>`;
      })
      .join('')}
  </div>`;
}

function viewGroups() {
  return `
  <main class="narrow">
    <div class="onboarding-head">
      <p class="step">Fast geschafft!</p>
      <h1>Welche Gruppen möchtest du sehen?</h1>
      <p class="muted">Du kannst mehrere auswählen und das später in den Einstellungen ändern.</p>
    </div>
    ${groupChips()}
    <div class="sticky-bottom">
      <button class="btn btn-primary btn-block" data-action="groups-done">Weiter</button>
    </div>
  </main>`;
}

function topbar() {
  const trainer = isTrainer();
  return `
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        ${logo()}
        <div class="brand-text"><strong>Takumi 74</strong><span>Trainingsplan</span></div>
      </div>
      <div class="topbar-actions">
        <span class="role-chip ${trainer ? 'is-trainer' : ''}">${trainer ? '🥋 Trainer' : 'Eltern &amp; Kinder'}</span>
        <button class="icon-btn" data-action="open-settings" aria-label="Einstellungen">${icon('settings')}</button>
      </div>
    </div>
  </header>`;
}

function notifyBanner() {
  const d = store.device;
  if (d.hideNotifyBanner) return '';
  if (d.notify && notifier.permission === 'granted') return '';

  if (!notifier.supported) {
    if (!(isIos() && !isStandalone())) return '';
    return `
    <div class="banner">
      <div class="banner-icon">${icon('bell')}</div>
      <div class="banner-text"><strong>Benachrichtigungen auf dem iPhone</strong><span>Tippe auf „Teilen“ → „Zum Home-Bildschirm“ und öffne die App dann von dort.</span></div>
      <button class="icon-btn sm" data-action="hide-banner" aria-label="Hinweis ausblenden">${icon('x')}</button>
    </div>`;
  }
  if (notifier.permission === 'denied') {
    return `
    <div class="banner">
      <div class="banner-icon">${icon('bell')}</div>
      <div class="banner-text"><strong>Benachrichtigungen blockiert</strong><span>Erlaube sie in den Browser-Einstellungen, um bei Ausfällen informiert zu werden.</span></div>
      <button class="icon-btn sm" data-action="hide-banner" aria-label="Hinweis ausblenden">${icon('x')}</button>
    </div>`;
  }
  return `
  <div class="banner">
    <div class="banner-icon">${icon('bell')}</div>
    <div class="banner-text"><strong>Nichts mehr verpassen!</strong><span>Bekomme sofort eine Nachricht, wenn ein Training ausfällt.</span></div>
    <div class="banner-actions">
      <button class="btn btn-primary btn-sm" data-action="enable-notify">Aktivieren</button>
      <button class="icon-btn sm" data-action="hide-banner" aria-label="Hinweis ausblenden">${icon('x')}</button>
    </div>
  </div>`;
}

function nextTrainingCard() {
  const occ = nextOccurrence(store.state, isVisible);
  if (!occ) return '';
  const s = occ.session;
  const when = relativeDay(occ.day);
  const running = !occ.canceled && new Date() >= occ.start;
  return `
  <section class="next ${occ.canceled ? 'is-canceled' : 'is-ok'}" aria-label="Nächstes Training">
    <div class="next-status" aria-hidden="true">${icon(occ.canceled ? 'x' : 'check')}</div>
    <div class="next-body">
      <span class="next-label">Dein nächstes Training</span>
      <strong class="next-title">${esc(s.title)}</strong>
      <span class="next-when">${esc(when)} · ${esc(timeLabel(s))}</span>
      <span class="next-verdict">${occ.canceled ? `Fällt aus${occ.reason ? ` – ${esc(occ.reason)}` : ''}` : running ? 'Läuft gerade' : 'Findet statt'}</span>
    </div>
  </section>`;
}

function weekNav(weekStart) {
  const end = addDays(weekStart, 6);
  const o = ui.weekOffset;
  const label =
    o === 0 ? 'Diese Woche' : o === 1 ? 'Nächste Woche' : o === -1 ? 'Letzte Woche' : o > 1 ? `In ${o} Wochen` : `Vor ${-o} Wochen`;
  return `
  <div class="week-nav">
    <button class="icon-btn" data-action="week" data-delta="-1" aria-label="Vorherige Woche">${icon('chevL')}</button>
    <div class="week-label">
      <strong>${label}</strong>
      <span>KW ${isoWeek(weekStart)} · ${fmt.date(weekStart)} – ${fmt.date(end)}${end.getFullYear()}</span>
    </div>
    <button class="icon-btn" data-action="week" data-delta="1" aria-label="Nächste Woche">${icon('chevR')}</button>
  </div>
  ${o !== 0 ? `<div class="center"><button class="link-btn" data-action="week-today">Zurück zu dieser Woche</button></div>` : ''}`;
}

const sectionId = (weekday) => `tag-${isWeekend(weekday) ? 'we' : weekday}`;

function weekStrip(weekStart, occs) {
  const today = new Date();
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  return `
  <nav class="week-strip" aria-label="Wochenübersicht">
    ${days
      .map((d, i) => {
        const weekday = i + 1;
        const dayOccs = occs.filter((o) => o.session.weekday === weekday);
        const dots = dayOccs.map((o) => `<i class="dot ${o.canceled ? 'bad' : 'ok'}"></i>`).join('');
        const has = dayOccs.length > 0 || (weekday === 7 && occs.some((o) => o.session.weekday === 6));
        return `
        <button class="ws-day ${sameDay(d, today) ? 'is-today' : ''} ${has ? '' : 'is-empty'}" ${has ? `data-action="scroll-day" data-target="${sectionId(weekday)}"` : 'disabled'} aria-label="${fmt.dayLong(d)}, ${fmt.date(d)}">
          <span class="ws-name">${WEEKDAY_SHORT[weekday]}</span>
          <span class="ws-num">${d.getDate()}</span>
          <span class="ws-dots">${dots}</span>
        </button>`;
      })
      .join('')}
  </nav>
  <div class="legend"><span><i class="dot ok"></i> Findet statt</span><span><i class="dot bad"></i> Fällt aus</span></div>`;
}

function statusBadge(occ) {
  if (occ.canceled) return `<span class="badge badge-bad">${icon('x')} ${occ.isPast ? 'Fiel aus' : 'Fällt aus'}</span>`;
  return `<span class="badge badge-ok">${icon('check')} ${occ.isPast ? 'Fand statt' : 'Findet statt'}</span>`;
}

function trainerSelect(occ, index, value, { removable = false, placeholder = false } = {}) {
  const trainers = store.state.trainers;
  const taken = occ.trainerIds.filter((id, i) => i !== index);
  return `
  <select class="select" data-change="trainer" data-key="${occ.key}" data-index="${index}" aria-label="Trainer ${index + 1}">
    ${placeholder ? '<option value="" selected disabled>Trainer wählen …</option>' : ''}
    ${trainers
      .filter((t) => !taken.includes(t.id))
      .map((t) => `<option value="${t.id}" ${t.id === value ? 'selected' : ''}>${esc(t.name)}</option>`)
      .join('')}
    ${removable ? '<option value="__remove">— Trainer entfernen —</option>' : ''}
  </select>`;
}

function trainerControls(occ) {
  const ids = occ.trainerIds;
  const adding = ui.addingTrainerFor === occ.key;
  const canAdd = !adding && ids.length < 3 && ids.length < store.state.trainers.length;
  const standard = trainerNames(store.state, occ.session.trainerIds);
  return `
  <div class="card-controls">
    <div class="control-label">Trainer ${occ.substitute ? '<span class="pill pill-sub">Vertretung</span>' : ''}</div>
    <div class="selects">
      ${ids.map((id, i) => trainerSelect(occ, i, id, { removable: ids.length > 1 })).join('')}
      ${ids.length === 0 ? trainerSelect(occ, 0, null, { placeholder: true }) : ''}
      ${adding ? trainerSelect(occ, ids.length, null, { placeholder: true }) : ''}
    </div>
    <div class="control-links">
      ${canAdd && ids.length > 0 ? `<button class="link-btn" data-action="add-trainer-slot" data-key="${occ.key}">${icon('plus')} Weiterer Trainer</button>` : ''}
      ${adding ? `<button class="link-btn" data-action="cancel-trainer-slot">Abbrechen</button>` : ''}
      ${occ.substitute ? `<button class="link-btn" data-action="reset-trainer" data-key="${occ.key}">${icon('refresh')} Standard: ${esc(standard)}</button>` : ''}
    </div>
    ${
      occ.canceled
        ? `<button class="btn btn-ok btn-block" data-action="reinstate" data-key="${occ.key}">${icon('check')} Findet doch statt</button>`
        : `<button class="btn btn-danger btn-block" data-action="cancel" data-key="${occ.key}">${icon('x')} Training absagen</button>`
    }
  </div>`;
}

function card(occ) {
  const s = occ.session;
  const cls = ['card', occ.canceled ? 'is-canceled' : 'is-ok', occ.isPast && 'is-past'].filter(Boolean).join(' ');
  const showControls = isTrainer() && !occ.isPast;
  return `
  <article class="${cls}">
    <div class="card-head">
      <span class="card-time">${icon('clock')}<span>${esc(timeLabel(s))}</span></span>
      ${statusBadge(occ)}
    </div>
    <h3 class="card-title">${esc(s.title)}</h3>
    ${occ.canceled && occ.reason ? `<p class="card-reason">${icon('info')}<span>${esc(occ.reason)}</span></p>` : ''}
    <ul class="card-meta">
      <li>${icon('users')}<span>${esc(s.audience)}</span></li>
      ${
        showControls
          ? ''
          : `<li>${icon('user')}<span>${esc(trainerNames(store.state, occ.trainerIds))}${occ.substitute ? ' <span class="pill pill-sub">Vertretung</span>' : ''}</span></li>`
      }
      <li>${icon('pin')}<a href="${mapsUrl(s.location)}" target="_blank" rel="noopener">${esc(s.location)}</a></li>
    </ul>
    ${showControls ? trainerControls(occ) : ''}
  </article>`;
}

function daySections(weekStart, occs) {
  const sections = new Map();
  for (const occ of occs) {
    const id = sectionId(occ.session.weekday);
    if (!sections.has(id)) sections.set(id, { weekday: occ.session.weekday, occs: [] });
    sections.get(id).occs.push(occ);
  }
  if (!sections.size) {
    return `<div class="empty">${icon('info')}<p>In dieser Woche gibt es kein Training für deine Gruppen.</p></div>`;
  }
  const today = new Date();
  return `
  <div class="days">
    ${[...sections]
      .sort((a, b) => a[1].weekday - b[1].weekday)
      .map(([id, { weekday, occs: list }]) => {
        const day = addDays(weekStart, weekday - 1);
        const weekend = isWeekend(weekday);
        const title = weekend ? 'Wochenende' : WEEKDAY_LONG[weekday];
        const dateText = weekend ? `${fmt.date(addDays(weekStart, 5))} – ${fmt.date(addDays(weekStart, 6))}` : fmt.date(day);
        const isToday = weekend ? today >= addDays(weekStart, 5) && today < addDays(weekStart, 7) : sameDay(day, today);
        return `
        <section class="day ${isToday ? 'is-today' : ''}" id="${id}">
          <h2 class="day-title"><span>${title}</span><span class="day-date">${dateText}</span>${isToday ? '<span class="pill pill-today">Heute</span>' : ''}</h2>
          <div class="cards">${list.map(card).join('')}</div>
        </section>`;
      })
      .join('')}
  </div>`;
}

function viewSchedule() {
  const weekStart = addDays(startOfWeek(new Date()), ui.weekOffset * 7);
  const occs = occurrencesForWeek(store.state, weekStart).filter((o) => isVisible(o.session));
  const intro = isTrainer()
    ? `<div class="trainer-hint">${icon('info')}<span><strong>Absagen</strong> schickt sofort eine Push-Nachricht an Eltern &amp; Kinder. Den Trainer änderst du im Auswahlfeld.</span></div>`
    : `${notifyBanner()}${nextTrainingCard()}`;
  return `
  ${topbar()}
  <main class="page">
    <div class="page-top">
      ${intro}
      ${weekNav(weekStart)}
      ${weekStrip(weekStart, occs)}
    </div>
    ${daySections(weekStart, occs)}
  </main>`;
}

function notifySettings() {
  const on = store.device.notify && notifier.permission === 'granted';
  let status;
  let actions;
  if (!notifier.supported) {
    status = isIos() && !isStandalone() ? 'Auf dem iPhone erst „Zum Home-Bildschirm“ hinzufügen.' : 'Von diesem Browser nicht unterstützt.';
    actions = '';
  } else if (notifier.permission === 'denied') {
    status = 'Im Browser blockiert – bitte in den Browser-Einstellungen erlauben.';
    actions = '';
  } else if (on) {
    status = 'Aktiv – du wirst benachrichtigt, wenn ein Training ausfällt.';
    actions = `
      <button class="btn btn-ghost btn-sm" data-action="test-notify">Test senden</button>
      <button class="btn btn-ghost btn-sm" data-action="disable-notify">Ausschalten</button>`;
  } else {
    status = 'Aus';
    actions = `<button class="btn btn-primary btn-sm" data-action="enable-notify">Aktivieren</button>`;
  }
  return `
  <section class="settings-section">
    <h2>Benachrichtigungen</h2>
    <div class="panel">
      <div class="panel-row">
        <div class="row-icon ${on ? 'is-on' : ''}">${icon('bell')}</div>
        <div class="row-main"><strong>Push bei Ausfall</strong><span>${status}</span></div>
      </div>
      ${actions ? `<div class="panel-actions">${actions}</div>` : ''}
    </div>
  </section>`;
}

function trainerRow(t) {
  const count = store.assignmentCount(t.id);
  if (ui.editingTrainerId === t.id) {
    return `
    <li class="panel-row">
      <form class="inline-form" data-form="rename-trainer" data-id="${t.id}">
        <input class="input" name="name" value="${esc(t.name)}" maxlength="40" aria-label="Name" required>
        <button class="btn btn-primary btn-sm" type="submit">Speichern</button>
        <button class="btn btn-ghost btn-sm" type="button" data-action="cancel-edit-trainer">Abbrechen</button>
      </form>
    </li>`;
  }
  return `
  <li class="panel-row">
    <span class="avatar" style="--hue:${avatarHue(t.name)}">${esc(initials(t.name))}</span>
    <div class="row-main"><strong>${esc(t.name)}</strong><span>${count ? plural(count, 'Training pro Woche', 'Trainings pro Woche') : 'Keinem Training zugeordnet'}</span></div>
    <button class="icon-btn sm" data-action="edit-trainer" data-id="${t.id}" aria-label="${esc(t.name)} umbenennen">${icon('edit')}</button>
    <button class="icon-btn sm danger" data-action="delete-trainer" data-id="${t.id}" aria-label="${esc(t.name)} entfernen">${icon('trash')}</button>
  </li>`;
}

function viewSettings() {
  const trainer = isTrainer();
  const trainerSections = trainer
    ? `
    <section class="settings-section">
      <h2>Trainer (${store.state.trainers.length})</h2>
      <ul class="panel">${store.state.trainers.map(trainerRow).join('')}</ul>
      <form class="add-form" data-form="add-trainer" autocomplete="off">
        <input class="input" name="name" placeholder="Name des neuen Trainers" maxlength="40" aria-label="Name des neuen Trainers" required>
        <button class="btn btn-primary" type="submit">${icon('plus')} Anlegen</button>
      </form>
      <p class="hint">Neue Trainer erscheinen sofort im Auswahlfeld bei jedem Training.</p>
    </section>`
    : `
    <section class="settings-section">
      <h2>Meine Gruppen</h2>
      <p class="hint">Nur diese Trainings werden angezeigt und gemeldet.</p>
      ${groupChips()}
    </section>`;

  const accessSection = trainer
    ? `
    <section class="settings-section">
      <h2>Zugang</h2>
      <form class="panel" data-form="change-pin" autocomplete="off">
        <div class="panel-row">
          <div class="row-icon">${icon('lock')}</div>
          <div class="row-main"><strong>Trainer-PIN ändern</strong><span>4–8 Ziffern</span></div>
        </div>
        <div class="panel-actions">
          <input class="input" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" placeholder="Neue PIN" aria-label="Neue PIN" required>
          <button class="btn btn-primary btn-sm" type="submit">Speichern</button>
        </div>
      </form>
      <button class="btn btn-ghost btn-block" data-action="logout">${icon('logout')} Abmelden</button>
    </section>
    <section class="settings-section">
      <h2>Demo</h2>
      <div class="panel info-panel">
        <p>${icon('info')}<span><strong>Prototyp:</strong> Alle Daten werden aktuell nur auf diesem Gerät gespeichert. Für echte Push-Nachrichten an alle Eltern wird noch ein Server angebunden.</span></p>
      </div>
      <button class="btn btn-ghost btn-block" data-action="reset-demo">${icon('refresh')} Demo-Daten zurücksetzen</button>
    </section>`
    : `
    <section class="settings-section">
      <h2>Zugang</h2>
      <button class="btn btn-ghost btn-block" data-action="to-trainer">${icon('lock')} Zum Trainer-Zugang</button>
      <button class="btn btn-ghost btn-block" data-action="logout">${icon('logout')} Zurück zum Start</button>
    </section>`;

  return `
  <header class="topbar">
    <div class="topbar-inner">
      <button class="link-btn back-btn" data-action="close-settings">${icon('back')} Zurück</button>
      <strong class="topbar-title">Einstellungen</strong>
      <span class="topbar-spacer"></span>
    </div>
  </header>
  <main class="narrow settings">
    ${trainerSections}
    ${notifySettings()}
    ${accessSection}
  </main>`;
}

function render() {
  if (!store.device.role && ['schedule', 'settings'].includes(ui.view)) ui.view = 'welcome';
  const views = { welcome: viewWelcome, pin: viewPin, groups: viewGroups, schedule: viewSchedule, settings: viewSettings };
  $app.innerHTML = (views[ui.view] || viewWelcome)();
  document.documentElement.dataset.view = ui.view;
}

function go(view) {
  ui.view = view;
  render();
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Abläufe für Trainer
// ---------------------------------------------------------------------------

async function cancelFlow(key) {
  const occ = occurrenceByKey(store.state, key);
  if (!occ) return;
  const reasons = ['Krankheit', 'Halle gesperrt', 'Ferien', 'Feiertag', 'Wettkampf'];
  const res = await openDialog(`
    <h2 class="sheet-title">Training absagen?</h2>
    <div class="sheet-occ">
      <strong>${esc(occ.session.title)}</strong>
      <span>${esc(occDateLabel(occ))} · ${esc(timeLabel(occ.session))}</span>
    </div>
    <label class="field">
      <span>Grund (optional)</span>
      <input class="input" name="reason" maxlength="80" placeholder="z. B. Halle gesperrt" autocomplete="off">
    </label>
    <div class="reason-chips">
      ${reasons.map((r) => `<button type="button" class="chip" data-fill="reason" data-value="${r}">${r}</button>`).join('')}
    </div>
    <p class="sheet-note">${icon('bell')}<span>Alle Eltern &amp; Kinder bekommen <strong>sofort eine Push-Nachricht</strong>.</span></p>
    <div class="sheet-actions">
      <button type="button" class="btn btn-ghost" data-close="cancel">Zurück</button>
      <button type="submit" class="btn btn-danger" data-close="confirm" data-primary>Absagen &amp; benachrichtigen</button>
    </div>`);
  if (res?.value !== 'confirm') return;
  await store.cancelTraining(key, res.form.reason || '');
  toast(`${icon('check')}<span><strong>Training abgesagt</strong><br>Push-Nachricht an Eltern &amp; Kinder wurde gesendet.</span>`, 'ok', 5000);
}

async function reinstateFlow(key) {
  await store.reinstateTraining(key);
  toast(`${icon('check')}<span>Training findet wieder statt.</span>`, 'ok');
}

async function trainerChangeFlow(select) {
  const key = select.dataset.key;
  const index = Number(select.dataset.index);
  const occ = occurrenceByKey(store.state, key);
  if (!occ) return;

  const ids = [...occ.trainerIds];
  if (select.value === '__remove') ids.splice(index, 1);
  else ids[index] = select.value;
  const newIds = [...new Set(ids.filter(Boolean))];

  if (!newIds.length || newIds.join() === occ.trainerIds.join()) {
    render();
    return;
  }

  const date = occDateLabel(occ);
  const res = await openDialog(`
    <h2 class="sheet-title">Trainer ändern</h2>
    <div class="sheet-occ">
      <strong>${esc(occ.session.title)}</strong>
      <span>${esc(trainerNames(store.state, occ.trainerIds))} → <b>${esc(trainerNames(store.state, newIds))}</b></span>
    </div>
    <p class="sheet-question">Für welche Termine soll das gelten?</p>
    <div class="choices">
      <button type="button" class="choice" data-close="once">
        <strong>Nur am ${esc(date)}</strong>
        <span>z. B. Vertretung bei Krankheit</span>
      </button>
      <button type="button" class="choice" data-close="weekly">
        <strong>Jede Woche</strong>
        <span>Dauerhafter Trainerwechsel ab sofort</span>
      </button>
    </div>
    <div class="sheet-actions single">
      <button type="button" class="btn btn-ghost" data-close="cancel">Abbrechen</button>
    </div>`);

  ui.addingTrainerFor = null;
  if (!res) {
    render(); // Auswahl zurücksetzen
    return;
  }
  await store.setTrainers(key, newIds, res.value);
  toast(
    `${icon('check')}<span>${res.value === 'weekly' ? 'Trainer dauerhaft geändert.' : `Vertretung für ${esc(date)} eingetragen.`}</span>`,
    'ok',
  );
}

async function deleteTrainerFlow(id) {
  const t = store.state.trainers.find((x) => x.id === id);
  if (!t) return;
  if (store.state.trainers.length <= 1) {
    toast('Mindestens ein Trainer muss bestehen bleiben.', 'bad');
    return;
  }
  const count = store.assignmentCount(id);
  const others = store.state.trainers.filter((x) => x.id !== id);
  const res = await openDialog(`
    <h2 class="sheet-title">${esc(t.name)} entfernen?</h2>
    ${
      count
        ? `<p class="sheet-text">${esc(t.name)} ist noch für <strong>${plural(count, 'Training', 'Trainings')}</strong> pro Woche eingeteilt. Wer übernimmt?</p>
           <label class="field"><span>Nachfolger</span>
             <select class="select" name="replacement">
               ${others.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}
               <option value="">Niemand (Trainer offen lassen)</option>
             </select>
           </label>`
        : `<p class="sheet-text">${esc(t.name)} ist keinem Training zugeordnet.</p>`
    }
    <div class="sheet-actions">
      <button type="button" class="btn btn-ghost" data-close="cancel">Abbrechen</button>
      <button type="submit" class="btn btn-danger" data-close="confirm" data-primary>Entfernen</button>
    </div>`);
  if (res?.value !== 'confirm') return;
  await store.removeTrainer(id, res.form.replacement || null);
  toast(`${icon('check')}<span>${esc(t.name)} wurde entfernt.</span>`, 'ok');
}

async function resetDemoFlow() {
  const res = await openDialog(`
    <h2 class="sheet-title">Demo zurücksetzen?</h2>
    <p class="sheet-text">Alle Absagen, Vertretungen und Trainer-Änderungen werden gelöscht. Der ursprüngliche Trainingsplan wird wiederhergestellt.</p>
    <div class="sheet-actions">
      <button type="button" class="btn btn-ghost" data-close="cancel">Abbrechen</button>
      <button type="submit" class="btn btn-danger" data-close="confirm" data-primary>Zurücksetzen</button>
    </div>`);
  if (res?.value !== 'confirm') return;
  await store.resetDemo();
  toast(`${icon('check')}<span>Demo-Daten wurden zurückgesetzt.</span>`, 'ok');
}

// ---------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------

const actions = {
  'choose-member': () => {
    store.setRole('member');
    ui.groupsOnboarding = true;
    go('groups');
  },
  'choose-trainer': () => {
    ui.pinError = false;
    go('pin');
    $app.querySelector('.pin-input')?.focus();
  },
  'pin-back': () => go(store.device.role ? 'settings' : 'welcome'),
  'to-trainer': () => {
    ui.pinError = false;
    go('pin');
  },
  'groups-all': () => store.setDevice({ groups: [] }),
  'toggle-group': (el) => {
    const g = el.dataset.group;
    const groups = store.device.groups || [];
    store.setDevice({ groups: groups.includes(g) ? groups.filter((x) => x !== g) : [...groups, g] });
  },
  'groups-done': () => {
    ui.groupsOnboarding = false;
    go('schedule');
  },
  week: (el) => {
    ui.weekOffset += Number(el.dataset.delta);
    ui.addingTrainerFor = null;
    render();
  },
  'week-today': () => {
    ui.weekOffset = 0;
    render();
  },
  'scroll-day': (el) => document.getElementById(el.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  'open-settings': () => go('settings'),
  'close-settings': () => {
    ui.editingTrainerId = null;
    go('schedule');
  },
  'enable-notify': () => enableNotifications(),
  'disable-notify': () => store.setDevice({ notify: false }),
  'test-notify': async () => {
    const shown = await notifier.show({
      title: '❌ Training fällt aus',
      body: 'So sieht eine Benachrichtigung aus, wenn ein Training ausfällt.',
      tag: 'test',
    });
    if (!shown) toast('Benachrichtigung konnte nicht angezeigt werden.', 'bad');
  },
  'hide-banner': () => store.setDevice({ hideNotifyBanner: true }),
  cancel: (el) => cancelFlow(el.dataset.key),
  reinstate: (el) => reinstateFlow(el.dataset.key),
  'add-trainer-slot': (el) => {
    ui.addingTrainerFor = el.dataset.key;
    render();
  },
  'cancel-trainer-slot': () => {
    ui.addingTrainerFor = null;
    render();
  },
  'reset-trainer': async (el) => {
    await store.resetTrainers(el.dataset.key);
    toast(`${icon('check')}<span>Standard-Trainer wiederhergestellt.</span>`, 'ok');
  },
  'edit-trainer': (el) => {
    ui.editingTrainerId = el.dataset.id;
    render();
    const input = $app.querySelector('[data-form="rename-trainer"] input');
    input?.focus();
    input?.select();
  },
  'cancel-edit-trainer': () => {
    ui.editingTrainerId = null;
    render();
  },
  'delete-trainer': (el) => deleteTrainerFlow(el.dataset.id),
  'reset-demo': () => resetDemoFlow(),
  logout: () => {
    store.setRole(null);
    ui.weekOffset = 0;
    go('welcome');
  },
};

const forms = {
  pin: (form) => {
    const pin = form.elements.pin.value.trim();
    if (store.checkPin(pin)) {
      ui.pinError = false;
      store.setRole('trainer');
      go('schedule');
      toast(`${icon('check')}<span>Willkommen im Trainer-Zugang!</span>`, 'ok');
    } else {
      ui.pinError = true;
      render();
      $app.querySelector('.pin-input')?.focus();
    }
  },
  'add-trainer': async (form) => {
    const name = form.elements.name.value.trim();
    if (!name) return;
    if (store.state.trainers.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      toast(`${esc(name)} gibt es bereits.`, 'bad');
      return;
    }
    await store.addTrainer(name);
    toast(`${icon('check')}<span>${esc(name)} wurde angelegt.</span>`, 'ok');
  },
  'rename-trainer': async (form) => {
    const name = form.elements.name.value.trim();
    if (!name) return;
    ui.editingTrainerId = null;
    await store.renameTrainer(form.dataset.id, name);
  },
  'change-pin': async (form) => {
    const pin = form.elements.pin.value.trim();
    if (!/^\d{4,8}$/.test(pin)) {
      toast('Die PIN muss aus 4 bis 8 Ziffern bestehen.', 'bad');
      return;
    }
    await store.setPin(pin);
    form.reset();
    toast(`${icon('check')}<span>PIN wurde geändert.</span>`, 'ok');
  },
};

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  e.preventDefault();
  actions[el.dataset.action]?.(el, e);
});

$app.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  forms[form.dataset.form]?.(form);
});

$app.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change="trainer"]');
  if (el) trainerChangeFlow(el);
});

document.addEventListener('focusout', () => {
  if (!renderPending) return;
  setTimeout(() => {
    if (renderPending && !isTyping()) {
      renderPending = false;
      render();
    }
  }, 0);
});

store.subscribe((meta) => {
  // Änderungen aus anderen Tabs nicht mitten in eine Eingabe hinein rendern.
  if (meta.external && isTyping()) renderPending = true;
  else render();
  handleNewEvents();
});

// Seite regelmäßig aktualisieren, damit "Heute", "Läuft gerade" & Co. stimmen.
setInterval(() => {
  if (ui.view === 'schedule' && !isTyping() && !$dialog.open) render();
}, 60000);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

render();
handleNewEvents({ initial: true });
registerServiceWorker();
