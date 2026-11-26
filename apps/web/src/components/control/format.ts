const wholeNumber = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-GB", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export const utcClock = new Intl.DateTimeFormat("en-GB", {
  timeStyle: "medium",
  timeZone: "UTC",
});

export const utcDateTime = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

export const utcDate = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });

export function formatCount(value: number): string {
  return wholeNumber.format(value);
}

export function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : many}`;
}

export function formatSpan(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, "0")} min`;
  if (minutes > 0) return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
  return `${seconds} s`;
}

export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${oneDecimal.format(seconds)} s`;
  return formatSpan(seconds * 1000);
}

export function formatAgo(ms: number): string {
  return ms < 1000 ? "just now" : `${formatSpan(ms)} ago`;
}

export function formatHours(seconds: number): string {
  return `${oneDecimal.format(seconds / 3600)} h`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
