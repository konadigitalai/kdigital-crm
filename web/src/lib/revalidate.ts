"use server";

// Server Actions for dropping Next's data cache.
//
// revalidateTag can only run on the server, but the admin screens that edit
// programs and courses are client components. A Server Action is the bridge:
// the client calls it like a function, Next runs it server-side.
//
// Kept in its own module because "use server" marks EVERY export in a file as
// a remotely-callable endpoint. Putting it at the top of lib/api.ts would
// expose the whole API client that way.

import { revalidateTag } from "next/cache";

/** Invalidate cached catalog / programs / courses reads. Called by the
 *  mutation helpers in lib/api.ts after a successful write. */
export async function revalidateReferenceData(): Promise<void> {
  revalidateTag("reference-data");
}
