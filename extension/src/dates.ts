// Google Calendar hands all-day events back as a bare date ("2026-09-27")
// rather than a datetime. `new Date("2026-09-27")` reads that as midnight
// *UTC*, which in any timezone west of Greenwich is the evening before — so
// a Sunday birthday used to render under Saturday at 5:00 PM. Every place
// that turns an event's start/end into a Date goes through here instead.
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

// Date-only values become local midnight of that calendar day; anything
// else is an absolute instant and parses as usual.
export function parseEventDate(value: string): Date {
  const match = DATE_ONLY.exec(value);
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(value);
}

export function isAllDay(event: { start: string }): boolean {
  return isDateOnly(event.start);
}

// "2026-09-27" for a local calendar day — the form Google uses for all-day
// start/end and the value an <input type="date"> reads and writes.
export function toDateValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(dateValue: string, days: number): string {
  const d = parseEventDate(dateValue);
  return toDateValue(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}
