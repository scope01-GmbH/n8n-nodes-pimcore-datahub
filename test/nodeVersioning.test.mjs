import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PimcoreDatahub } from '../dist/nodes/PimcoreDatahub/PimcoreDatahub.node.js';

const { description } = new PimcoreDatahub();

/** Every property declared under a given name. */
function properties(name) {
	return description.properties.filter((property) => property.name === name);
}

/** Versions a property is gated to, or null when it applies to all of them. */
function versions(property) {
	return property.displayOptions?.show?.['@version'] ?? null;
}

function existsForVersion(name, version) {
	return properties(name).some((property) => {
		const gate = versions(property);

		return gate === null || gate.includes(version);
	});
}

test('keeps declaring version 1 so existing workflows still resolve', () => {
	// A node carries the typeVersion it was created with. 2.0.0 shipped with
	// `version: [2]` alone, which left every workflow built on 1.0.x unable to
	// resolve its own node type: no icon, no rendered parameters.
	assert.deepEqual(description.version, [1, 2]);
});

test('version 1 keeps the parameter shape it was saved with', () => {
	// These are the parameters a 1.0.x workflow actually holds - `published` and
	// `key` at the top level, `input` as the only way to supply field values.
	for (const name of ['published', 'key', 'input']) {
		assert.ok(existsForVersion(name, 1), `${name} must still exist for version 1`);
	}

	// The version 2 UI must not leak into a version 1 node.
	for (const name of ['inputMode', 'fieldsToWrite']) {
		assert.ok(!existsForVersion(name, 1), `${name} must not show on version 1`);
	}
});

test('version 2 gets the mapper and the collections, not the old top-level fields', () => {
	for (const name of ['inputMode', 'fieldsToWrite', 'additionalFields']) {
		assert.ok(existsForVersion(name, 2), `${name} must exist for version 2`);
	}

	// `published` moved into Additional Fields, so nothing declares it at the top
	// level for version 2.
	const published = properties('published');
	assert.ok(published.length > 0);
	assert.ok(published.every((property) => versions(property)?.includes(1)));
	assert.ok(!published.some((property) => versions(property)?.includes(2)));
});

test('the asset fields that moved are still declared for version 1', () => {
	for (const name of ['assetType', 'outputBinaryField', 'thumbnail']) {
		assert.ok(existsForVersion(name, 1), `${name} must still exist for version 1`);
		assert.ok(!existsForVersion(name, 2), `${name} must be in a collection on version 2`);
	}
});

test('every moved parameter has a version 2 home in a collection', () => {
	const collections = properties('additionalFields');
	const offered = new Set(collections.flatMap((c) => c.options.map((option) => option.name)));

	for (const name of ['published', 'key', 'assetType', 'outputBinaryField', 'thumbnail']) {
		assert.ok(offered.has(name), `${name} must be offered in an Additional Fields collection`);
	}
});
