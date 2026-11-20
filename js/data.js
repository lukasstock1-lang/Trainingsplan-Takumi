// Stammdaten aus dem "Trainingsplan Takumi 74" (PDF).
// Der Plan ist jede Woche gleich – Ausfälle und Vertretungen werden
// als Ausnahmen für ein bestimmtes Datum gespeichert.
import { CONFIG } from './config.js';

export const STATE_VERSION = 1;

const HALLE = 'Friedenstraße 46, 74235 Erlenbach';
const TALSTRASSE = 'Talstraße 40, 74235 Erlenbach';

export const DEFAULT_TRAINERS = [
  { id: 'lena-staiger', name: 'Lena Staiger' },
  { id: 'florian-staiger', name: 'Florian Staiger' },
  { id: 'sarah-baumgaertner', name: 'Sarah Baumgärtner' },
  { id: 'djego-wabingga', name: 'Djego Wabingga' },
  { id: 'ruwantha-de-silva', name: 'Ruwantha de Silva' },
];

// weekday: 1 = Montag … 7 = Sonntag. Samstag/Sonntag werden als "Wochenende" angezeigt.
// start/end = null → Zeit "nach Vereinbarung".
export const DEFAULT_SESSIONS = [
  // MONTAG
  {
    id: 'mo-shoshin', weekday: 1, title: 'Takumi Shoshin Gruppe', audience: 'Ab 5 Jahren',
    start: '16:30', end: '18:00', location: HALLE,
    trainerIds: ['djego-wabingga', 'ruwantha-de-silva'],
  },
  {
    id: 'mo-nachwuchs', weekday: 1, title: 'Takumi Nachwuchskader', audience: 'Takumi Nachwuchskader',
    start: '17:00', end: '18:00', location: HALLE,
    trainerIds: ['sarah-baumgaertner'],
  },
  {
    id: 'mo-wettkampf-1', weekday: 1, title: 'Takumi Wettkampfkader', audience: 'Takumi Wettkampfkader 1',
    start: '18:00', end: '19:30', location: HALLE,
    trainerIds: ['lena-staiger'],
  },
  {
    id: 'mo-wettkampf-2', weekday: 1, title: 'Takumi Wettkampfkader', audience: 'Takumi Wettkampfkader 2',
    start: '19:00', end: '20:30', location: HALLE,
    trainerIds: ['lena-staiger'],
  },
  // MITTWOCH
  {
    id: 'mi-nachwuchs', weekday: 3, title: 'Takumi Nachwuchskader', audience: 'Takumi Nachwuchskader',
    start: '16:00', end: '17:30', location: HALLE,
    trainerIds: ['lena-staiger'],
  },
  {
    id: 'mi-wettkampf', weekday: 3, title: 'Takumi Wettkampfkader', audience: 'Takumi Wettkampfkader',
    start: '17:00', end: '19:00', location: HALLE,
    trainerIds: ['lena-staiger'],
  },
  {
    id: 'mi-athletik', weekday: 3, title: 'Takumi Athletikgruppe', audience: 'Takumi Athletikgruppe',
    start: '19:15', end: '20:15', location: TALSTRASSE,
    trainerIds: ['florian-staiger'],
  },
  // FREITAG
  {
    id: 'fr-landesstuetzpunkt', weekday: 5, title: 'KVBW Landesstützpunkt',
    audience: 'Takumi Wettkampfkader & KVBW Landeskaderathleten',
    start: '17:00', end: '19:00', location: HALLE,
    trainerIds: ['lena-staiger'],
  },
  {
    id: 'fr-team', weekday: 5, title: 'Takumi Teamtraining', audience: 'Takumi Teamtraining',
    start: '19:00', end: '20:00', location: HALLE,
    trainerIds: ['lena-staiger'],
  },
  // WOCHENENDE
  {
    id: 'we-wettkampftraining', weekday: 6, title: 'Wettkampftraining nach Vereinbarung',
    audience: 'Starter des kommenden Wettkampfes',
    start: null, end: null, timeText: 'Nach Vereinbarung', location: HALLE,
    trainerIds: ['lena-staiger'],
  },
];

export function createDefaultState() {
  return {
    version: STATE_VERSION,
    trainers: DEFAULT_TRAINERS.map((t) => ({ ...t })),
    sessions: DEFAULT_SESSIONS.map((s) => ({ ...s, trainerIds: [...s.trainerIds] })),
    // Ausnahmen je Termin, Schlüssel "<sessionId>@<YYYY-MM-DD>":
    // { canceled, reason, canceledAt, trainerIds }
    exceptions: {},
    // Protokoll der Absagen → daraus entstehen die Push-Nachrichten.
    events: [],
    lastEventId: 0,
    pin: CONFIG.demoPin,
  };
}
