import { listCurrentStockToolsForVendor } from "@graft/db/repo/stock";
import { listAuthoredToolsForVendor } from "@graft/db/repo/tool";
import { lastRunByToolForPerson } from "@graft/db/repo/usage";

/**
 * An integration's tools read's test seam (GRA-293): the person's tools of the vendor, the
 * catalogue's stock tools of it (global, unscoped) and the ledger's last run per tool.
 */
export type IntegrationToolsDeps = {
  listAuthoredToolsForVendor: typeof listAuthoredToolsForVendor;
  listCurrentStockToolsForVendor: typeof listCurrentStockToolsForVendor;
  lastRunByToolForPerson: typeof lastRunByToolForPerson;
};

export const defaultIntegrationToolsDeps: IntegrationToolsDeps = {
  listAuthoredToolsForVendor,
  listCurrentStockToolsForVendor,
  lastRunByToolForPerson,
};
