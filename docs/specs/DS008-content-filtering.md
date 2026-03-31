# DS008 -- Content Filtering

## Summary

This specification describes the blacklist-based content filtering system that scans request messages against configurable rules to block prohibited content before it reaches upstream providers.

## Problem

Certain content must be blocked before it is sent to LLM providers: harmful prompts, proprietary data patterns, test strings, or any content matching organizational policies. The filtering must be fast, configurable without code changes, and produce audit-ready logs.

## Design

### Content Extraction

`checkBlacklist()` in `blacklist.mjs` concatenates all message content into a single string for scanning:

1. Iterate over all messages in the request
2. For string content: use directly
3. For array content (multi-part messages): extract `text` from parts with `type === 'text'`
4. Join all content with newline separators

This ensures both simple string messages and multi-modal messages (with text + image parts) are scanned.

### Rule Types

Three match types are supported, evaluated against the concatenated content:

**Exact Match** (`match_type: 'exact'`):

```javascript
matched = allContent === rule.pattern;
```

The entire concatenated content must exactly equal the pattern. Used for blocking specific known-bad prompts verbatim.

**Substring Match** (`match_type: 'substring'`):

```javascript
matched = allContent.includes(rule.pattern);
```

The pattern must appear anywhere in the content. Used for blocking keywords or phrases.

**Regex Match** (`match_type: 'regex'`):

```javascript
const re = new RegExp(rule.pattern, 'i');
matched = re.test(allContent);
```

Case-insensitive regular expression test. Invalid regex patterns are silently skipped (logged but not thrown). Used for complex pattern matching.

### Rule Storage

Rules are stored in the `blacklist_rules` table:

```sql
blacklist_rules (
  id UUID PRIMARY KEY,
  pattern TEXT NOT NULL,
  match_type TEXT CHECK (IN ('exact', 'substring', 'regex')),
  action TEXT DEFAULT 'block',
  description TEXT,
  is_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ
)
```

Only enabled rules (`is_enabled = true`) are loaded by `getEnabledRules()`.

### Evaluation Order

Rules are evaluated in database order. Evaluation stops at the first match -- the first matching rule triggers the block. This is a fail-fast design: if any rule matches, the request is immediately blocked.

### Error Response

When a rule matches, `BlacklistError` is thrown:

```javascript
throw new BlacklistError(
  `Request blocked by content policy rule: ${rule.description || rule.id}`,
  rule.id,
  rule.pattern.slice(0, 50)  // Truncated for audit safety
);
```

**HTTP Response:**
- Status: 400
- Error type: `content_blocked`
- Message includes the rule description or ID for troubleshooting
- The matched pattern is truncated to 50 characters in the error object for audit logging without exposing the full pattern to clients

### Log Recording

When a request is blocked by the blacklist, the pipeline records in `call_logs`:
- `blocked_by_blacklist = true`
- `blacklist_rule_id` = the matching rule's UUID
- `blacklist_match` = truncated pattern excerpt

### Management API

Blacklist rules are managed via `/api/v1/blacklist` CRUD endpoints:
- `GET /api/v1/blacklist` -- list all rules
- `POST /api/v1/blacklist` -- create a new rule
- `PUT /api/v1/blacklist/:id` -- update a rule
- `DELETE /api/v1/blacklist/:id` -- delete a rule

## Implementation

| File | Role |
|------|------|
| `pipeline/blacklist.mjs` | `checkBlacklist()` -- content extraction and rule evaluation |
| `utils/errors.mjs` | `BlacklistError` class |
| `db/blacklist-dao.mjs` | `getEnabledRules()`, CRUD operations |
| `db/schema.sql` | `blacklist_rules` table definition |
| `api/router.mjs` | Blacklist management endpoints |

## Dependencies

- DS001 (Request Pipeline) -- blacklist check runs as part of content filtering
- DS006 (Database Schema) -- blacklist_rules table and call_logs blocked fields
- DS009 (Error Handling) -- BlacklistError in the error hierarchy
