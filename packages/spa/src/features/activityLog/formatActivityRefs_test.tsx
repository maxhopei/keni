import "../../test_setup.ts";
import { afterEach, describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ActivityRefs } from "./formatActivityRefs.tsx";

describe({
  name: "ActivityRefs",
  sanitizeOps: false,
  sanitizeResources: false,
}, () => {
  afterEach(() => cleanup());

  it("ticket ref renders a navigating link to /tickets/<id>", () => {
    render(
      <MemoryRouter>
        <ActivityRefs refs={{ ticket: "ticket-0001" }} />
      </MemoryRouter>,
    );
    const link = screen.getByTestId("activity-ref-ticket-ticket-0001") as HTMLAnchorElement;
    assertEquals(link.tagName, "A");
    assertEquals(link.getAttribute("href"), "/tickets/ticket-0001");
    assert(link.textContent?.includes("ticket: ticket-0001"));
  });

  it("pr ref renders a navigating link to /prs/<id>", () => {
    render(
      <MemoryRouter>
        <ActivityRefs refs={{ pr: "pr-0001" }} />
      </MemoryRouter>,
    );
    const link = screen.getByTestId("activity-ref-pr-pr-0001") as HTMLAnchorElement;
    assertEquals(link.tagName, "A");
    assertEquals(link.getAttribute("href"), "/prs/pr-0001");
    assert(link.textContent?.includes("pr: pr-0001"));
  });

  it("change_request ref renders as plain text (no link in the prototype)", () => {
    render(
      <MemoryRouter>
        <ActivityRefs refs={{ change_request: "cr-0003" }} />
      </MemoryRouter>,
    );
    const span = screen.getByTestId("activity-ref-change_request");
    assertEquals(span.tagName, "SPAN");
    assertEquals(span.textContent, "change_request: cr-0003");
    assertEquals(span.querySelector("a"), null);
  });

  it("unknown ref keys render as plain text", () => {
    render(
      <MemoryRouter>
        <ActivityRefs refs={{ branch: "main" }} />
      </MemoryRouter>,
    );
    const span = screen.getByTestId("activity-ref-branch");
    assertEquals(span.tagName, "SPAN");
    assertEquals(span.textContent, "branch: main");
    assertEquals(span.querySelector("a"), null);
  });

  it("renders every key/value in the refs map when multiple are provided", () => {
    render(
      <MemoryRouter>
        <ActivityRefs
          refs={{
            ticket: "ticket-0001",
            pr: "pr-0002",
            change_request: "cr-0004",
            branch: "main",
          }}
        />
      </MemoryRouter>,
    );
    assert(screen.getByTestId("activity-ref-ticket-ticket-0001") !== null);
    assert(screen.getByTestId("activity-ref-pr-pr-0002") !== null);
    assert(screen.getByTestId("activity-ref-change_request") !== null);
    assert(screen.getByTestId("activity-ref-branch") !== null);
  });

  it("empty refs map renders nothing", () => {
    const { container } = render(
      <MemoryRouter>
        <ActivityRefs refs={{}} />
      </MemoryRouter>,
    );
    assertEquals(container.querySelector('[data-testid="activity-refs"]'), null);
  });
});
