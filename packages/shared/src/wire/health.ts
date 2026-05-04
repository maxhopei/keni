/**
 * Wire shape for `GET /health`.
 *
 * The orchestration server's health endpoint is the only documented
 * exemption from the role-identity middleware (see the `orchestration-server`
 * capability spec's `/health` requirement). The endpoint is the smoke-test
 * seam and the future supervisor seam; its body carries the cosmetic
 * `uptime_ms` and `version` fields plus the canonical `project_id` (which
 * is the only piece of state worth emitting on a public-bypass surface).
 *
 * @module
 */

/** Body inside the success envelope for `GET /health`. */
export interface HealthResponse {
  /** Always the literal `"ok"` for any 200 response. */
  readonly status: "ok";
  /** UUIDv4 of the project the server was booted against. */
  readonly project_id: string;
  /**
   * Milliseconds elapsed since `runServer` captured `serverStartedAt` (the
   * moment `Deno.serve`'s `onListen` fires). Always non-negative; when
   * the server was constructed without `serverStartedAt` (existing test
   * call sites that did not opt in), the value is `0`.
   */
  readonly uptime_ms: number;
  /** Build-time version constant; replaced by binary packaging post-MVP. */
  readonly version: string;
}

/** Envelope for `GET /health`. */
export interface HealthEnvelope {
  readonly data: HealthResponse;
  readonly project_id: string;
}
