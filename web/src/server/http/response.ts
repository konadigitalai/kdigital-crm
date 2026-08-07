// A response builder with Express's chainable surface that settles into a
// Web-standard `Response`.
//
// Handlers are written as `res.status(404).json({ error: … })`, so `status`
// must be chainable and `json` must be terminal. Rather than emulate Node's
// streaming ServerResponse, this accumulates status/headers/body and resolves
// a promise the moment a terminal method is called. The dispatcher races that
// promise against the handler returning.
//
// Double-send is tolerated the way Express tolerates it: the first terminal
// call wins, later ones are ignored (Express logs ERR_HTTP_HEADERS_SENT and
// carries on). Several handlers call res.json() without `return`, then fall
// through to a trailing line, so this must not throw.

export type BeforeSendHook = (res: ApiResponse) => void;
export type FinishHook = (res: ApiResponse) => void;

export class ApiResponse {
  statusCode = 200;
  headersSent = false;

  private readonly _headers = new Headers();
  private readonly _beforeSend: BeforeSendHook[] = [];
  private readonly _onFinish: FinishHook[] = [];
  private _settle!: (r: Response) => void;

  /** Resolves with the finished Response once a terminal method is called. */
  readonly done: Promise<Response>;

  constructor() {
    this.done = new Promise<Response>((resolve) => {
      this._settle = resolve;
    });
  }

  // ── Chainable ───────────────────────────────────────────────────────────

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    if (Array.isArray(value)) {
      this._headers.delete(name);
      for (const v of value) this._headers.append(name, String(v));
    } else {
      this._headers.set(name, String(value));
    }
    return this;
  }

  /** Express alias for setHeader. */
  header(name: string, value: string | number | readonly string[]): this {
    return this.setHeader(name, value);
  }

  getHeader(name: string): string | null {
    return this._headers.get(name);
  }

  /**
   * Express's `res.type()` — accepts a full MIME type or a bare extension.
   * Only the handful the codebase uses need to resolve; anything else is
   * passed through verbatim.
   */
  type(value: string): this {
    const shorthand: Record<string, string> = {
      json: "application/json",
      html: "text/html",
      text: "text/plain",
      xml: "application/xml",
    };
    const resolved = shorthand[value] ?? value;
    return this.setHeader(
      "Content-Type",
      resolved.startsWith("text/") && !resolved.includes("charset")
        ? `${resolved}; charset=utf-8`
        : resolved,
    );
  }

  /** Register a callback run just before the Response is constructed. */
  onBeforeSend(hook: BeforeSendHook): void {
    this._beforeSend.push(hook);
  }

  /**
   * Express's `res.on("finish", …)`. Only "finish" is meaningful here; other
   * events are accepted and ignored so call sites keep compiling.
   */
  on(event: string, hook: FinishHook): this {
    if (event === "finish") this._onFinish.push(hook);
    return this;
  }

  // ── Terminal ────────────────────────────────────────────────────────────

  json(body: unknown): this {
    if (!this._headers.has("Content-Type")) {
      this.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    return this._finish(JSON.stringify(body ?? null));
  }

  send(body?: unknown): this {
    if (body === undefined || body === null) return this._finish(null);
    if (typeof body === "string") {
      if (!this._headers.has("Content-Type")) this.type("html");
      return this._finish(body);
    }
    if (body instanceof Uint8Array) {
      if (!this._headers.has("Content-Type")) {
        this.setHeader("Content-Type", "application/octet-stream");
      }
      // Copy into a plain ArrayBuffer — a Buffer's underlying pool is shared
      // and would otherwise leak neighbouring bytes into the response.
      const copy = new Uint8Array(body.byteLength);
      copy.set(body);
      return this._finish(copy);
    }
    return this.json(body);
  }

  /** Stream a Web ReadableStream straight through (media proxy paths). */
  stream(body: ReadableStream<Uint8Array>): this {
    return this._finish(body);
  }

  end(): this {
    return this._finish(null);
  }

  sendStatus(code: number): this {
    return this.status(code)._finish(null);
  }

  redirect(url: string): this;
  redirect(code: number, url: string): this;
  redirect(codeOrUrl: number | string, maybeUrl?: string): this {
    const code = typeof codeOrUrl === "number" ? codeOrUrl : 302;
    const url = typeof codeOrUrl === "number" ? String(maybeUrl) : codeOrUrl;
    return this.status(code).setHeader("Location", url)._finish(null);
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private _finish(body: BodyInit | null): this {
    if (this.headersSent) return this; // first write wins, as in Express
    this.headersSent = true;

    for (const hook of this._beforeSend) {
      try {
        hook(this);
      } catch {
        // Timing/observability must never take down a response.
      }
    }

    // 204/304 must not carry a body per the Fetch spec, and Response throws
    // if given one.
    const bodyless = this.statusCode === 204 || this.statusCode === 304;
    this._settle(
      new Response(bodyless ? null : body, {
        status: this.statusCode,
        headers: this._headers,
      }),
    );

    for (const hook of this._onFinish) {
      try {
        hook(this);
      } catch {
        /* ignore */
      }
    }
    return this;
  }
}
