import { assertEquals } from "@std/assert";
import {
  DRAG_MIME,
  packDragPayload,
  unpackDragPayload,
} from "../../../../src/features/board/dragHelpers.ts";

class FakeDataTransfer {
  private store = new Map<string, string>();
  effectAllowed = "none";
  setData(type: string, value: string): void {
    this.store.set(type, value);
  }
  getData(type: string): string {
    return this.store.get(type) ?? "";
  }
}

function dt(): DataTransfer {
  return new FakeDataTransfer() as unknown as DataTransfer;
}

Deno.test("packDragPayload / unpackDragPayload round-trip the typed payload", () => {
  const x = dt();
  packDragPayload(x, { ticketId: "ticket-0001", fromStatus: "open" });
  assertEquals(
    unpackDragPayload(x),
    { ticketId: "ticket-0001", fromStatus: "open" },
  );
});

Deno.test("packDragPayload sets effectAllowed to 'move'", () => {
  const x = dt();
  packDragPayload(x, { ticketId: "ticket-0001", fromStatus: "open" });
  // deno-lint-ignore no-explicit-any
  assertEquals((x as any).effectAllowed, "move");
});

Deno.test("unpackDragPayload returns null when the MIME type is absent", () => {
  const x = dt();
  assertEquals(unpackDragPayload(x), null);
});

Deno.test("unpackDragPayload returns null on malformed JSON", () => {
  const x = dt();
  x.setData(DRAG_MIME, "not-json");
  assertEquals(unpackDragPayload(x), null);
});

Deno.test("unpackDragPayload returns null when required fields are missing", () => {
  const x = dt();
  x.setData(DRAG_MIME, JSON.stringify({ ticketId: "ticket-0001" }));
  assertEquals(unpackDragPayload(x), null);
});
