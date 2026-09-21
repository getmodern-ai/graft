/** Browser-safe bounds shared by the console and the agent service (ADR 0009). */
export const AGENT_NAME_MAX_LENGTH = 100;
export const WORKING_SET_CAP_RANGE = { min: 1, max: 500 } as const;
export const IDLE_WINDOW_DAYS_RANGE = { min: 1, max: 3650 } as const;
