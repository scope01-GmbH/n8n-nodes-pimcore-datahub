import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { SchemaIndex } from '../dist/nodes/PimcoreDatahub/Introspection.js';
import {
	fieldTypeFor,
	inputTypeName,
	resourceMapperFields,
	writableFields,
} from '../dist/nodes/PimcoreDatahub/WriteSchema.js';

const raw = JSON.parse(readFileSync(new URL('./fixtures/introspection.json', import.meta.url)));

/**
 * The captured fixture predates the `inputFields` addition to the introspection
 * query, so `UpdateCustomProductInput` comes back with no writable shape. That
 * makes it the exact case the read-type fallback exists for, and it is used
 * as-is rather than being edited to keep the capture honest.
 */
const schema = new SchemaIndex(raw.data);

/** A schema that does declare its input type, built to exercise that path. */
function schemaWithInputFields(inputFields) {
	return new SchemaIndex({
		__schema: {
			queryType: { name: 'Query' },
			mutationType: { name: 'Mutation' },
			types: [
				{ kind: 'INPUT_OBJECT', name: 'UpdateWidgetInput', fields: null, inputFields },
				{
					kind: 'OBJECT',
					name: 'object_Widget',
					fields: [{ name: 'ignored', type: { kind: 'SCALAR', name: 'String' } }],
				},
			],
		},
	});
}

test('names the input type Datahub exposes for a class', () => {
	assert.equal(inputTypeName('CustomProduct'), 'UpdateCustomProductInput');
});

test('prefers the declared input fields over the read type', () => {
	const withInput = schemaWithInputFields([
		{ name: 'sku', type: { kind: 'SCALAR', name: 'String' } },
		{ name: 'stock', type: { kind: 'SCALAR', name: 'Int' } },
	]);

	assert.deepEqual(
		writableFields(withInput, 'Widget').map((field) => field.name),
		['sku', 'stock'],
	);
});

test('falls back to the read type when the endpoint declares no input fields', () => {
	const names = writableFields(schema, 'CustomProduct').map((field) => field.name);

	// Business fields survive the fallback.
	assert.ok(names.includes('description'));
	assert.ok(names.includes('active'));
});

test('never offers identity, placement or metadata fields', () => {
	const names = new Set(writableFields(schema, 'CustomProduct').map((field) => field.name));

	// Set through dedicated parameters, so offering them here too would give two
	// places to set one value.
	for (const excluded of ['id', 'fullpath', 'key', 'published', 'parent', 'children']) {
		assert.ok(!names.has(excluded), `${excluded} must not be writable`);
	}

	// Pimcore's own read-only metadata.
	for (const excluded of ['creationDate', 'modificationDate', 'classname', 'version']) {
		assert.ok(!names.has(excluded), `${excluded} must not be writable`);
	}

	// Datahub internals.
	assert.ok(![...names].some((name) => name.startsWith('_')));
});

test('exclusions apply to declared input fields too, not just the fallback', () => {
	const withInput = schemaWithInputFields([
		{ name: 'id', type: { kind: 'SCALAR', name: 'ID' } },
		{ name: 'sku', type: { kind: 'SCALAR', name: 'String' } },
	]);

	assert.deepEqual(
		writableFields(withInput, 'Widget').map((field) => field.name),
		['sku'],
	);
});

test('maps GraphQL types onto mapper field types', () => {
	assert.equal(fieldTypeFor({ name: 'a', type: { kind: 'SCALAR', name: 'Boolean' } }), 'boolean');
	assert.equal(fieldTypeFor({ name: 'a', type: { kind: 'SCALAR', name: 'Int' } }), 'number');
	assert.equal(fieldTypeFor({ name: 'a', type: { kind: 'SCALAR', name: 'Float' } }), 'number');
	assert.equal(fieldTypeFor({ name: 'a', type: { kind: 'SCALAR', name: 'String' } }), 'string');

	// An enum has no `enumValues` in the introspection query, so a dropdown would
	// render empty - free text is the honest control.
	assert.equal(fieldTypeFor({ name: 'a', type: { kind: 'ENUM', name: 'Colour' } }), 'string');

	// A relation is written as {"id": 123}, so it wants the JSON editor.
	assert.equal(fieldTypeFor({ name: 'a', type: { kind: 'OBJECT', name: 'asset' } }), 'object');

	assert.equal(
		fieldTypeFor({
			name: 'a',
			type: { kind: 'LIST', name: null, ofType: { kind: 'SCALAR', name: 'String' } },
		}),
		'array',
	);
});

test('a NON_NULL field is the only kind marked required', () => {
	const withInput = schemaWithInputFields([
		{
			name: 'sku',
			type: { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'String' } },
		},
		{ name: 'note', type: { kind: 'SCALAR', name: 'String' } },
	]);

	const { fields } = resourceMapperFields(withInput, 'Widget');

	assert.equal(fields.find((field) => field.id === 'sku').required, true);
	assert.equal(fields.find((field) => field.id === 'note').required, false);
});

test('no field is offered as a matching column', () => {
	// Matching is expressed by Look Up By / Match By, which model id, full path
	// and filterable-field lookups. A second mechanism here would compete.
	const { fields } = resourceMapperFields(schema, 'CustomProduct');

	assert.ok(fields.length > 0);
	assert.ok(fields.every((field) => field.canBeUsedToMatch === false));
	assert.ok(fields.every((field) => field.defaultMatch === false));
	assert.ok(fields.every((field) => field.display === true));
});

test('an unknown class yields a notice pointing at Raw JSON', () => {
	const { fields, emptyFieldsNotice } = resourceMapperFields(schema, 'NoSuchClass');

	assert.deepEqual(fields, []);
	assert.match(emptyFieldsNotice, /Raw JSON/);
});
