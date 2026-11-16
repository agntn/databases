# @agntn/databases docs

The rules every `*.agntn.dev` site shares live in the agntn design system. This file records only what this site owns and where it departs.

## Instruments

| File | Where it sits | Object |
| --- | --- | --- |
| `LandingQuery.vue` | under the hero zone | one recorded `databases_query` call at a time, as the tool answered |
| `LandingVerdicts.vue` | feature "Reads stay reads" | statements and what the read guard said, for a file and for D1 |
| `LandingReferences.vue` | feature "A name, not a password" | references and the engine each one opens |
| `LandingProviders.vue` | registry section of the landing | every engine as a cell |
| `LandingStart.vue` | closing section of the landing | install line and the first query |
| `ProviderRoster.vue` | `/providers` and each engine page | the registry as a roster |

## Anatomy

- **LandingQuery** is a rotating dossier. Bar with the tool and the file, subject band with the engine glyph in the reticle (a crossed shield for a refusal), the question as the name and the first row or the refusal as the line, the SQL in a four line pane, a five row readout led by the verdict in the accent, one gauge tick per query, the full tool response in the dialog, previous and next in the footer.
- **LandingVerdicts** and **LandingReferences** are small instruments beside text with five rows each: the verdict or the engine as the label, the statement or the reference as the value, the rest in a tooltip.
- **LandingProviders** shows the engines as cells (glyph, key, where the data lives, node). The tooltip says how read-only is enforced.
- **ProviderRoster** has four columns: provider with its place in the registry, engine, reference, and the read-only mechanism behind a leader, in full in the tooltip.

## Data

- Everything the landing shows comes from `app/data/samples.json`, built by `scripts/samples.mjs`. It writes a small record shop to `/var/tmp/databases-landing/shop.db`, runs the real `databases_query` executor, the real read guard and the real reference parser, then removes the file. The root test `test/docs.test.ts` rebuilds it and compares, so a change to an executor, the guard or the parser has to regenerate it: `node docs/scripts/samples.mjs`.
- Counts (engines, tools) are read from that file, which reads them from the registry and the tool list. No page types one in.

## Differences

- **No playground.** A query needs a database, and a page that opens one for anyone is a proxy into somebody's data. The landing replays calls recorded at build time and says so in the footer.
- **No `/mcp` for the tools.** The Docus endpoint serves the pages of this site only, for the same reason.
- **Enabled writes.** The hero metric shows the number of enabled write tools, calculated dynamically from `WRITING.length`.
- **Brand glyphs in the reticle.** SQLite, PostgreSQL and Cloudflare come from the monochrome `simple-icons` set, since the subjects are engines.
