/**
 * Home's title, as the Figma "App v2" Home frame writes it: "Good afternoon, Seb". The part of
 * the day is the browser's local hour; the name is the first word of the person's name, and with
 * no name the greeting stands alone rather than greet an email address.
 */
export function homeGreeting(now: Date, name: string | null | undefined): string {
  const hour = now.getHours();
  const part = hour < 5 ? "evening" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const first = name?.trim().split(/\s+/)[0];
  return first ? `Good ${part}, ${first}` : `Good ${part}`;
}
