/**
 * Tests for the in-process `EventBus` and the `captureBusBuffer` test
 * helper. Covers happy-path fan-out, subscriber-error isolation across
 * sync and async handlers, the unsubscribe closure, and the
 * registration-order iteration property.
 */

import { assert, assertEquals } from "@std/assert";
import type { EventFrame } from "@keni/shared";
import { captureLogSink } from "../../src/middleware/requestLog.ts";
import type { RequestLogLine } from "../../src/middleware/types.ts";
import { captureBusBuffer, createInMemoryEventBus } from "../../src/eventBus.ts";

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

function ticketFrame(idTail: string): EventFrame {
  return {
    id: `01900000-0000-7000-8000-${idTail.padStart(12, "0")}`,
    event: "ticket.created",
    project_id: PROJECT_ID,
    timestamp: new Date().toISOString(),
    payload: { ticket_id: "ticket-0001", status: "open" },
  };
}

Deno.test("emit fans out to every registered subscriber synchronously", () => {
  const bus = createInMemoryEventBus();
  const aSeen: EventFrame[] = [];
  const bSeen: EventFrame[] = [];
  bus.subscribe((f) => {
    aSeen.push(f);
  });
  bus.subscribe((f) => {
    bSeen.push(f);
  });
  const frame = ticketFrame("1");
  bus.emit(frame);
  assertEquals(aSeen.length, 1);
  assertEquals(bSeen.length, 1);
  assertEquals(aSeen[0], frame);
  assertEquals(bSeen[0], frame);
});

Deno.test("emit returns synchronously without awaiting async handlers", async () => {
  const bus = createInMemoryEventBus();
  let asyncResolved = false;
  let resolveHandler!: () => void;
  const handlerDone = new Promise<void>((r) => (resolveHandler = r));
  bus.subscribe(async () => {
    await Promise.resolve();
    asyncResolved = true;
    resolveHandler();
  });
  bus.emit(ticketFrame("2"));
  assertEquals(asyncResolved, false);
  await handlerDone;
  assertEquals(asyncResolved, true);
});

Deno.test("a throwing subscriber does not propagate to the emit caller", () => {
  const buffer: RequestLogLine[] = [];
  const bus = createInMemoryEventBus({ logSink: captureLogSink(buffer) });
  bus.subscribe(() => {
    throw new Error("kapow");
  });
  const aSeen: EventFrame[] = [];
  bus.subscribe((f) => {
    aSeen.push(f);
  });
  bus.emit(ticketFrame("3"));
  assertEquals(aSeen.length, 1, "second subscriber must still receive the frame");
  assertEquals(buffer.length, 1);
  assertEquals(buffer[0]!.path, "event_bus");
  assert(
    buffer[0]!.error_code?.startsWith("subscriber_failed:ticket.created:"),
    "the warn line carries the failed event name and message",
  );
});

Deno.test("an async-rejecting subscriber is logged but does not poison the bus", async () => {
  const buffer: RequestLogLine[] = [];
  const bus = createInMemoryEventBus({ logSink: captureLogSink(buffer) });
  bus.subscribe(() => Promise.reject(new Error("async-kapow")));
  const aSeen: EventFrame[] = [];
  bus.subscribe((f) => {
    aSeen.push(f);
  });
  bus.emit(ticketFrame("4"));
  assertEquals(aSeen.length, 1);
  await new Promise((r) => setTimeout(r, 1));
  assertEquals(buffer.length, 1);
  assert(buffer[0]!.error_code?.includes("async-kapow"));
});

Deno.test("unsubscribe removes the handler from future emits", () => {
  const bus = createInMemoryEventBus();
  const seen: EventFrame[] = [];
  const off = bus.subscribe((f) => {
    seen.push(f);
  });
  bus.emit(ticketFrame("5"));
  off();
  bus.emit(ticketFrame("6"));
  assertEquals(seen.length, 1);
});

Deno.test("multiple subscribers receive every frame in registration order", () => {
  const bus = createInMemoryEventBus();
  const order: string[] = [];
  bus.subscribe(() => {
    order.push("first");
  });
  bus.subscribe(() => {
    order.push("second");
  });
  bus.subscribe(() => {
    order.push("third");
  });
  bus.emit(ticketFrame("7"));
  assertEquals(order, ["first", "second", "third"]);
});

Deno.test("captureBusBuffer pushes every emitted frame and returns an unsubscribe", () => {
  const { buffer, subscribe } = captureBusBuffer();
  const bus = createInMemoryEventBus();
  const off = subscribe(bus);
  const a = ticketFrame("8");
  const b = ticketFrame("9");
  bus.emit(a);
  bus.emit(b);
  off();
  bus.emit(ticketFrame("10"));
  assertEquals(buffer.length, 2);
  assertEquals(buffer[0]!.id, a.id);
  assertEquals(buffer[1]!.id, b.id);
});
