// Macht aus dem wöchentlichen Plan konkrete Termine im Kalender.
import { addDays, dateKey, fmt, parseKey, sameDay, startOfDay, startOfWeek, withTime } from './dates.js';

export const WEEKDAY_SHORT = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
export const WEEKDAY_LONG = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

export const isWeekend = (weekday) => weekday >= 6;

export function buildOccurrence(state, session, day, now = new Date()) {
  const dk = dateKey(day);
  const key = `${session.id}@${dk}`;
  const ex = state.exceptions[key] || {};
  const flexible = !session.start;
  const start = flexible ? startOfDay(day) : withTime(day, session.start);
  // "Nach Vereinbarung" am Wochenende gilt bis Sonntagabend.
  const end = flexible ? addDays(startOfDay(day), session.weekday === 6 ? 2 : 1) : withTime(day, session.end);
  const today = startOfDay(now);

  return {
    key,
    session,
    day,
    dateKey: dk,
    flexible,
    canceled: !!ex.canceled,
    reason: ex.reason || '',
    trainerIds: ex.trainerIds || session.trainerIds,
    substitute: !!ex.trainerIds,
    locationId: ex.locationId || session.locationId,
    locationMoved: !!ex.locationId && ex.locationId !== session.locationId,
    start,
    end,
    isPast: now >= end,
    isToday: flexible ? today >= start && today < end : sameDay(day, now),
  };
}

export function occurrencesForWeek(state, weekStart, now = new Date()) {
  return state.sessions
    .map((s) => buildOccurrence(state, s, addDays(weekStart, s.weekday - 1), now))
    .sort((a, b) => a.start - b.start || a.session.weekday - b.session.weekday);
}

export function occurrenceByKey(state, key, now = new Date()) {
  const [id, dk] = key.split('@');
  const session = state.sessions.find((s) => s.id === id);
  return session && dk ? buildOccurrence(state, session, parseKey(dk), now) : null;
}

// Nächster Termin (noch nicht vorbei) mit fester Uhrzeit.
export function nextOccurrence(state, isVisible, now = new Date()) {
  for (let w = 0; w < 12; w++) {
    const weekStart = addDays(startOfWeek(now), w * 7);
    const next = occurrencesForWeek(state, weekStart, now).find(
      (o) => !o.isPast && !o.flexible && isVisible(o.session),
    );
    if (next) return next;
  }
  return null;
}

export function timeLabel(session) {
  return session.start ? `${session.start} – ${session.end} Uhr` : session.timeText || 'Nach Vereinbarung';
}

export function occDateLabel(occ) {
  if (occ.flexible && isWeekend(occ.session.weekday)) {
    return `Wochenende ${fmt.date(occ.day)} – ${fmt.date(addDays(occ.day, 1))}`;
  }
  return fmt.dayDate(occ.day);
}

// Ort eines Termins (Fallback: Standardort Erlenbach)
export function locationOf(state, id) {
  const list = state.locations || [];
  return list.find((l) => l.id === id) || list[0] || { id, label: id, address: id };
}

// Erste Woche, in der noch ein Training ansteht (0 = diese Woche, 1 = nächste …)
export function firstUpcomingWeek(state, isVisible, now = new Date()) {
  const thisWeek = occurrencesForWeek(state, startOfWeek(now), now);
  return thisWeek.some((o) => !o.isPast && isVisible(o.session)) ? 0 : 1;
}

export function trainerNames(state, ids) {
  const names = ids.map((id) => state.trainers.find((t) => t.id === id)?.name).filter(Boolean);
  return names.length ? names.join(' & ') : 'Trainer offen';
}

// Gruppen = eindeutige Trainingsnamen, mit den Tagen, an denen sie stattfinden.
export function groupList(state) {
  const map = new Map();
  for (const s of [...state.sessions].sort((a, b) => a.weekday - b.weekday)) {
    const day = isWeekend(s.weekday) ? 'Wochenende' : WEEKDAY_SHORT[s.weekday];
    if (!map.has(s.title)) map.set(s.title, []);
    const days = map.get(s.title);
    if (!days.includes(day)) days.push(day);
  }
  return [...map].map(([title, days]) => ({ title, days }));
}
