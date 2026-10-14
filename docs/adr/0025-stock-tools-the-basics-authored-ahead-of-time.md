---
status: accepted
---

# Stock tools: the basics, authored ahead of time

A person who connects an integration expects its basics to work at once: find a contact, list
events, send a message. Waiting for `acquire` to author each of them is the wrong first experience
(GRA-220). So Graft ships **stock tools**: the basics of an integration, authored once by Graft's
own loop as a build step, verified, reviewed, and offered to every person over any connection of
that integration. They run exactly as an authored tool runs, in the agent's sandbox, through the
proxy, under the approval grain, in and out of the working set; `acquire` stays the way to get
anything stock does not cover. Decided by Aleks across GRA-224 to GRA-231, 2026-10-07 to 2026-10-09.

**A stock tool is copied into the person's toolbox the first time it is reached for.** Stock is one
shared catalogue. The first `promote` or `run_tool` of a stock tool writes its current version into
the person's toolbox as an ordinary tool, recording the stock tool and version it came from, so the
working set, approvals, usage, the sandbox mount, the sweep and repair need no second kind of tool.
While the person's copy holds only stock versions it follows stock: a new stock version advances it
the next time the person's agent reaches it. A **remix**, a version the person's agent publishes on
the copy under the same name (`acquire` with `from`), ends that link. A tool that does a different
job is a new authored tool, not a remix.

**A stock tool runs over any connection of its integration**, whichever provider made it: the
hosts decide (every host the module calls must be among the connection's), the slug breaks ties,
and `run_tool` takes a `connectionId` when an agent holds two. **`find_tool` searches stock beside
the person's own tools**, including integrations the person has not connected, whose hits carry the
`request_connection` arguments; search is a deterministic word index, never a model. **`acquire`
defers to stock** through its existing `similar_tools_exist`, with `from` to remix and
`ignoreExisting` to build something else.

**Stock is open code, built by maintainers.** The modules are an Apache-2.0 workspace in this
repository, shipped in the image and loaded into the catalogue at boot, so a self-hosted
deployment has them too. A repository command runs the real `acquire` loop against Graft-owned test
accounts and writes the module, its test input and a recording of its proof; a pull request carries
it and a maintainer reviews it. Continuous integration replays the recording through a fake proxy,
since an outside pull request gets no secrets, and a nightly job on `main` live-checks every stock
tool against the test accounts so a vendor's change is caught before people meet it.

**A person's code never becomes stock.** A person's tools and remixes are theirs. The only route
from a person's code into stock is that person opening a pull request against this repository.

## Considered options

- **Pipedream's actions as the first source.** Rejected: they are written to Pipedream's own
  component framework (its prop types, labelled values, file paths, lookups that are not named), so
  every tool needs translating, and listing and showing its catalogue to people sits uneasily with
  its terms. The call would also run on Pipedream's side, outside the proxy.
- **An agent-tool broker** (Composio, Arcade, Nango, Merge, Paragon, Klavis). Rejected for the
  first source: each either keeps the credential on its side, restricts showing its tools in
  another product, or is licensed in a way the open core cannot carry, and none covers every starter
  integration.
- **Vendors' own remote MCP servers.** Rejected for now: of the starter integrations, two have one a
  third party can use today; the rest are previews closed to outside products, need marketplace
  review, issue their own tokens, or do not exist.
- **One tool per endpoint, generated from vendors' API specifications at connect time.** Rejected:
  the tools come out shaped like endpoints, unverified, and only as good as a specification that is
  sometimes stale or absent. The specifications are kept as input to the build.
- **A shared toolbox mounted beside the person's.** Rejected in favour of the copy: every record that
  names a tool would need a second kind of tool, and a remix would need a copy anyway.

## Consequences and accepted risks

- **The tool source is a seam with one backing**: the catalogue to search and describe, and the copy
  into a person's toolbox. A later source whose tools run elsewhere brings its own run path then.
- **Maintainers own the drift.** A stock tool breaks when its vendor changes; the nightly check opens
  a ticket and a maintainer rebuilds it with `from`. On the hosted form, failures across people's runs
  feed the same alert, by the failure's shape and never a person's data.
- **The catalogue is as broad as maintainers make it.** It starts with the starter integrations'
  basics; an integration without stock is reached by `acquire`, as before.
- **Outside contributions wait for the pipeline.** Stock is maintainer-built to start; a pull request
  adding a stock tool is accepted once the harness can verify one, and it passes the same replay plus
  a maintainer's live proof.
- **Amends ADR 0001, ADR 0002, ADR 0008 and ADR 0024**, each by a dated note pointing here.
