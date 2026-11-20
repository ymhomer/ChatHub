export const TXT_SEARCH_BYTES = 65536;

export function filenameTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (key: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === key)?.value;
  return `${part('year')}-${part('month')}-${part('day')}_${part('hour')}-${part('minute')}-${part('second')}`;
}

export function txtFilename(date = new Date()) {
  return filenameTimestamp(date) + '.txt';
}

export function normalizeTxtSearch(text: string) {
  return text.normalize('NFC').toLowerCase();
}
