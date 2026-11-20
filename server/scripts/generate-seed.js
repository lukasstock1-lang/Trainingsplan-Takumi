// Erzeugt server/migrations/0002_seed.sql aus dem Trainingsplan in js/data.js.
// Aufruf: node server/scripts/generate-seed.js
import { writeFileSync } from 'node:fs';
import { DEFAULT_SESSIONS, DEFAULT_TRAINERS } from '../../js/data.js';

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const lines = ['-- Startdaten aus dem Trainingsplan (PDF). Erzeugt von server/scripts/generate-seed.js'];
DEFAULT_TRAINERS.forEach((t, i) => lines.push(`INSERT INTO trainers (id, name, sort) VALUES (${q(t.id)}, ${q(t.name)}, ${i});`));
DEFAULT_SESSIONS.forEach((s, i) =>
  lines.push(
    `INSERT INTO sessions (id, weekday, title, audience, start_time, end_time, time_text, location, trainer_ids, sort) VALUES (${[
      q(s.id), s.weekday, q(s.title), q(s.audience), q(s.start), q(s.end), q(s.timeText), q(s.location), q(JSON.stringify(s.trainerIds)), i,
    ].join(', ')});`,
  ),
);
writeFileSync(new URL('../migrations/0002_seed.sql', import.meta.url), lines.join('\n') + '\n');
console.log(`Seed geschrieben: ${DEFAULT_TRAINERS.length} Trainer, ${DEFAULT_SESSIONS.length} Trainings`);
