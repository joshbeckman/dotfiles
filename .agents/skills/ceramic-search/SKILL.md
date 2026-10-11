---
name: ceramic-search
description: Use when a task needs current or verifiable information from the web, such as news, releases, prices, product or API documentation, or a fact check, even when the user does not ask for a search. Searches with Ceramic, a keyword-based engine.
---

# Ceramic Search

Ceramic is a lexical (keyword-based) engine. It matches exact words and phrases; it does not infer intent, synonyms, or missing context from a vague query. The query is the whole interface, so how it is written decides whether the results are useful.

## Rewrite the question as keywords

Convert the question into queries of **2 to 8 words**.

- Extract the specific entities, topics, locations, and dates.
- **Keep every hard constraint**: the entity, city, state or country, year, product, company, team, league, or event. Dropping one returns results about the wrong thing.
- Replace relative time words such as `latest`, `current`, `recent`, `this year`, or `today` with the specific year or date. Use the date from your context, or run `date` if unsure.
- Drop task words and filler such as `find`, `search`, `verify`, `official page`, or publisher names, unless the word is part of what is being looked for.
- Drop articles. Avoid prepositions unless they are part of an established name (`United States of America`, `Into the Wild`).
- Add synonyms explicitly. Ceramic will not map them.
- Keep word order meaningful (`house cat` and `cat house` differ).

**Never put these in a query:** slashes of any kind (so no URLs, links, or paths), numbers with commas such as `101,342`, or non-Latin characters.

| Question | Bad query | Good query |
|---|---|---|
| What are United Airlines' carry-on size limits? | `carry-on dimensions` | `United Airlines carry-on size` |
| Who performed at the Super Bowl halftime show this year? | `Super Bowl halftime show performer` | `2026 Super Bowl halftime performer` |
| Find the official schedule for Los Angeles bulky item pickup | `find official page schedule Los Angeles` | `Los Angeles bulky item pickup` |
| How do I start investing? | `how do I start investing` | `beginner investing strategies stocks bonds basics` |

For anything that is not a simple lookup, run two or three variants and merge them: one naming the entity (`FAA drone registration`), one using words likely to appear in the answer (`drone registration 250 grams`), and one with synonyms (`recreational drone weight limit`).

## Run the search

Both methods take the same parameters:

- `query` (required): the keyword query
- `maxResults` (optional): 1 to 20, default 10
- `maxDescriptionLength` (optional): characters per description, 1000 to 8000, default 3000. The API rejects anything outside that range with a 422.

**Prefer the MCP tool.** If `mcp__ceramic_search__ceramic_search` is available, call it. It is a thin wrapper over the same engine, so results are identical and the only difference is authentication.

**Fallback: the API.** Secrets live in `s`, so inject the key for the one command rather than exporting it:

```sh
s CERAMIC_API_KEY -- sh -c 'curl -sS https://api.ceramic.ai/search \
  -H "Authorization: Bearer $CERAMIC_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"Raspberry Pi OS Trixie release notes\", \"maxResults\": 5}"'
```

Results are under `result.results`, ordered by relevance, each with `title`, `url`, and `description`. If the key is missing or the API returns 401, tell the user to create one at https://platform.ceramic.ai/keys and store it with `s set CERAMIC_API_KEY`. Never print, echo, or log the key.

## Read the results properly

The first one or two results are usually the answer and the tail is filler. Observed on 2026-10-11:

- `Raspberry Pi OS Trixie release notes` returned the official raspberrypi.com download page at rank 2, whose description contained the release date and Debian version.
- `SQLite add foreign key existing table alter` returned sqlite.org's `ALTER TABLE` page at rank 1, containing the rebuild procedure.
- `latest deno release` returned a MongoDB podcast, a blog template, and a `denoify` repository. Nothing about a Deno release.
- `Deno 2.9` and `Deno 2.9 release notes` returned **zero** results, while `Deno releases` returned the 1.5, 1.6, and 1.15 notes. `deno.com/blog/v2.9` exists and serves 200.

So: good at concept lookups where you know the right nouns, weak on version numbers, dates, and anything whose answer is a recent page. Total results are often fewer than five, sometimes zero.

- Read the top one or two, and treat the rest as keyword noise until the description proves otherwise.
- **Fetch the page before relying on a detail.** The description is an excerpt, and it may be stale. `web_fetch` and `curl` both work.
- When a query returns nothing, or only the wrong kind of page, rewrite it with different nouns rather than paging through what came back.
- Say when the evidence is weak, stale, or not authoritative, instead of presenting it as fact.

## Cite what you used

Answer from the descriptions you actually read, then list the sources as numbered references:

```
Sources
1. [Title](url)
```

Only cite URLs that appear in the results, and only those whose content contributed. Never add a URL from memory, even for an official source you expect to exist. Suggesting that the user check an official site is fine; listing it under Sources is not.

## When Ceramic is not enough

Ceramic returns indexed pages with text excerpts. Reach for something else, or say so plainly, when the task needs:

- Live structured data such as weather, stock prices, sports scores, or flight status
- The full content of a page beyond the excerpt
- Paywalled or non-public content
- The most recent release, version, or announcement, where the index has not caught up

### Recency: let a model write its own queries

For "what is the latest X", do not fight the query grammar. The index lags on recent pages and version-numbered queries often return nothing, so ask a model that searches for itself:

```sh
s OPENAI_API_KEY -- sh -c 'curl -sS https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"gpt-5\", \"tools\": [{\"type\": \"web_search\"}], \"input\": \"What is the current stable release of Deno?\"}"'
```

The model writes its own queries, runs several, and returns an answer with the sources it used as annotations. On the Deno question above it returned v2.9.7 with a link to the release page, where Ceramic returned nothing at all for the same question.

`gpt-5-search-api` is the same idea through `/v1/chat/completions`, and that endpoint is the only one that accepts it. Prefer the Responses API call above, because it can run more than one query and returns structured citations rather than a citation in the prose.

This costs an order of magnitude more than Ceramic, around 20,000 tokens for one question against a quarter of a cent per thousand searches. Use it deliberately rather than by default: read the answer, keep the citations, and do not repeat its claims as your own without the sources.
