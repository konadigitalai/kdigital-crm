// Vimeo lookup — turns whatever an admin pasted into something that will
// actually play, plus the title and length so they don't retype them.
//
// WHY THIS EXISTS
// ---------------
// A video set to "Embed only" (private on Vimeo, embeddable anywhere) is only
// playable through a player URL carrying its privacy hash:
//
//     https://player.vimeo.com/video/1214533279?h=a1b2c3d4e5
//
// Vimeo deliberately leaves that hash OUT of the "Copy link" field in the
// share panel — it is only in the `</>` Embed snippet. Admins copy the link,
// because that is what a link is for, and every video then failed with
// "Because of its privacy settings, this video cannot be played here."
//
// So we resolve the hash ourselves: given the bare id, the API's
// `player_embed_url` comes back WITH it. Paste the plain link, get a working
// lesson.
//
// The token is server-side only and never reaches the browser. It needs the
// `private` and `video_files` scopes; a read-only personal access token from
// developer.vimeo.com is enough. Without VIMEO_ACCESS_TOKEN set, callers get a
// clear "not configured" and the admin UI falls back to manual entry.

const API = "https://api.vimeo.com";

export interface VimeoLookup {
  /** What to store in module_resource.video_ref — "id" or "id/hash". */
  ref: string;
  id: string;
  hash: string | null;
  title: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  /** Vimeo's own privacy values, so the UI can warn before a learner hits it. */
  privacyView: string | null;
  /** 'public' plays anywhere · 'whitelist' only on domains Vimeo has been told
   *  about · 'private' nowhere at all. */
  privacyEmbed: string | null;
  /** True only for 'public'. A whitelisted video is NOT unconditionally
   *  embeddable — it plays only where Vimeo has been told to allow it, which
   *  is by far the commonest reason a lesson shows the black "Sorry" screen. */
  embeddable: boolean;
  /** Needs this site's domain adding to the video's allowed list on Vimeo. */
  domainRestricted: boolean;
}

export function vimeoConfigured(): boolean {
  return !!process.env.VIMEO_ACCESS_TOKEN;
}

/** Pull the numeric id out of a share link, a player link, or a bare id.
 *  Returns null when there's no id in there at all. */
export function parseVimeoId(input: string): string | null {
  const s = String(input ?? "").trim();
  return (
    s.match(/player\.vimeo\.com\/video\/(\d+)/i)?.[1] ??
    s.match(/vimeo\.com\/(?:video\/)?(\d+)/i)?.[1] ??
    s.match(/^(\d+)\b/)?.[1] ??
    null
  );
}

/** The hash as pasted, if the admin happened to supply one. Used as a fallback
 *  when the API is unreachable so a correct paste still works. */
export function parseVimeoHash(input: string): string | null {
  const s = String(input ?? "").trim();
  return (
    s.match(/[?&]h=([0-9a-z]+)/i)?.[1] ??
    s.match(/vimeo\.com\/(?:video\/)?\d+\/([0-9a-z]+)/i)?.[1] ??
    null
  );
}

type VimeoVideo = {
  name?: string;
  duration?: number;
  player_embed_url?: string;
  link?: string;
  privacy?: { view?: string; embed?: string };
  pictures?: { base_link?: string; sizes?: Array<{ link?: string; width?: number }> };
  embed?: { html?: string };
};

/** Dig the hash out of whichever field carries it. `player_embed_url` is the
 *  documented one, but the embed HTML and the canonical link both contain it
 *  too and cost nothing to check — Vimeo has moved this before. */
function hashFrom(v: VimeoVideo): string | null {
  const candidates = [v.player_embed_url, v.embed?.html, v.link].filter(Boolean) as string[];
  for (const c of candidates) {
    const h = c.match(/[?&]h=([0-9a-z]+)/i)?.[1] ?? c.match(/vimeo\.com\/\d+\/([0-9a-z]+)/i)?.[1];
    if (h) return h;
  }
  return null;
}

/** Look a video up. Throws with a message worth showing an admin. */
export async function lookupVimeo(input: string): Promise<VimeoLookup> {
  const token = process.env.VIMEO_ACCESS_TOKEN;
  if (!token) throw new Error("Vimeo lookup isn't configured on the server");

  const id = parseVimeoId(input);
  if (!id) throw new Error("That doesn't look like a Vimeo link or ID");

  // A hash in the URL is passed through: an unlisted video that the token's
  // account does NOT own is only readable with it.
  const pasted = parseVimeoHash(input);
  const qs = pasted ? `?h=${encodeURIComponent(pasted)}` : "";

  let res: Response;
  try {
    res = await fetch(`${API}/videos/${encodeURIComponent(id)}${qs}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.vimeo.*+json;version=3.4",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("Couldn't reach Vimeo. Check the API's network access and try again.");
  }

  if (res.status === 401) throw new Error("Vimeo rejected the access token — it may be expired or lack the 'private' scope");
  if (res.status === 404) throw new Error("Vimeo has no video with that ID, or this token's account can't see it");
  if (res.status === 429) throw new Error("Vimeo is rate-limiting us. Wait a minute and try again.");
  if (!res.ok) throw new Error(`Vimeo returned ${res.status}`);

  const v = (await res.json()) as VimeoVideo;
  const hash = hashFrom(v) ?? pasted;

  const thumb =
    v.pictures?.sizes?.slice().sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.link ??
    v.pictures?.base_link ??
    null;

  return {
    ref: hash ? `${id}/${hash}` : id,
    id,
    hash,
    title: v.name?.trim() || null,
    // Vimeo reports whole seconds; 0 means "still transcoding", not a 0s video.
    durationSeconds: v.duration && v.duration > 0 ? Math.round(v.duration) : null,
    thumbnailUrl: thumb,
    privacyView: v.privacy?.view ?? null,
    privacyEmbed: v.privacy?.embed ?? null,
    // Only 'public' is unconditionally embeddable. 'whitelist' looks fine in
    // the API response but still 403s everywhere the domain hasn't been added,
    // so it must not be reported as OK — that is precisely the failure that
    // sent us hunting through plans, hashes and privacy modes.
    embeddable: (v.privacy?.embed ?? "public") === "public",
    domainRestricted: (v.privacy?.embed ?? "") === "whitelist",
  };
}
