# n8n-nodes-pimcore-datahub

An [n8n](https://n8n.io/) community node for the **Pimcore Datahub GraphQL API**.

Datahub already exposes every data object over GraphQL. What it does not give you
is a way to use that from n8n without writing GraphQL by hand — Pimcore's own
Workflow Automation blueprints are demos built on generic HTTP Request nodes, and
their docs state that nested structures are excluded from export.

This node reads the endpoint's schema and turns it into dropdowns. Pick a class,
pick fields, run. It also adds the two things Datahub's API does not have:

- **Create or Update** — Datahub has `create` and `update` but no upsert. This
  node resolves identity first (by ID, full path, or any field such as an article
  number), then dispatches the right mutation.
- **Batching** — Datahub writes one object per mutation. This node packs up to
  *Batch Size* items into a single GraphQL document under aliases, which the
  GraphQL spec executes serially. 500 updates is 20 requests, not 500.

## Installation

**Settings → Community Nodes → Install**, then enter:

```
@scope01gmbh/n8n-nodes-pimcore-datahub
```

## Credentials

Create a GraphQL endpoint in Pimcore under **Datahub → Configurations**, give it
an API key in the *Security* tab, and grant workspaces for the classes you want
to reach.

| Field | Example |
|---|---|
| Pimcore URL | `https://pimcore.example.com` (no webservice path) |
| Endpoint Name | `my_endpoint` — the Datahub configuration name |
| API Key | the key from the configuration's Security tab |
| Send API Key As | `Header` (default) or `Query Parameter` |

The key is sent as `X-API-Key`. Use *Query Parameter* only when a proxy strips
custom headers; it puts the key in the URL, where access logs will keep it.

An API key belongs to one Datahub configuration, which is why the endpoint name
lives in the credential rather than on the node. Point several credentials at the
same Pimcore to reach several endpoints.

## Operations

### Data Object

Pick the class from **From List**, populated by introspecting the endpoint, or
switch the locator to **By Name** and type it — which also takes an expression,
so one node can walk several classes, and works on endpoints that have
introspection switched off.

| Operation | Notes |
|---|---|
| Get | By ID or full path. Reads are batched too — 200 IDs is one request. |
| Get Many | Filter, sort, pagination. *Return All* pages through automatically. |
| Create | Needs a key and a parent. |
| Update | By ID or full path. |
| Create or Update | Upsert. See below. |
| Delete | By ID or full path. |

### Asset

| Operation | Notes |
|---|---|
| Get | By ID or full path, optionally with the file as binary data. |
| Get Many | Filter, sort, pagination. Folders come back too — the listing is a tree. |
| Upload | Takes binary data from the item. The Pimcore asset type is detected from the mime type unless you set it. |
| Update | Replace the file, write metadata, or both. |
| Delete | By ID or full path. |

Datahub moves files base64 encoded **inside the GraphQL response**, so
downloading a long listing is memory hungry — asset operations default to a
batch size of 1 for that reason. `asset.data` is a plain `String` in the schema
with nothing to mark it as a binary, so it is left out of *All Scalar Fields*;
switch on **Download File**, or name it explicitly, to fetch it.

To attach an uploaded asset to an object, write the object's image field with
the ID the upload returned: `{"image": {"id": 483}}`.

### GraphQL

Runs any document against the endpoint, with variables. The escape hatch for
custom queries, documents, field collections and object bricks.

## Fields

GraphQL returns only what you ask for, so every read operation has a **Fields**
setting:

- **All Scalar Fields** — every plain field, plus the ID and full path of related
  objects. *Relation Depth* controls how far relations are followed; `0` omits
  them entirely.
- **Selected Fields** — a list built from the endpoint's schema. Relations expand
  into dotted paths (`manufacturer.name`), and the node assembles the inline
  fragments Datahub's union types require.
- **Raw Selection Set** — write the GraphQL yourself. The only mode available on
  an endpoint with introspection disabled.

Writes return the saved object's identity. Switch on **Return Written Object** to
get every scalar back as well. Relations are never returned from a write — see
*Known Pimcore behaviour* below.

Where a query returns a union — an asset listing is a tree of assets *and*
folders — the node writes one inline fragment per member type and drops the
fields a member does not have, so asking for `mimetype` does not break on the
folders in the result.

## Create or Update

```
Match By:      Field Value
Match Field:   number
Match Value:   {{ $json.article_number }}
If Not Found:  Create
Parent Path:   /products/import
```

Field matching runs one lookup document for the whole batch, then one mutation
document — two requests per batch regardless of batch size, not two per item.

If several objects match, the item **fails** with the matching IDs in the
message. Silently updating an arbitrary one of three duplicates is how a PIM
quietly loses data.

## Localized fields

One call reads or writes **one** language, chosen by the **Default Language**
option. To write two languages, send the item twice:

```
Upsert (Default Language: en)  →  Update (Default Language: de)
```

The second node addresses the object by the ID the first one returned. Note that
localized fields marked mandatory are mandatory *in every language*, so a first
write that fills only English needs **Omit Mandatory Check** switched on.

## Batching and failure

Batched writes are not a transaction. GraphQL executes aliased mutations one
after another, so item 7 failing does not roll back items 0–6. Each item carries
its own result, and with **Continue On Fail** only the failed items get an
`error` key. Set **Batch Size** to `1` for one request per item.

## Filters

The **Filter** option takes Pimcore's Datahub filter syntax as JSON. A bare value
means equals — there is no `$eq` operator, and an unrecognised `$op` key is read
as a column name, which surfaces as an SQL error:

```json
{ "number": "SW-100" }
{ "number": { "$like": "SW-%" } }
{ "$and": [{ "active": 1 }, { "priceGross": { "$gt": 100 } }] }
```

Available operators: `$like`, `$notlike`, `$not`, `$notnull`, `$gt`, `$gte`,
`$lt`, `$lte`, and `$and` / `$or` for grouping.

## Known Pimcore behaviour

Things that look like node bugs but are not:

- **A field is always `null`.** Datahub's default `not_allowed_policy` returns
  `null` rather than an error for a field the endpoint's workspace does not
  grant. Check the workspace permissions, not the query.
- **Relations cannot be selected from a write.** data-hub v2.3.0 crashes
  resolving a relation on a mutation's `output` (`resolveValue(): Argument #1
  ($descriptor) must be of type BaseDescriptor, array given`). The node keeps
  mutation output to scalars; read relations back with a Get.
- **`success: false` does not always mean nothing was written.** Pimcore save
  listeners can reject an object after values are set. Check the message.
- **Introspection can be switched off** per endpoint. The class list and field
  picker then return an error explaining it; switch the class locator to *By
  Name* and use a raw selection set.
- **Asset mutations answer with `assetData`,** where object mutations use
  `output`. Nothing in the schema hints at the inconsistency; the node handles
  it, but a hand-written mutation has to know.
- **`createAsset` demands a `type`,** which Pimcore turns straight into an
  `Asset\Image`, `Asset\Document` and so on. A wrong value yields an asset of
  the wrong class rather than an error, so the node detects it from the binary.

## Development

```bash
npm install
npm run build     # compile to dist/
npm test          # unit tests (build + node --test)
npm run lint      # n8n community node lint
```

The unit tests run against `test/fixtures/introspection.json`, captured from a
real Pimcore instance, so the selection-set builder is exercised against real
union-typed relations and a real asset tree rather than a toy schema.

### Testing against a running n8n

Two ways to get the node into a local n8n, and they are mutually exclusive —
both target `~/.n8n/nodes/node_modules/<package>`.

**Released build** (what a user gets):

```bash
docker exec n8n sh -c 'cd /home/node/.n8n/nodes && \
  npm install @scope01gmbh/n8n-nodes-pimcore-datahub@latest'
docker restart n8n
```

**Working copy** (for iterating): bind-mount the repo over that same path when
starting the container, and `npm run build` after each change.

```bash
docker run -d --name n8n -p 5678:5678 \
  -v n8n_data:/home/node/.n8n \
  -v "$PWD":/home/node/.n8n/nodes/node_modules/@scope01gmbh/n8n-nodes-pimcore-datahub \
  --add-host pimcore-x.local:host-gateway \
  docker.n8n.io/n8nio/n8n
```

Mounting into `~/.n8n/custom` instead does **not** work: that path cannot
resolve `n8n-workflow`, so the node loads as nothing at all with no error.

If you swap from the bind mount back to the npm install, delete the empty
directory the mount leaves behind first — otherwise n8n finds a package folder
with no `package.json` and logs *failed to load package metadata*, which reads
like a corrupt download rather than a leftover mountpoint.

`examples/` holds importable credentials and five workflows covering reads,
two-language upserts, a full asset round trip, hand-written GraphQL, an endpoint
without introspection, and a cleanup pass. See `examples/README.md`.

> **Note on the linter:** `npm run lint -- --fix` rewrites `name:` properties into
> title case. GraphQL argument names are therefore keyed `arg:` in
> `QueryBuilder.ts`, not `name:`, so that `fullpath` does not silently become
> `Fullpath`. There is a regression test for this.

## License

MIT
