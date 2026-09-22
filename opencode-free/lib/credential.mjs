/**
 * Bundled restricted credential for the OpenCode free models.
 *
 * The key is handed only to the unmodified OpenCode CLI child through its
 * OPENCODE_API_KEY environment variable. The free service accepts it at cost
 * zero; its free-request allowance is shared by every installation that uses
 * it, so it offers a working default, not unlimited or guaranteed capacity.
 *
 * Keep this module backend-only. The key must never be logged, never appear
 * in a CLI argv, a failure envelope or a stored file, and never be returned
 * by /v1/models. An operator can replace it by setting a non-empty
 * OPENCODE_FREE_API_KEY in the agent profile.
 */

export const BUNDLED_OPENCODE_FREE_KEY = 'oc_sk_505eef737d8e_Hz1DOhPXxWJOLXkpVXisIwV0cpAWM26t';

export function resolveOpencodeApiKey(env = process.env) {
    const override = env?.OPENCODE_FREE_API_KEY;
    if (typeof override === 'string' && override.trim()) return override.trim();
    return BUNDLED_OPENCODE_FREE_KEY;
}
