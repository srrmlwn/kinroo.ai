import type { CalendarEvent } from "../../src/lib/google-calendar";

// A family calendar as it looks from Friday 2026-09-25, 10:00 AM Pacific:
// two kids (Sahana, Sasha) with overlapping weekly activities, plus one
// all-day reminder. The weekly series are expanded to three weeks so "next"
// and "how often" questions have more than one occurrence to choose from.
export const REFERENCE_DATE = new Date("2026-09-25T10:00:00-07:00");
export const TIMEZONE = "America/Los_Angeles";

const SGA = "Seattle Gymnastics Academy - Ballard, 1415 NW 52nd St, Seattle, WA 98107, USA";
const BAMD = "Ballard Academy of Music and Dance, 2404 NW 80th St, Seattle, WA 98117, USA";
const DISCOVER = "Discover Gymnastics, 1418 NW 53rd St, Seattle, WA 98107, USA";

function weekly(
  idPrefix: string,
  title: string,
  firstDate: string,
  startTime: string,
  endTime: string,
  location?: string,
): CalendarEvent[] {
  return [0, 7, 14].map((offsetDays) => {
    const day = new Date(`${firstDate}T12:00:00-07:00`);
    day.setUTCDate(day.getUTCDate() + offsetDays);
    const date = day.toISOString().slice(0, 10);
    return {
      id: `${idPrefix}-${date.slice(5).replace("-", "")}`,
      title,
      start: `${date}T${startTime}:00-07:00`,
      end: `${date}T${endTime}:00-07:00`,
      ...(location ? { location } : {}),
    };
  });
}

export const EVENTS: CalendarEvent[] = [
  ...weekly("sahana-gym", "Sahana Gymnastics", "2026-09-25", "18:45", "19:45", SGA),
  ...weekly("sasha-hh", "Sasha - Hippity Hop", "2026-09-26", "09:00", "09:45", BAMD),
  { id: "stepone-0927", title: "Step one foods will ship on 1st", start: "2026-09-27", end: "2026-09-28" },
  ...weekly("sasha-gym", "Sasha Gymnastics", "2026-09-27", "09:00", "10:00"),
  ...weekly("sahana-hh", "Sahana - Hippity Hop", "2026-09-27", "09:45", "10:30", BAMD),
  ...weekly("sahana-swim", "Sahana swim at 6 30 pm", "2026-09-28", "18:30", "19:00"),
  ...weekly("sahana-ninja", "Sahana - Ninja", "2026-09-30", "17:45", "18:45", DISCOVER),
];

// All-day events carry a bare date; for range filtering treat it as that
// local day, the way Google Calendar does.
function startMs(event: CalendarEvent): number {
  return Date.parse(event.start.includes("T") ? event.start : `${event.start}T00:00:00-07:00`);
}
function endMs(event: CalendarEvent): number {
  return Date.parse(event.end.includes("T") ? event.end : `${event.end}T00:00:00-07:00`);
}

// Stands in for Google's events.list(singleEvents, orderBy=startTime):
// everything overlapping [timeMin, timeMax), in start order.
export function listEventsInRange(timeMin: string, timeMax: string): CalendarEvent[] {
  const min = Date.parse(timeMin);
  const max = Date.parse(timeMax);
  return EVENTS.filter((event) => endMs(event) > min && startMs(event) < max).sort(
    (a, b) => startMs(a) - startMs(b),
  );
}
