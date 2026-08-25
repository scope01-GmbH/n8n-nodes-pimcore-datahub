# Example workflows

Importable credentials and workflows for the local `pimcore-x.local` instance.
They assume the three Datahub endpoints created by
`scripts/create-datahub-endpoints.php`, which expose the **CustomProduct** class
and the asset tree.

## Import

```bash
docker exec n8n sh -c 'cd /home/node && \
  n8n import:credentials --input=/home/node/.n8n/nodes/node_modules/@scope01gmbh/n8n-nodes-pimcore-datahub/examples/credentials.pimcore-x.json && \
  n8n import:workflow --separate --input=/home/node/.n8n/nodes/node_modules/@scope01gmbh/n8n-nodes-pimcore-datahub/examples/'
```

Run one from the CLI (use a spare broker port so it does not collide with the
running server):

```bash
docker exec -e N8N_RUNNERS_BROKER_PORT=5779 n8n \
  sh -c 'cd /home/node && n8n execute --id=pimcoreRead01'
```

## Credentials

| Name | Endpoint | Grants |
|---|---|---|
| Pimcore Datahub - pimcore-x (read/write) | `n8n_readwrite` | Read `/custom products` and all assets; full CRUD inside both `/n8n-sandbox` folders |
| Pimcore Datahub - pimcore-x (read only) | `n8n_read` | Read `/custom products` and all assets |
| Pimcore Datahub - pimcore-x (introspection off) | `n8n_locked` | Read `CustomProduct`, no introspection |

Writes are fenced to `/n8n-sandbox` (objects) and `/n8n-sandbox` (assets), so no
example can touch the two real products under `/custom products` or anything in
the Shopware asset tree.

## Workflows

**01 Read CustomProducts** (`pimcoreRead01`) — `Get Many` with a filter, a sort
and an explicit field list including `image.filename`. The class comes from the
resource locator's *From List* mode.

**02 Upsert CustomProducts in two languages** (`pimcoreUpsert02`) — three
ERP-shaped rows upserted by `internalid`, then a second pass writing the German
name by ID. Re-runnable: the first run creates, every later run updates.

**03 Asset round trip** (`pimcoreAssets03`) — the whole asset path in one
workflow:

```
Get Many (download) → Upload → attach to product → read it back
```

Downloads an existing image into n8n binary data, uploads it into the sandbox
under a new name with a metadata entry, links it to `N8N-P-001` through the
`image` field, then reads the product back to confirm the link. Shows that the
asset type is detected from the binary's mime type, and that `image` takes an
`ImageInput`, which is just `{ "id": 123 }`.

**04 Hand-written GraphQL** (`pimcoreManual04`) — three ways to bypass the
mapping UI:

- a hand-written query with typed variables, against the read endpoint;
- a hand-written mutation with **two aliased operations in one document** — the
  same shape the batched operations build for you;
- the endpoint that refuses introspection, where the class is typed into the
  resource locator's *By Name* mode and the selection set is written by hand.

**05 Clean the sandbox** (`pimcoreClean05`) — deletes everything the examples
created, objects and assets, in batches.

## Fixtures on the Pimcore side

`scripts/create-datahub-endpoints.php` is idempotent — re-running it replaces the
three configurations and their workspaces, and creates both `/n8n-sandbox`
folders if missing:

```bash
docker exec pimcore-demo-web php /var/www/html/<path>/create-datahub-endpoints.php
```

To point the fixtures at a different class, change `CLASSES` and `READ_ROOT` at
the top of that script; the column config is derived from the class's own field
definitions, so nothing else needs editing.
