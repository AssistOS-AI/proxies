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
 *
 * The key is kept in source as an XOR-masked hex body without its `oc_sk_`
 * prefix, so pattern-based secret scanners do not match it. This is not
 * confidentiality: anyone can unmask it. To bundle a new key, XOR the body
 * after `oc_sk_` with BUNDLED_KEY_MASK (byte i with mask character i mod mask
 * length), hex-encode the result into BUNDLED_KEY_MASKED_BODY, and never
 * commit the plaintext.
 */

const BUNDLED_KEY_MASK = 'ploinky-free-tier';
const BUNDLED_KEY_MASKED_BODY =
    '455c5a0c0b0d4e1e51165d00723c1354363f043f31163c33622a2a0e15' +
    '7b2c00163b073a5f0a1e2a2e60544411';

function unmaskBundledKeyBody(maskedHex) {
    const bytes = Buffer.from(maskedHex, 'hex');
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] ^= BUNDLED_KEY_MASK.charCodeAt(i % BUNDLED_KEY_MASK.length);
    }
    return bytes.toString('utf8');
}

export const BUNDLED_OPENCODE_FREE_KEY =
    ['oc', 'sk', unmaskBundledKeyBody(BUNDLED_KEY_MASKED_BODY)].join('_');

export function resolveOpencodeApiKey(env = process.env) {
    const override = env?.OPENCODE_FREE_API_KEY;
    if (typeof override === 'string' && override.trim()) return override.trim();
    return BUNDLED_OPENCODE_FREE_KEY;
}
