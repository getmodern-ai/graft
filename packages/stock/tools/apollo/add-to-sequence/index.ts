type JsonObject = Record<string, unknown>;

export default async (input: Input, ctx: Context) => {
  const body: JsonObject = {
    emailer_campaign_id: input.sequenceId,
    contact_ids: input.contactIds,
    send_email_from_email_account_id: input.emailAccountId,
  };

  if (input.includeContactsWithoutEmail !== undefined) {
    body.sequence_no_email = input.includeContactsWithoutEmail;
  }
  if (input.includeContactsActiveInOtherSequences !== undefined) {
    body.sequence_active_in_other_campaigns = input.includeContactsActiveInOtherSequences;
  }
  if (input.includeContactsFinishedInOtherSequences !== undefined) {
    body.sequence_finished_in_other_campaigns = input.includeContactsFinishedInOtherSequences;
  }
  if (input.includeSameCompany !== undefined) {
    body.sequence_same_company_in_same_campaign = input.includeSameCompany;
  }

  const res = await ctx.fetch(
    `/api/v1/emailer_campaigns/${encodeURIComponent(input.sequenceId)}/add_contact_ids`,
    {
      host: "api.apollo.io",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (res.status === 202 && res.headers.get("x-graft-dry-run") === "intercepted") {
    return { added: false, sent: true };
  }
  if (!res.ok) {
    throw new Error(`POST add contacts to sequence ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as JsonObject;
  const contacts = Array.isArray(data.contacts)
    ? data.contacts
        .filter((contact): contact is JsonObject => typeof contact === "object" && contact !== null)
        .map((contact) => ({
          id: typeof contact.id === "string" ? contact.id : null,
          name: typeof contact.name === "string" ? contact.name : null,
        }))
    : [];

  const result: JsonObject = { added: true, contacts };
  if (Array.isArray(data.skipped_contact_ids)) {
    result.skippedContactIds = data.skipped_contact_ids.filter(
      (id): id is string => typeof id === "string",
    );
  }
  return result;
};
