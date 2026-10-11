/**
 * Every form a credential value can take on the wire or in a vendor's echo of it (Greptile on #187
 * and #191): the value itself, percent-encoded as a query parameter carries it, form-encoded,
 * base64 and base64url (padded and not), and the `Authorization` values a scheme builds from it,
 * `Bearer <value>` and, where the fields are a `username` and a `password`, `Basic <base64 pair>`
 * and the bare pair, which is what a vendor echoing the header echoes. Redacting by value over
 * these alone is what keeps a recording, a diagnostic or a sentence from carrying a credential in
 * an encoding the shape pass does not recognise, such as a bare base64 pair under a field named
 * `note`.
 *
 * Longest first, so a whole `Bearer …` or `Basic …` goes before the value inside it. Values shorter
 * than the redaction's floor (`@graft/core`'s `MIN_SECRET_LENGTH`) are left in; `redactText` skips
 * them.
 */
export function credentialForms(credential: Readonly<Record<string, string>>): string[] {
  const forms = new Set<string>();
  const encodings = (value: string) => {
    const bytes = Buffer.from(value, "utf8");
    const base64 = bytes.toString("base64");
    const base64url = bytes.toString("base64url");
    return [
      value,
      encodeURIComponent(value),
      new URLSearchParams({ v: value }).toString().slice("v=".length),
      base64,
      base64.replace(/=+$/, ""),
      base64url,
      `${base64url}${"=".repeat((4 - (base64url.length % 4)) % 4)}`,
    ];
  };
  for (const value of Object.values(credential)) {
    if (value.length === 0) continue;
    for (const form of encodings(value)) forms.add(form);
    forms.add(`Bearer ${value}`);
  }
  const { username, password } = credential;
  if (typeof username === "string" && typeof password === "string") {
    for (const form of encodings(`${username}:${password}`)) forms.add(form);
    forms.add(`Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`);
  }
  return [...forms].filter((form) => form.length > 0).sort((a, b) => b.length - a.length);
}
