// Shown when Auth0 authenticated someone the CRM has no record for.
//
// Reaching this means the API returned 403 from /me: no app_user matched the
// token's sub or email, and no party with a learner_profile carries that
// address. The account is real; it just isn't set up here yet.
//
// Deliberately vague about *why* — an authenticated stranger shouldn't be
// able to work out which addresses exist by reading our error copy. The
// precise reason is in the API log, on the [auth] line.
//
// Sign out is the important control: without it the session cookie persists
// and every navigation lands back here with no way forward.

export function NotProvisioned({ email }: { email?: string | null }) {
  return (
    <div className="grid min-h-screen place-items-center bg-[#f7f5f0] px-6">
      <div className="max-w-md rounded-2xl border border-black/5 bg-white p-8 text-center shadow-sm">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-amber-100 text-amber-800">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
        </span>

        <h1 className="mt-5 font-serif text-2xl">Account not set up</h1>
        <p className="mt-3 text-sm text-ink/60">
          You signed in successfully{email ? <> as <span className="font-medium text-ink/80">{email}</span></> : null},
          but this address isn&rsquo;t registered in the CRM yet.
        </p>
        <p className="mt-3 text-sm text-ink/60">
          Ask an administrator to add you — staff are created under Admin ▸ Advisors,
          learners when their enrolment is converted.
        </p>

        <a
          href="/auth/logout"
          className="mt-6 inline-block rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-white transition hover:bg-ink/90"
        >
          Sign out
        </a>
        <p className="mt-3 text-xs text-ink/40">
          Signed in with the wrong account? Sign out and try again.
        </p>
      </div>
    </div>
  );
}
