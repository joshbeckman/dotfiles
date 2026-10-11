---
name: websearch
description: Use when a task needs current or verifiable information from the web, such as news, releases, prices, product or API documentation, or a fact check, even when the user does not ask for a search. Covers the `websearch` command and which of its three engines to reach for.
---

# Web Search

`websearch` has three engines, and the default is the cheap one.

| invocation | engine | needs | reach for it when |
|---|---|---|---|
| `websearch QUERY` | Ceramic, a lexical index | `CERAMIC_API_KEY` | you know the nouns. "Where is the documentation for X" |
| `websearch --recent QUERY` | OpenAI, a model that searches for itself | `OPENAI_API_KEY` | the answer is recent. "What is the latest X" |
| `websearch --ddg QUERY` | DuckDuckGo's HTML endpoint | nothing | no key is available, or Ceramic comes back empty |

`--json` emits the results as JSON, and `--limit` (1 to 20) sets how many to ask for. Keys come from `s`, so nothing needs exporting. Run `websearch --help` for the rest.

## Choose the engine before you write the query

**Ceramic and DuckDuckGo are lexical.** They match exact words and phrases, and they will not infer intent, synonyms, or missing context. The query is the whole interface, so the next section matters more than anything else here.

**`--recent` is not a search, it is an answer.** It hands the question to a model that writes its own queries, runs several, and returns prose with structured citations. There is no query to craft. It costs an order of magnitude more than Ceramic, around 20,000 tokens for one question against a quarter of a cent per thousand searches, so use it deliberately: for a release, a version, a price, or anything published in the last few months, and for nothing else.

## Writing a query for the lexical engines

Two to eight keywords.

- Keep every hard constraint: the entity, city, state or country, year, product, company, team, league, or event. Dropping one returns results about the wrong thing.
- Replace relative time words such as `latest`, `current`, `recent`, or `today` with the specific year or date. Use the date from your context, or run `date` if unsure.
- Drop task words and filler such as `find`, `search`, `verify`, `official page`, or publisher names, unless the word is part of what is being looked for.
- Drop articles. Avoid prepositions unless they are part of an established name (`United States of America`, `Into the Wild`).
- Add synonyms explicitly. Neither engine will map them.
- Keep word order meaningful (`house cat` and `cat house` differ).

**Never put these in a query:** slashes of any kind (so no URLs, links, or paths), numbers with commas such as `101,342`, or non-Latin characters.

| Question | Bad query | Good query |
|---|---|---|
| What are United Airlines' carry-on size limits? | `carry-on dimensions` | `United Airlines carry-on size` |
| Who performed at the Super Bowl halftime show this year? | `Super Bowl halftime show performer` | `2026 Super Bowl halftime performer` |
| Find the official schedule for Los Angeles bulky item pickup | `find official page schedule Los Angeles` | `Los Angeles bulky item pickup` |
| How do I start investing? | `how do I start investing` | `beginner investing strategies stocks bonds basics` |

For anything that is not a simple lookup, run two or three variants and merge them: one naming the entity (`FAA drone registration`), one using words likely to appear in the answer (`drone registration 250 grams`), and one with synonyms (`recreational drone weight limit`).

## Running it

```sh
websearch "Raspberry Pi OS Trixie release notes"
websearch --ddg --limit 10 "sqlite alter table add foreign key"
websearch --recent "What is the current stable release of Deno?"
```

Ceramic also has an MCP tool, `mcp__ceramic_search__ceramic_search`, which is a thin wrapper over the same engine. It returns identical results, so reach for whichever is closer: the tool when it is in your tool list, `websearch` from a shell, and `websearch` either way when the tool is not available.

## Read the results properly

The first one or two results are usually the answer and the tail is filler. Observed on 2026-10-11:

- `Raspberry Pi OS Trixie release notes` returned the official raspberrypi.com download page at rank 2, whose description contained the release date and Debian version.
- `SQLite add foreign key existing table alter` returned sqlite.org's `ALTER TABLE` page at rank 1, containing the rebuild procedure.
- `latest deno release` returned a MongoDB podcast, a blog template, and a `denoify` repository. Nothing about a Deno release.
- `Deno 2.9` and `Deno 2.9 release notes` returned **zero** results, while `Deno releases` returned the 1.5, 1.6, and 1.15 notes. `deno.com/blog/v2.9` exists and serves 200.

So: good at concept lookups where you know the right nouns, weak on version numbers, dates, and anything whose answer is a recent page. Total results are often fewer than five, sometimes zero. Four of those failures have names, and the names are what make them stick.

**Zero results is a claim about the index, not about the world.** A lexical index has bounded coverage, so an empty result set says only that these words are not indexed together, which is a fact about the engine and not about the page you wanted. Before believing an absence, ask the question that settles it: *would the page I expect actually say these words?* If it would phrase it differently, the empty result says nothing at all.

**A ranked list is a ranking, not a set of candidates.** The tail is filler even when rank 1 is right, so read the top one or two, and require a description to prove itself before trusting the rest. When the top result is the wrong kind of page, the fix is different nouns, not page two.

**A description is somebody else's resolution.** A snippet is a summary that has already dropped its qualifiers, which makes it the highest-risk input you can get: someone else did the compressing, in advance, and the ambiguity left no trace. So fetch the page and name the source before a detail travels anywhere as a fact, and never let a snippet reach another person as one.

And "the evidence is weak" is itself a claim. A hedge that sounds diligent gets past every instinct, so either get the check that would settle it or delete it.

In practice:

- Read the top one or two and fetch the page before relying on a detail. `web_fetch` and `curl` both work.
- When a query returns nothing, rewrite it with different nouns rather than paging through what came back. `--ddg` is a second opinion with a different index, not a better one.
- Say when the evidence is stale or not authoritative, and say what you checked.

## Cite what you used

Answer from the pages you actually read, then list the sources as numbered references:

```
Sources
1. [Title](url)
```

Only cite URLs that appear in the results or in `--recent`'s citations, and only those whose content contributed. Never add a URL from memory, even for an official source you expect to exist. Suggesting that the user check an official site is fine; listing it under Sources is not.

## When search is not enough

- Live structured data such as weather, stock prices, sports scores, or flight status
- The full content of a page beyond the excerpt
- Paywalled or non-public content
- A question whose answer turns on professional judgement, where a keyword match is not the profession
