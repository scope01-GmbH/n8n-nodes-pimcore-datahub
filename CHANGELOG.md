# Changelog

## 2.0.0

**Breaking.** Create, Update and Create or Update no longer take field values
from a single `Input` JSON field. They take an **Input Mode**: *Mapped Fields*,
backed by n8n's resource mapper and the class's own schema, or *Raw JSON*, which
behaves as the old `Input` field did. Existing workflows must be reopened and
their field values re-entered — pick **Raw JSON** to keep the previous shape and
paste the old JSON back in.

- Added a **Fields to Write** resource mapper for data object writes. Writable
  fields are read from the endpoint's `Update<Class>Input` type, typed from the
  schema, and offered one input per field, with *Map Automatically* narrowing an
  incoming item to the fields the class accepts.
- The introspection query now requests `inputFields`, so the writable shape of a
  class comes from the mutation's own input type. Endpoints that answer without
  it fall back to the read type, minus identity, placement and metadata fields.
- Optional parameters moved under **Additional Fields** collections: `Published`
  and the upsert `Key` on data objects, `Asset Type` on upload, and
  `Output Binary Field` and `Thumbnail` on asset reads. `Download File` and
  `Replace File` stay top level — they gate required fields.
- Node version is now 2.

## 1.0.3

- Fixed the codex `node` field to carry the package name as its prefix
  (`@scope01gmbh/n8n-nodes-pimcore-datahub.pimcoreDatahub`) instead of
  `n8n-nodes-base.`.

## 1.0.2

- Mutation output selection and GraphQL error detail fixes.

## 1.0.1

- Republished through GitHub Actions to carry an npm provenance attestation.

## 1.0.0

- Initial release.
