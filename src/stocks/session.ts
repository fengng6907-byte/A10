export type MarketSession = 'REGULAR' | 'PREMARKET' | 'AFTER_HOURS' | 'CLOSED';
const nyParts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function parts(at: Date) { const p = Object.fromEntries(nyParts.formatToParts(at).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, year: Number(p.year), month: Number(p.month), day: Number(p.day), weekday: p.weekday, minutes: Number(p.hour) * 60 + Number(p.minute) }; }
function iso(year: number, month: number, day: number) { return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }
function weekday(year: number, month: number, day: number) { return new Date(Date.UTC(year, month - 1, day)).getUTCDay(); }
function nthWeekday(year: number, month: number, dayOfWeek: number, nth: number) { const first = weekday(year, month, 1); return 1 + (dayOfWeek - first + 7) % 7 + (nth - 1) * 7; }
function lastWeekday(year: number, month: number, dayOfWeek: number) { const last = new Date(Date.UTC(year, month, 0)).getUTCDate(); return last - (weekday(year, month, last) - dayOfWeek + 7) % 7; }
function observed(year: number, month: number, day: number, saturdayFriday = true) {
  const w = weekday(year, month, day);
  return iso(year, month, w === 0 ? day + 1 : w === 6 && saturdayFriday ? day - 1 : day);
}
function easter(year: number) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k + 700) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451), month = Math.floor((h + l - 7 * m + 114) / 31);
  return { month, day: ((h + l - 7 * m + 114) % 31) + 1 };
}
export function marketHolidays(year: number): Set<string> {
  const e = easter(year), goodFriday = new Date(Date.UTC(year, e.month - 1, e.day - 2));
  return new Set([
    observed(year, 1, 1, false), iso(year, 1, nthWeekday(year, 1, 1, 3)), iso(year, 2, nthWeekday(year, 2, 1, 3)),
    goodFriday.toISOString().slice(0, 10), iso(year, 5, lastWeekday(year, 5, 1)), observed(year, 6, 19),
    observed(year, 7, 4), iso(year, 9, nthWeekday(year, 9, 1, 1)), iso(year, 11, nthWeekday(year, 11, 4, 4)), observed(year, 12, 25)
  ]);
}
function earlyClose(date: string, year: number) {
  const thanksgiving = iso(year, 11, nthWeekday(year, 11, 4, 4));
  const thanksgivingNext = new Date(Date.parse(`${thanksgiving}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  if (date === thanksgivingNext) return true;
  const christmasEve = iso(year, 12, 24);
  if (date === christmasEve && weekday(year, 12, 24) >= 1 && weekday(year, 12, 24) <= 5) return true;
  const dayBeforeJuly = iso(year, 7, 3);
  return date === dayBeforeJuly && weekday(year, 7, 3) >= 1 && weekday(year, 7, 3) <= 5;
}
export function marketSession(at: Date) {
  const p = parts(at), weekend = p.weekday === 'Sat' || p.weekday === 'Sun';
  const holiday = marketHolidays(p.year).has(p.date);
  const closeMinutes = earlyClose(p.date, p.year) ? 13 * 60 : 16 * 60;
  let session: MarketSession = 'CLOSED';
  if (!weekend && !holiday) {
    if (p.minutes >= 9 * 60 + 30 && p.minutes < closeMinutes) session = 'REGULAR';
    else if (p.minutes >= 4 * 60 && p.minutes < 9 * 60 + 30) session = 'PREMARKET';
    else if (p.minutes >= closeMinutes && p.minutes < 20 * 60) session = 'AFTER_HOURS';
  }
  return { session, exchangeDate: p.date, localMinutes: p.minutes, holiday, earlyClose: !holiday && earlyClose(p.date, p.year), timeZone: 'America/New_York' as const };
}
