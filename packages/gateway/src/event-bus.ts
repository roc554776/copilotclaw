/**
 * Event Bus Infrastructure (gateway side).
 *
 * Provides:
 * - dispatchToSubsystem(subsystemId, event): routes events to subsystem handlers
 * - Event ID (UUID) assignment
 * - Dedup via processedEventIds sliding window
 *
 * Design: minimal router + dedup judge. No distributed transactions, no saga.
 *
 * See docs/proposals/state-management-architecture.md "event bus infrastructure subsystem".
 */

import { randomUUID } from "node:crypto";

// ── World State ───────────────────────────────────────────────────────────────

/** Maximum number of processed event IDs retained in the dedup window. */
const DEDUP_WINDOW_SIZE = 1000;

export interface EventBusState {
  /** Recent window of processed event IDs for dedup. */
  processedEventIds: string[];
}

export function createInitialEventBusState(): EventBusState {
  return { processedEventIds: [] };
}

// ── Events / Commands ─────────────────────────────────────────────────────────

export type EventBusEvent =
  | { type: "EventArrived"; eventId: string; targetSubsystem: string; payload: unknown };

export type EventBusCommand =
  | { type: "DispatchToSubsystem"; eventId: string; targetSubsystem: string; payload: unknown }
  | { type: "RecordDuplicateEvent"; eventId: string; targetSubsystem: string };

export interface EventBusReducerResult {
  newState: EventBusState;
  commands: EventBusCommand[];
}

// ── Reducer ───────────────────────────────────────────────────────────────────

export function reduceEventBus(
  state: EventBusState,
  event: EventBusEvent,
): EventBusReducerResult {
  switch (event.type) {
    case "EventArrived": {
      if (state.processedEventIds.includes(event.eventId)) {
        return {
          newState: state,
          commands: [{
            type: "RecordDuplicateEvent",
            eventId: event.eventId,
            targetSubsystem: event.targetSubsystem,
          }],
        };
      }
      const newIds = [...state.processedEventIds, event.eventId];
      const trimmed = newIds.length > DEDUP_WINDOW_SIZE
        ? newIds.slice(newIds.length - DEDUP_WINDOW_SIZE)
        : newIds;
      return {
        newState: { processedEventIds: trimmed },
        commands: [{
          type: "DispatchToSubsystem",
          eventId: event.eventId,
          targetSubsystem: event.targetSubsystem,
          payload: event.payload,
        }],
      };
    }
  }
}

// ── Runtime ───────────────────────────────────────────────────────────────────

type SubsystemHandler = (payload: unknown) => void;

/**
 * Event bus runtime. Manages subsystem handler registrations and routes events
 * after dedup check.
 */
export class EventBus {
  private state: EventBusState = createInitialEventBusState();
  private readonly handlers = new Map<string, SubsystemHandler>();

  /** Register a handler for a named subsystem. */
  register(subsystemId: string, handler: SubsystemHandler): void {
    this.handlers.set(subsystemId, handler);
  }

  /**
   * Dispatch an event to a subsystem.
   * Assigns a new UUID event ID, runs dedup, and routes if not duplicate.
   */
  dispatch(targetSubsystem: string, payload: unknown): void {
    const eventId = randomUUID();
    const event: EventBusEvent = { type: "EventArrived", eventId, targetSubsystem, payload };
    const { newState, commands } = reduceEventBus(this.state, event);
    this.state = newState;

    for (const cmd of commands) {
      if (cmd.type === "DispatchToSubsystem") {
        const handler = this.handlers.get(cmd.targetSubsystem);
        if (handler !== undefined) {
          handler(cmd.payload);
        }
      } else if (cmd.type === "RecordDuplicateEvent") {
        console.error(`[event-bus] duplicate event ${cmd.eventId} for subsystem ${cmd.targetSubsystem} (dropped)`);
      }
    }
  }

  /**
   * Dispatch with a pre-assigned event ID (for idempotent re-delivery).
   */
  dispatchWithId(eventId: string, targetSubsystem: string, payload: unknown): void {
    const event: EventBusEvent = { type: "EventArrived", eventId, targetSubsystem, payload };
    const { newState, commands } = reduceEventBus(this.state, event);
    this.state = newState;

    for (const cmd of commands) {
      if (cmd.type === "DispatchToSubsystem") {
        const handler = this.handlers.get(cmd.targetSubsystem);
        if (handler !== undefined) {
          handler(cmd.payload);
        }
      } else if (cmd.type === "RecordDuplicateEvent") {
        console.error(`[event-bus] duplicate event ${cmd.eventId} for subsystem ${cmd.targetSubsystem} (dropped)`);
      }
    }
  }

  getState(): EventBusState {
    return this.state;
  }
}
