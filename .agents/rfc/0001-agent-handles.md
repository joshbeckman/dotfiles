# RFC 0001: Agent Handles

Subaddressing for identity, not just delivery.

**Status:** Draft. This is a personal convention, not an IETF document. It is
normative for the tooling in this repository (`agent-mail`, `agent-trailer`,
`agent-nvim-keywords`, the identity registry) and descriptive everywhere else.

**Authors:** Josh Beckman (@joshbeckman), with agents of Lantern and Hearth (@+coral-tanner-of-lantern, @+simoom-farrier-of-hearth).

## 1. Motivation

Agents need addresses to collaborate. Once a session has a stable,
assigned identity, ordinary text conventions can make
parallel agent sessions legible, reachable, and accountable in prose, commits, mail,
and mentions.

Email solved a version of this decades ago: `user+detail@domain` routes to
`user` while naming a facet of them. [RFC 5233](https://www.rfc-editor.org/rfc/rfc5233)
standardizes filtering on that split; the `+` separator itself is convention
riding on a permissive grammar. This document applies the same move to
usernames: `@joshbeckman+foobar` names an agent operating under
`@joshbeckman`, and `@+foobar` is its relative form. No general-username
equivalent of RFC 5233 exists; this is that convention.

## 2. Requirements Language

The key words MUST, MUST NOT, and SHOULD are to be interpreted as described
in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) as updated by
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174): only uppercase keywords
are normative, so a lowercase "may" in this document is plain English.

## 3. Terminology

- **Account:** a human's username on some platform (`joshbeckman`). The
  accountable party.
- **Agent:** an AI session operating under an account. An agent is a
  *session*, not a persona: its name is allocated once, never reused, and dies
  with the session. Sessions may be resumed.
- **Realm:** the per-computer namespace partition (`lantern`, `hearth`). One
  realm per machine. Realms let machines allocate names independently without
  producing the same public identity.
- **Registry:** the append-only local claim store
  (`~/.pi/agent/identities/by-name/<handle>`) that makes allocation
  without replacement true.
- **Handle:** the lowercase slug form of an agent's name. The subject of this
  document.

## 4. Syntax

Using [RFC 5234](https://www.rfc-editor.org/rfc/rfc5234) ABNF:

```abnf
word        = 1*(%x61-7A / %x30-39)        ; lowercase letters and digits
slug        = word *("-" word)
realm       = word
base        = word "-" word                ; first-name "-" surname
handle      = base "-of-" realm            ; canonical
            / base                         ; grandfathered pre-realm sessions
account     = slug                         ; platform username, lowercased

unqualified = "@+" handle                  ; relative: within one realm/account
qualified   = "@" account "+" handle       ; absolute: across accounts
mailbox     = local "+" handle "@" domain  ; RFC 5321 address, RFC 5233 routing
transport   = handle "-" session8          ; agent-mail delivery address
session8    = 8(%x30-39 / %x61-66)         ; first 8 hex chars of session id
```

`session8` is timestamp, not entropy. Session ids are UUIDv7, whose first 48
bits are the unix millisecond clock; the first 8 hex characters are the top
32 of those bits, constant for 65.536 seconds. Every session started in the
same window — exactly the batch-spawned siblings most likely to be confused —
shares a `session8`. Uniqueness in the transport address comes entirely from
the handle (Section 3: names are never reused). Tools MUST match on the
handle and MUST NOT treat `session8` as identifying; it is retained as a
human-readable start-time cohort marker and a tie to the full session id.
This was found the expensive way: a suffix-only scratchpad glob returned an
arbitrary sibling from a nine-session cohort spawned in one window. Hashing
the full id was considered and rejected: it adds entropy nothing needs and
destroys the readable timestamp.

The display form (`Coral Tanner of Lantern`) maps to the handle
(`coral-tanner-of-lantern`) by lowercasing and collapsing every run of
non-alphanumerics to a single hyphen. Tools MUST use one shared
implementation of this mapping; two implementations of the same key is how
this system has already produced one bug.

## 5. Canonical Form

The canonical written form of an agent handle is the realm-suffixed slug,
identical to the registry claim filename, the keywords-dictionary entry, and
the commit-trailer subaddress. One string, so one grep covers every surface.

Writers SHOULD use the canonical form in prose. Pre-realm handles (bare
`base`) remain valid for the sessions that carry them; consumers MUST accept
both, and resolvers SHOULD retry a bare handle with the local realm suffix
before failing (as `agent-trailer` does).

## 6. Addressing Forms

| Form | Example | Where it is valid |
|---|---|---|
| Unqualified | `@+coral-tanner-of-lantern` | Prose within one account's world |
| Qualified | `@joshbeckman+coral-tanner-of-lantern` | Prose anywhere |
| Mailbox | `josh+coral-tanner-of-lantern@joshbeckman.org` | Email, commit trailers |
| Transport | `coral-tanner-of-lantern-019ffdfc` | `agent-mail --to/--from` |
| Registry claim | `coral-tanner-of-lantern` | Filesystem, dictionaries |

The unqualified form is relative addressing, like a bare hostname; the
qualified form is absolute, like an FQDN. The mailbox form is the only one
that is both globally unique and deliverable today, so it is the
disambiguator of last resort.

## 7. Degradation Properties

The convention is designed so that *other people's parsers* enforce its
safety, in both directions:

- `@+handle` fails platform (e.g. GitHub, Slack) mention grammar entirely. A pasted
  agent handle pings nobody.
- `@account+handle` tokenizes as `@account`. A stranger's platform routes the
  mention to the accountable human, not to a nonexistent or squatted agent
  account.

Misuse either does nothing or notifies the owner. Neither direction can page
a stranger. This property rests on current tokenizer behavior (observed, not
contracted); see Security Considerations.

## 8. Attribution

An agent's prose travels under its account's name, so the reader deserves to
know which hands typed it. Anything an agent writes that a person will read
as the account's MUST carry the trailer:

```
Co-authored-by: AI <Display Name> (<harness>/<provider>/<model>) <mailbox>
Co-authored-by: AI <Display Name> (<harness>/<provider>/<model>) @+handle
```

The address slot varies by surface. Commits carry the mailbox form in RFC-822
angle brackets, because that is the one field GitHub parses for co-author
credit. Every other surface carries the relative handle **unbracketed**. One
pattern — `+<handle>` — matches an agent's work across commits and comments
alike either way; the delimiters are not part of the match.

Prose handles MUST NOT be wrapped in angle brackets. `<@…>` is Slack's
user-mention syntax and `<…>` its entity delimiter generally, so `<@+handle>`
hands a token that no parser accepts (Section 7) to the one grammar where
`<@` is meaningful, and the safety of Section 7 rests on nothing trying to
resolve it. Unbracketed also avoids the differing treatment of unknown
`<…>` tokens by HTML sanitizers and by editors like Notion, Jira, and Linear.
The `@+` sigil already marks where the slot begins. The display name
is retained because the two are the same information (Section 5) presented
for different readers: GitHub's commit UI displays the name, and prose reads
as prose. Markdown links such as `[name](@+handle)` MUST NOT be used: GFM
emits a relative href that resolves to a broken URL (see Section 9 for the
dereference that would change this).

Agents MUST generate the trailer with `agent-trailer` from runtime state and
MUST NOT write it from memory; models guess their own names wrong.

## 9. Dereference (Future)

The qualified form is one `@`-swap away from an
[`acct:` URI](https://www.rfc-editor.org/rfc/rfc7565):
`acct:joshbeckman+coral-tanner-of-lantern@joshbeckman.org`. Serving
[WebFinger](https://www.rfc-editor.org/rfc/rfc7033) for those URIs would make
handles dereferenceable to an identity document (display name, session,
harness, active/retired) using only deployed standards. (Not implemented.)

## 10. Security Considerations

- **Handles are not authentication.** A handle in prose is a claim anyone can
  type. The trailer generated from runtime environment is the strongest
  attribution this system offers, and it is still only as trustworthy as the
  machine that emitted it.
- **Parser drift.** Section 7 depends on platforms staying strict about `+`.
  If a tokenizer loosens, `@account+handle` degrades safely (still pings the
  owner), but `@+handle` could begin resolving `handle` as a username, and
  canonical handles are registrable username shapes. The realm suffix makes
  accidental collision unlikely, not impossible.
- **Registry loss.** If a machine's registry is destroyed, its realm may
  reissue names. Public artifacts remain correctly attributed (the trailer
  captured harness and date), but a grepped handle may then span two
  sessions. Disambiguate by date and harness tuple.
- **Cross-account collisions.** Handle uniqueness is per realm. Two accounts
  can each have an agent named `foobar`; only the qualified and mailbox forms
  distinguish them.

## 11. Prior Art

- [RFC 5233](https://www.rfc-editor.org/rfc/rfc5233): subaddress filtering for email; the shape this borrows.
- [RFC 7622](https://www.rfc-editor.org/rfc/rfc7622): XMPP full JIDs; a resourcepart names a *session* under an account, the closest semantic match.
- [RFC 7565](https://www.rfc-editor.org/rfc/rfc7565) and [RFC 7033](https://www.rfc-editor.org/rfc/rfc7033): the dereference path.
- [W3C DID URLs](https://www.w3.org/TR/did-core/): fragments naming keys and services under an identity.
- AT Protocol handles: agent-as-subdomain, delegation via DNS.
- GitHub's `name[bot]` suffix: a platform-blessed non-human marker, but platform-owned namespace.

---

Co-authored-by: AI Coral Tanner of Lantern (pi-0.84.3/anthropic/claude-fable-5)
