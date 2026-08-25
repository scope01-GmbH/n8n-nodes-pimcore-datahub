import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SchemaIndex } from '../dist/nodes/PimcoreDatahub/Introspection.js';
import {
	buildDocument,
	buildSelectionSet,
	listFieldPaths,
} from '../dist/nodes/PimcoreDatahub/QueryBuilder.js';

/**
 * Captured from pimcore-x.local, endpoint n8n_readwrite: the CustomProduct class
 * with localized fields and an `image` pointing at the asset type, plus the
 * asset special entity. A toy schema would not surface Datahub's shapes — the
 * union-per-relation-field, or a binary that is typed as a plain String.
 */
const raw = JSON.parse(readFileSync(new URL('./fixtures/introspection.json', import.meta.url)));
const schema = new SchemaIndex(raw.data);

const PRODUCT = 'object_CustomProduct';

test('reads the exposed classes off the query type', () => {
	// `getAssetListing` matches the same naming pattern but is a special entity
	// with no `object_` type, so it must not appear as a class.
	assert.deepEqual(schema.readableClasses, ['CustomProduct']);
});

test('reads writable classes per mutation kind', () => {
	assert.deepEqual(schema.writableClasses('create'), ['CustomProduct']);
	assert.ok(schema.hasMutation('updateCustomProduct'));
	assert.ok(schema.hasMutation('createAsset'));
	assert.ok(!schema.hasMutation('updateNotAClass'));
});

test('auto selection takes every scalar', () => {
	const selection = buildSelectionSet(schema, PRODUCT, { mode: 'auto', maxDepth: 0 });

	for (const field of ['id', 'fullpath', 'internalid', 'productNumber', 'priceGross', 'name']) {
		assert.match(selection, new RegExp(`^\\s*${field}$`, 'm'), `missing ${field}`);
	}
});

test('auto selection expands an asset relation without its binary', () => {
	const selection = buildSelectionSet(schema, PRODUCT, { mode: 'auto', maxDepth: 1 });

	assert.match(selection, /image \{/);
	assert.match(selection, /^\s*mimetype$/m);
	// `asset.data` is base64 of the whole file and typed as a plain String, so a
	// listing that selected every scalar would drag every image through n8n.
	assert.doesNotMatch(selection, /^\s*data$/m);
});

test('relation depth 0 omits relations entirely', () => {
	const selection = buildSelectionSet(schema, PRODUCT, { mode: 'auto', maxDepth: 0 });

	assert.doesNotMatch(selection, /image \{/);
	assert.doesNotMatch(selection, /mimetype/);
});

test('auto selection never walks the object tree', () => {
	const selection = buildSelectionSet(schema, PRODUCT, { mode: 'auto', maxDepth: 2 });

	// `children`, `parent` and `_siblings` resolve to a union over every class in
	// the schema; expanding them would emit the whole endpoint.
	assert.doesNotMatch(selection, /^\s*children \{/m);
	assert.doesNotMatch(selection, /^\s*parent \{/m);
	assert.doesNotMatch(selection, /^\s*_siblings \{/m);
});

test('scalarsOnly drops relations, as mutation output requires', () => {
	const selection = buildSelectionSet(schema, PRODUCT, { mode: 'auto', scalarsOnly: true });

	assert.match(selection, /^\s*internalid$/m);
	assert.doesNotMatch(selection, /\{/);
});

test('selected fields fold dot paths into nested selections', () => {
	const selection = buildSelectionSet(schema, PRODUCT, {
		mode: 'selected',
		fields: ['id', 'internalid', 'image.filename', 'image.fullpath'],
	});

	assert.match(selection, /^\s*id$/m);
	assert.match(selection, /^\s*internalid$/m);
	assert.match(selection, /image \{/);
	assert.match(selection, /^\s*filename$/m);
});

test('an explicitly named binary field is still selectable', () => {
	// The exclusion applies to automatic selection only; asking for it is a
	// deliberate act, and the Asset resource does exactly that when downloading.
	const selection = buildSelectionSet(schema, 'asset', {
		mode: 'selected',
		fields: ['id', 'filename', 'data'],
	});

	assert.match(selection, /^\s*data$/m);
});

test('a bare relation path yields the identity stub', () => {
	const selection = buildSelectionSet(schema, PRODUCT, { mode: 'selected', fields: ['image'] });

	assert.match(selection, /image \{ id fullpath \}/);
});

test('raw mode passes the body through and strips outer braces', () => {
	assert.equal(
		buildSelectionSet(null, PRODUCT, { mode: 'raw', raw: '{ id internalid }' }),
		'  id internalid',
	);
	assert.equal(
		buildSelectionSet(null, PRODUCT, { mode: 'raw', raw: 'id internalid' }),
		'  id internalid',
	);
});

test('a missing schema is only fatal outside raw mode', () => {
	assert.throws(
		() => buildSelectionSet(null, PRODUCT, { mode: 'auto' }),
		/introspection is disabled/,
	);
	assert.doesNotThrow(() => buildSelectionSet(null, PRODUCT, { mode: 'raw', raw: 'id' }));
});

test('an unknown class is reported as such', () => {
	assert.throws(
		() => buildSelectionSet(schema, 'object_Nope', { mode: 'auto' }),
		/has no type object_Nope/,
	);
});

test('empty selections are rejected rather than sent', () => {
	assert.throws(
		() => buildSelectionSet(schema, PRODUCT, { mode: 'selected', fields: [] }),
		/No fields selected/,
	);
	assert.throws(
		() => buildSelectionSet(null, PRODUCT, { mode: 'raw', raw: '  ' }),
		/raw selection set is empty/,
	);
});

test('a batched document aliases each operation and hoists every argument', () => {
	const { query, variables } = buildDocument('mutation', [
		{
			alias: 'op0',
			field: 'updateCustomProduct',
			args: [
				{ arg: 'id', type: 'Int', value: 1042 },
				{ arg: 'input', type: 'UpdateCustomProductInput', value: { priceGross: 19.9 } },
			],
			selection: '    success\n    message',
		},
		{
			alias: 'op1',
			field: 'updateCustomProduct',
			args: [
				{ arg: 'id', type: 'Int', value: 1043 },
				{ arg: 'input', type: 'UpdateCustomProductInput', value: { priceGross: 24.5 } },
			],
			selection: '    success\n    message',
		},
	]);

	assert.match(query, /^mutation N8nDatahub\(/);
	assert.match(query, /\$op0_id: Int/);
	assert.match(query, /\$op1_input: UpdateCustomProductInput/);
	assert.match(query, /op0: updateCustomProduct\(id: \$op0_id, input: \$op0_input\)/);
	assert.match(query, /op1: updateCustomProduct\(id: \$op1_id, input: \$op1_input\)/);

	// Values travel as variables, so a JSON filter never needs double escaping.
	assert.deepEqual(variables, {
		op0_id: 1042,
		op0_input: { priceGross: 19.9 },
		op1_id: 1043,
		op1_input: { priceGross: 24.5 },
	});
});

test('an operation without arguments emits no variable header', () => {
	const { query, variables } = buildDocument('query', [
		{ alias: 'op0', field: 'getCustomProductListing', args: [], selection: '    totalCount' },
	]);

	assert.match(query, /^query N8nDatahub \{/);
	assert.deepEqual(variables, {});
});

test('an empty document is refused', () => {
	assert.throws(() => buildDocument('query', []), /empty GraphQL document/);
});

test('field paths offer relations both bare and expanded', () => {
	const paths = listFieldPaths(schema, PRODUCT).map((option) => option.value);

	assert.ok(paths.includes('internalid'));
	assert.ok(paths.includes('image'));
	assert.ok(paths.includes('image.filename'));
	assert.ok(!paths.includes('children'));
});

test('argument names reach the document verbatim', () => {
	// Regression guard: the n8n lint autofixer title-cases `name:` properties, and
	// once did so to the GraphQL argument names, turning `fullpath` into
	// `Fullpath`. The key is `arg` now, and this asserts the casing survives.
	const { query } = buildDocument('query', [
		{
			alias: 'op0',
			field: 'getCustomProduct',
			args: [
				{ arg: 'fullpath', type: 'String', value: '/a/b' },
				{ arg: 'defaultLanguage', type: 'String', value: 'en' },
			],
			selection: '    id',
		},
	]);

	assert.match(query, /fullpath: \$op0_fullpath/);
	assert.match(query, /defaultLanguage: \$op0_defaultLanguage/);
	assert.doesNotMatch(query, /Fullpath|DefaultLanguage/);
});

test('an equality filter uses a bare value, not $eq', () => {
	// Datahub reads an unknown `$op` key as a column name and fails with an SQL
	// error, so equality must be expressed as `{"internalid": "N8N-001"}`.
	assert.equal(JSON.stringify({ internalid: 'N8N-001' }), '{"internalid":"N8N-001"}');
	assert.doesNotMatch(
		readFileSync(
			new URL('../dist/nodes/PimcoreDatahub/PimcoreDatahub.node.js', import.meta.url),
			'utf8',
		),
		/\$eq/,
	);
});

test('a union root becomes one inline fragment per member', () => {
	// `getAssetListing` hands back `asset_tree`, a union of asset and asset_folder.
	// Fields cannot sit on a union directly.
	const selection = buildSelectionSet(schema, 'asset_tree', { mode: 'auto', maxDepth: 0 });

	assert.match(selection, /\.\.\. on asset \{/);
	assert.match(selection, /\.\.\. on asset_folder \{/);
	assert.doesNotMatch(selection.split('...')[0], /\w/);
});

test('extra fields land only on the members that have them', () => {
	const selection = buildSelectionSet(schema, 'asset_tree', {
		mode: 'auto',
		maxDepth: 0,
		extra: ['data', 'mimetype'],
	});

	const [, assetPart, folderPart] = selection.split(/\.\.\. on (?:asset|asset_folder) \{/);

	assert.match(assetPart, /^\s*data$/m);
	assert.doesNotMatch(folderPart, /data/);
	assert.doesNotMatch(folderPart, /mimetype/);
});

test('a union member drops selected fields it does not have', () => {
	const selection = buildSelectionSet(schema, 'asset_tree', {
		mode: 'selected',
		fields: ['id', 'filename', 'mimetype'],
	});

	const [, assetPart, folderPart] = selection.split(/\.\.\. on (?:asset|asset_folder) \{/);

	assert.match(assetPart, /^\s*mimetype$/m);
	assert.match(folderPart, /^\s*filename$/m);
	assert.doesNotMatch(folderPart, /mimetype/);
});
