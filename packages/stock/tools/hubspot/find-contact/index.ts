type ContactRecord = {
  id?: unknown;
  properties?: Record<string, unknown>;
};

type ListResponse = {
  results?: ContactRecord[];
  paging?: { next?: { after?: unknown } };
};

const propertyNames = [
  "firstname",
  "lastname",
  "email",
  "company",
  "jobtitle",
  "phone",
  "lifecyclestage",
  "hubspot_owner_id",
].join(",");

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const shapeContact = (contact: ContactRecord) => {
  const properties = contact.properties ?? {};
  return {
    id: textOrNull(contact.id),
    firstName: textOrNull(properties.firstname),
    lastName: textOrNull(properties.lastname),
    email: textOrNull(properties.email),
    company: textOrNull(properties.company),
    jobTitle: textOrNull(properties.jobtitle),
    phone: textOrNull(properties.phone),
    lifecycleStage: textOrNull(properties.lifecyclestage),
    ownerId: textOrNull(properties.hubspot_owner_id),
  };
};

export default async (input: Input, ctx: Context) => {
  const query = input.query.trim();

  if (query.includes("@")) {
    const path = `/crm/v3/objects/contacts/${encodeURIComponent(query)}?idProperty=email&properties=${propertyNames}`;
    const response = await ctx.fetch(path, { method: "GET" });
    if (response.status === 404) {
      return { matches: [], scanned: 0, complete: true };
    }
    if (!response.ok) {
      throw new Error(`GET contact by email ${response.status}: ${await response.text()}`);
    }
    const contact = (await response.json()) as ContactRecord;
    return { matches: [shapeContact(contact)], scanned: 1, complete: true };
  }

  const normalizedQuery = query.toLocaleLowerCase();
  const maxPages = input.maxPages ?? 5;
  const matches: ReturnType<typeof shapeContact>[] = [];
  let scanned = 0;
  let after: string | null = null;
  let complete = true;

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({ limit: "100", properties: propertyNames });
    if (after !== null) params.set("after", after);

    const response = await ctx.fetch(`/crm/v3/objects/contacts?${params.toString()}`, {
      method: "GET",
    });
    if (!response.ok) {
      throw new Error(`GET contacts page ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as ListResponse;
    const contacts = Array.isArray(body.results) ? body.results : [];
    scanned += contacts.length;

    for (const contact of contacts) {
      const shaped = shapeContact(contact);
      const fullName = [shaped.firstName, shaped.lastName]
        .filter((part): part is string => part !== null)
        .join(" ");
      const candidates = [
        shaped.firstName,
        shaped.lastName,
        fullName,
        shaped.email,
        shaped.company,
      ];
      if (
        matches.length < 10 &&
        candidates.some(
          (candidate) => candidate?.toLocaleLowerCase().includes(normalizedQuery) === true,
        )
      ) {
        matches.push(shaped);
      }
    }

    const nextAfter = body.paging?.next?.after;
    if (typeof nextAfter !== "string" && typeof nextAfter !== "number") {
      complete = true;
      break;
    }

    after = String(nextAfter);
    if (page + 1 === maxPages) complete = false;
  }

  return { matches, scanned, complete };
};
