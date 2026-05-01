/**
 * In-memory `PRStore` adapter for unit tests.
 *
 * @module
 */

import { StaleStateError, StoreNotFoundError } from "../errors.ts";
import { generatePrId } from "../ids.ts";
import type {
  PR,
  PRCreateInput,
  PRFilter,
  PRHeader,
  PRId,
  PRStatus,
  PRStore,
  PRSummary,
} from "./interface.ts";
import { matchPR } from "./shared.ts";

/**
 * In-memory `PRStore`. See `./interface.ts` for the contract; behavioural
 * equivalence with `FilePRStore` enforced by `./contract_test.ts`.
 */
export class InMemoryPRStore implements PRStore {
  readonly #prs = new Map<PRId, PR>();

  list(filter?: PRFilter): Promise<PRSummary[]> {
    const out: PRSummary[] = [];
    for (const pr of this.#prs.values()) {
      if (matchPR(pr.header, filter)) out.push({ ...pr.header });
    }
    return Promise.resolve(out);
  }

  read(id: PRId): Promise<PR> {
    const pr = this.#prs.get(id);
    if (!pr) return Promise.reject(new StoreNotFoundError(id));
    return Promise.resolve(clonePR(pr));
  }

  create(input: PRCreateInput): Promise<PR> {
    const id = generatePrId([...this.#prs.keys()]);
    const now = new Date().toISOString();
    const pr: PR = {
      header: {
        id,
        title: input.title,
        status: "open",
        ticket: input.ticket,
        branch: input.branch,
        author: input.author,
        created_at: now,
        updated_at: now,
      },
      body: input.body ?? "",
    };
    this.#prs.set(id, pr);
    return Promise.resolve(clonePR(pr));
  }

  updateIntent(id: PRId, intent: string): Promise<PR> {
    const existing = this.#prs.get(id);
    if (!existing) return Promise.reject(new StoreNotFoundError(id));
    const updated: PR = {
      header: { ...existing.header, updated_at: new Date().toISOString() },
      body: intent,
    };
    this.#prs.set(id, updated);
    return Promise.resolve(clonePR(updated));
  }

  updateStatus(id: PRId, from: PRStatus, to: PRStatus): Promise<PR> {
    const existing = this.#prs.get(id);
    if (!existing) return Promise.reject(new StoreNotFoundError(id));
    if (existing.header.status !== from) {
      return Promise.reject(
        new StaleStateError(id, from, existing.header.status),
      );
    }
    const updated: PR = {
      header: {
        ...existing.header,
        status: to,
        updated_at: new Date().toISOString(),
      },
      body: existing.body,
    };
    this.#prs.set(id, updated);
    return Promise.resolve(clonePR(updated));
  }
}

function clonePR(pr: PR): PR {
  return { header: { ...pr.header } as PRHeader, body: pr.body };
}
