import { isProfileId, type ProfileId } from "./types.ts";

const KEY = "aether-mux:profile";

/**
 * The selected profile is the only thing kept in localStorage: it is not
 * sensitive and must be readable synchronously before any runtime loads.
 * Precedence: ?profile= URL param > stored preference > "light".
 */
export function resolveProfile(search: string = location.search): ProfileId {
  const fromUrl = new URLSearchParams(search).get("profile");
  if (isProfileId(fromUrl)) return fromUrl;
  try {
    const stored = localStorage.getItem(KEY);
    if (isProfileId(stored)) return stored;
  } catch {
    // Storage can throw in some privacy modes; fall through to the default.
  }
  return "light";
}

export function saveProfile(profile: ProfileId): void {
  try {
    localStorage.setItem(KEY, profile);
  } catch {
    /* non-fatal */
  }
}

export function clearPreferences(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* non-fatal */
  }
}
