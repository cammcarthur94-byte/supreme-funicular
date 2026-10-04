import { describe, it, expect } from "vitest";
import {
  canTransition,
  assertTransition,
  getAllowedTransitions,
  isTerminalStatus,
  IllegalStateTransitionError,
  type DrawStatus,
} from "../app/services/drawStateMachine";

describe("Draw State Machine (drawStateMachine)", () => {
  describe("canTransition", () => {
    it("allows standard happy-path lifecycle transitions", () => {
      expect(canTransition("SCHEDULED", "OPEN")).toBe(true);
      expect(canTransition("OPEN", "CLOSED")).toBe(true);
      expect(canTransition("CLOSED", "DRAWN")).toBe(true);
      expect(canTransition("DRAWN", "FULFILLING")).toBe(true);
      expect(canTransition("FULFILLING", "COMPLETED")).toBe(true);
      expect(canTransition("COMPLETED", "PURGED")).toBe(true);
    });

    it("allows cancellation from appropriate active states", () => {
      expect(canTransition("SCHEDULED", "CANCELLED")).toBe(true);
      expect(canTransition("OPEN", "CANCELLED")).toBe(true);
      expect(canTransition("CLOSED", "CANCELLED")).toBe(true);
      expect(canTransition("DRAWN", "CANCELLED")).toBe(true);
      expect(canTransition("FULFILLING", "CANCELLED")).toBe(true);
    });

    it("disallows backwards transitions", () => {
      expect(canTransition("OPEN", "SCHEDULED")).toBe(false);
      expect(canTransition("CLOSED", "OPEN")).toBe(false);
      expect(canTransition("DRAWN", "CLOSED")).toBe(false);
      expect(canTransition("FULFILLING", "DRAWN")).toBe(false);
      expect(canTransition("COMPLETED", "FULFILLING")).toBe(false);
      expect(canTransition("PURGED", "COMPLETED")).toBe(false);
    });

    it("disallows skipping intermediate steps", () => {
      expect(canTransition("SCHEDULED", "DRAWN")).toBe(false);
      expect(canTransition("SCHEDULED", "COMPLETED")).toBe(false);
      expect(canTransition("SCHEDULED", "PURGED")).toBe(false);
      expect(canTransition("OPEN", "DRAWN")).toBe(false);
      expect(canTransition("OPEN", "FULFILLING")).toBe(false);
      expect(canTransition("OPEN", "PURGED")).toBe(false);
      expect(canTransition("CLOSED", "COMPLETED")).toBe(false);
    });

    it("disallows same-state transitions (no-ops)", () => {
      const statuses: DrawStatus[] = [
        "SCHEDULED",
        "OPEN",
        "CLOSED",
        "DRAWN",
        "FULFILLING",
        "COMPLETED",
        "PURGED",
        "CANCELLED",
      ];
      for (const status of statuses) {
        expect(canTransition(status, status)).toBe(false);
      }
    });

    it("disallows transitioning out of terminal states", () => {
      const allStatuses: DrawStatus[] = [
        "SCHEDULED",
        "OPEN",
        "CLOSED",
        "DRAWN",
        "FULFILLING",
        "COMPLETED",
        "PURGED",
        "CANCELLED",
      ];

      for (const target of allStatuses) {
        expect(canTransition("PURGED", target)).toBe(false);
        expect(canTransition("CANCELLED", target)).toBe(false);
      }
    });
  });

  describe("assertTransition", () => {
    it("does not throw for valid transitions", () => {
      expect(() => assertTransition("SCHEDULED", "OPEN")).not.toThrow();
      expect(() => assertTransition("COMPLETED", "PURGED")).not.toThrow();
    });

    it("throws IllegalStateTransitionError with metadata on invalid transitions", () => {
      expect(() => assertTransition("OPEN", "PURGED")).toThrow(
        IllegalStateTransitionError
      );

      try {
        assertTransition("PURGED", "OPEN");
      } catch (err) {
        expect(err).toBeInstanceOf(IllegalStateTransitionError);
        const error = err as IllegalStateTransitionError;
        expect(error.fromStatus).toBe("PURGED");
        expect(error.toStatus).toBe("OPEN");
        expect(error.message).toContain("Illegal draw state transition from 'PURGED' to 'OPEN'");
      }
    });
  });

  describe("getAllowedTransitions & isTerminalStatus", () => {
    it("returns correct next states", () => {
      expect(getAllowedTransitions("SCHEDULED")).toEqual(["OPEN", "CANCELLED"]);
      expect(getAllowedTransitions("COMPLETED")).toEqual(["PURGED"]);
      expect(getAllowedTransitions("PURGED")).toEqual([]);
      expect(getAllowedTransitions("CANCELLED")).toEqual([]);
    });

    it("correctly identifies terminal states", () => {
      expect(isTerminalStatus("PURGED")).toBe(true);
      expect(isTerminalStatus("CANCELLED")).toBe(true);
      expect(isTerminalStatus("SCHEDULED")).toBe(false);
      expect(isTerminalStatus("OPEN")).toBe(false);
      expect(isTerminalStatus("COMPLETED")).toBe(false);
    });
  });
});
