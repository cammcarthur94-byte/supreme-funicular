export type DrawStatus =
  | "SCHEDULED"
  | "OPEN"
  | "CLOSED"
  | "DRAWN"
  | "FULFILLING"
  | "COMPLETED"
  | "PURGED"
  | "CANCELLED";

export class IllegalStateTransitionError extends Error {
  readonly fromStatus: DrawStatus;
  readonly toStatus: DrawStatus;

  constructor(fromStatus: DrawStatus, toStatus: DrawStatus, message?: string) {
    const defaultMessage = `Illegal draw state transition from '${fromStatus}' to '${toStatus}'.`;
    super(message || defaultMessage);
    this.name = "IllegalStateTransitionError";
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

/**
 * Strict forward-progression state machine definition for Draw lifecycle.
 */
const ALLOWED_TRANSITIONS: Record<DrawStatus, readonly DrawStatus[]> = {
  SCHEDULED: ["OPEN", "CANCELLED"],
  OPEN: ["CLOSED", "CANCELLED"],
  CLOSED: ["DRAWN", "CANCELLED"],
  DRAWN: ["FULFILLING", "CANCELLED"],
  FULFILLING: ["COMPLETED", "CANCELLED"],
  COMPLETED: ["PURGED"],
  PURGED: [],
  CANCELLED: [],
};

/**
 * Pure function checking whether a transition from one DrawStatus to another is permitted.
 */
export function canTransition(from: DrawStatus, to: DrawStatus): boolean {
  if (from === to) {
    return false; // Idempotent updates should not be treated as state transitions
  }
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Asserts that a state transition is legal, throwing IllegalStateTransitionError if not.
 */
export function assertTransition(from: DrawStatus, to: DrawStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalStateTransitionError(from, to);
  }
}

/**
 * Returns a list of legal next statuses for the given status.
 */
export function getAllowedTransitions(from: DrawStatus): DrawStatus[] {
  return [...(ALLOWED_TRANSITIONS[from] || [])];
}

/**
 * Checks whether a given DrawStatus is terminal (no further transitions permitted).
 */
export function isTerminalStatus(status: DrawStatus): boolean {
  return ALLOWED_TRANSITIONS[status]?.length === 0;
}
