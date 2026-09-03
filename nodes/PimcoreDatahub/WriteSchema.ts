import type { FieldType, ResourceMapperField, ResourceMapperFields } from 'n8n-workflow';

import { unwrapType, type SchemaField, type SchemaIndex } from './Introspection';
import { SYSTEM_METADATA_FIELDS } from './QueryBuilder';

/**
 * Fields the mapper never offers, even when the schema lists them as writable.
 *
 * Identity and placement are set through dedicated parameters (Key, Parent,
 * Published, and the lookup fields), so offering them here as well would give
 * two places to set one value and no rule for which wins. Pimcore's own
 * metadata is read-only, and Datahub's `_`-prefixed fields are internals.
 */
const NEVER_WRITABLE = new Set([
	'children',
	'fullpath',
	'id',
	'key',
	'parent',
	'published',
	...SYSTEM_METADATA_FIELDS,
]);

/** The GraphQL input type Datahub exposes for a class, e.g. `UpdateProductInput`. */
export function inputTypeName(className: string): string {
	return `Update${className}Input`;
}

/**
 * Fields a mutation accepts for a class.
 *
 * Reads the INPUT_OBJECT when the endpoint exposes one, because that is the
 * authoritative writable shape. Endpoints on older data-hub versions answer
 * introspection without `inputFields`, so the read type stands in: it is a
 * superset, which is why the exclusions above are applied to both paths rather
 * than only to the fallback.
 */
export function writableFields(schema: SchemaIndex, className: string): SchemaField[] {
	const declared = schema.getInputFields(inputTypeName(className));
	const source = declared.length > 0 ? declared : schema.getFields(`object_${className}`);

	return source
		.filter((field) => !field.name.startsWith('_'))
		.filter((field) => !NEVER_WRITABLE.has(field.name))
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * n8n field type for a GraphQL field.
 *
 * Relations and structured fields land on `object` / `array`, which the mapper
 * renders as a JSON editor - the right control, since a relation is written as
 * `{"id": 123}` or `{"fullpath": "/a/b"}`. Enums map to `string` rather than
 * `options`: the introspection query does not carry `enumValues`, and a
 * dropdown with no choices is worse than a free text field.
 */
export function fieldTypeFor(field: SchemaField): FieldType {
	const { kind, name, isList } = unwrapType(field.type);

	if (isList) return 'array';
	if (kind === 'OBJECT' || kind === 'INPUT_OBJECT' || kind === 'UNION' || kind === 'INTERFACE') {
		return 'object';
	}

	switch (name) {
		case 'Boolean':
			return 'boolean';
		case 'Int':
		case 'Float':
			return 'number';
		default:
			return 'string';
	}
}

/** True when the field is wrapped in NON_NULL and so must be supplied. */
function isRequired(field: SchemaField): boolean {
	return field.type.kind === 'NON_NULL';
}

/**
 * Writable fields of a class, shaped for the resource mapper component.
 *
 * Every field is optional to n8n unless the schema marks it NON_NULL. Pimcore
 * enforces its own mandatory-field rules server side, and the Omit Mandatory
 * Check option exists precisely so a workflow can write a partial object, so
 * treating a Pimcore-mandatory field as required here would block a supported
 * use.
 */
export function resourceMapperFields(
	schema: SchemaIndex,
	className: string,
): ResourceMapperFields {
	const fields: ResourceMapperField[] = writableFields(schema, className).map((field) => ({
		id: field.name,
		displayName: field.name,
		required: isRequired(field),
		defaultMatch: false,
		canBeUsedToMatch: false,
		display: true,
		type: fieldTypeFor(field),
	}));

	if (fields.length === 0) {
		return {
			fields,
			emptyFieldsNotice: `No writable fields found for ${className}. The endpoint may not expose this class for writing, or introspection may be disabled - switch Input Mode to Raw JSON to write it anyway.`,
		};
	}

	return { fields };
}
