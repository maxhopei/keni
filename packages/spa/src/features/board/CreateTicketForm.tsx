/**
 * Inline "New ticket" form rendered above the kanban columns.
 *
 * Collapsed by default behind a toggle button; expands into a short form
 * that submits through `apiClient.createTicket` and — on success —
 * navigates to the new ticket's detail page. Failures render inline so
 * the user can fix and retry without losing state (design.md Decision 9).
 */

import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { TicketCreateRequest } from "@keni/shared";
import { useApiClient } from "../../transport/ApiClientContext.tsx";
import { KeniApiError } from "../../transport/apiClient.ts";

const DEFAULT_PRIORITY = 100;

export function CreateTicketForm() {
  const apiClient = useApiClient();
  const navigate = useNavigate();

  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState(String(DEFAULT_PRIORITY));
  const [assignee, setAssignee] = useState("");
  const [changeRequest, setChangeRequest] = useState("");
  const [body, setBody] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setTitle("");
    setPriority(String(DEFAULT_PRIORITY));
    setAssignee("");
    setChangeRequest("");
    setBody("");
    setTitleError(null);
    setSubmitError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (title.trim() === "") {
      setTitleError("Title is required");
      return;
    }
    setTitleError(null);
    setSubmitError(null);
    setSubmitting(true);
    const parsedPriority = Number.parseInt(priority, 10);
    const input: TicketCreateRequest = {
      title: title.trim(),
      priority: Number.isNaN(parsedPriority) ? DEFAULT_PRIORITY : parsedPriority,
      assignee: assignee.trim() === "" ? null : assignee.trim(),
      change_request: changeRequest.trim() === "" ? null : changeRequest.trim(),
      body,
    };
    try {
      const envelope = await apiClient.createTicket(input);
      reset();
      setExpanded(false);
      navigate(`/tickets/${envelope.data.id}`);
    } catch (caught) {
      const code = caught instanceof KeniApiError
        ? caught.code
        : caught instanceof Error
        ? caught.message
        : String(caught);
      setSubmitError(code);
    } finally {
      setSubmitting(false);
    }
  }

  if (!expanded) {
    return (
      <div className="keni-create-ticket">
        <button
          type="button"
          className="keni-create-ticket__toggle"
          data-testid="create-ticket-toggle"
          onClick={() => setExpanded(true)}
        >
          + New ticket
        </button>
      </div>
    );
  }

  return (
    <form
      className="keni-create-ticket keni-create-ticket--expanded"
      onSubmit={handleSubmit}
      data-testid="create-ticket-form"
    >
      <div className="keni-create-ticket__row">
        <label className="keni-create-ticket__field">
          <span>Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="create-ticket-title"
            aria-invalid={titleError !== null}
          />
          {titleError !== null
            ? (
              <span className="keni-create-ticket__field-error" role="alert">
                {titleError}
              </span>
            )
            : null}
        </label>
        <label className="keni-create-ticket__field keni-create-ticket__field--priority">
          <span>Priority</span>
          <input
            type="number"
            step="1"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            data-testid="create-ticket-priority"
          />
        </label>
      </div>
      <div className="keni-create-ticket__row">
        <label className="keni-create-ticket__field">
          <span>Assignee</span>
          <input
            type="text"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            data-testid="create-ticket-assignee"
          />
        </label>
        <label className="keni-create-ticket__field">
          <span>Change request</span>
          <input
            type="text"
            value={changeRequest}
            onChange={(e) => setChangeRequest(e.target.value)}
            data-testid="create-ticket-change-request"
          />
        </label>
      </div>
      <label className="keni-create-ticket__field">
        <span>Body</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          data-testid="create-ticket-body"
        />
      </label>
      <div className="keni-create-ticket__actions">
        <button
          type="submit"
          disabled={submitting}
          data-testid="create-ticket-submit"
        >
          {submitting ? "Creating…" : "Create ticket"}
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            setExpanded(false);
          }}
          disabled={submitting}
          data-testid="create-ticket-cancel"
        >
          Cancel
        </button>
      </div>
      {submitError !== null
        ? (
          <div
            className="keni-create-ticket__error"
            role="alert"
            data-testid="create-ticket-error"
          >
            {submitError}
          </div>
        )
        : null}
    </form>
  );
}

export default CreateTicketForm;
