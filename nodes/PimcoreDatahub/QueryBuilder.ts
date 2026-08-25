import type { IDataObject } from 'n8n-workflow';

import { isLeafField, unwrapType, type SchemaIndex } from './Introspection';

/**
 * Tree-walking fields every Pimcore object carries.
 *
 * They resolve to `object_tree`, a union over every class in the endpoint, so
 * expanding them automatically would produce a document listing the whole
 * schema. Users who want them ask for them explicitly.
 */
const TREE_FIELDS = new Set(['children', 'parent', 'siblings', '_siblings']);

/** Fields on a related object that identify it well enough to be useful. */
const RELATION_STUB = ['id', 'fullpath'];

/**
 * Fields that return the whole binary, base64 encoded, keyed by owning type.
 *
 * `asset.data` is a plain `String` in the schema, so nothing distinguishes it
 * from a label until it arrives. A CustomProduct carries an `image`, and a
 * listing of 200 products that selected every scalar would drag 200 encoded
 * image files through the workflow. Excluded from automatic selection only —
 * naming it explicitly, or asking the Asset resource to download, still works.
 */
const BINARY_FIELDS = new Map<string, Set<string>>([['asset', new Set(['data'])]]);

export interface SelectionOptions {
	/** `auto` walks the schema, `selected` honours `fields`, `raw` passes text through. */
	mode: 'auto' | 'selected' | 'raw';
	/** Dot separated field paths, e.g. `manufacturer.name`. Used by `selected`. */
	fields?: string[];
	/** A selection set body written by hand. Used by `raw`. */
	raw?: string;
	/** How deep `auto` follows relations. 1 means scalars plus relation stubs. */
	maxDepth?: number;
	/**
	 * Extra field lines to append, e.g. `data(thumbnail: "content")`.
	 *
	 * Added only where the type actually has the field, so a union root can carry
	 * them on the members that support them and leave the rest alone.
	 */
	extra?: string[];
	/**
	 * Restricts the selection to scalar fields.
	 *
	 * Required for mutation results: data-hub v2.3.0 crashes resolving a relation
	 * field on a mutation's `output` (`resolveValue(): Argument #1 ($descriptor)
	 * must be of type BaseDescriptor, array given`), because the freshly written
	 * object is handed to the query resolver as a plain array. Read the relations
	 * back with a separate query instead.
	 */
	scalarsOnly?: boolean;
}

/** One aliased call inside a batched document. */
export interface AliasedOperation {
	alias: string;
	field: string;
	args: GraphqlArg[];
	/** Selection set body, without the surrounding braces. Empty for none. */
	selection: string;
}

export interface GraphqlArg {
	/**
	 * GraphQL argument name, e.g. `fullpath`.
	 *
	 * Deliberately not called `name`: the n8n lint rules rewrite `name:` values
	 * near a node description into title case, which silently turns `fullpath`
	 * into `Fullpath` and breaks the query.
	 */
	arg: string;
	/** GraphQL type of the variable, e.g. `Int`, `String`, `UpdateProductInput`. */
	type: string;
	value: unknown;
}

/** A parsed dot-path tree: `{ manufacturer: { name: {} } }`. */
type PathTree = Map<string, PathTree>;

function buildPathTree(paths: string[]): PathTree {
	const root: PathTree = new Map();

	for (const path of paths) {
		let node = root;

		for (const segment of path.split('.')) {
			const key = segment.trim();
			if (key === '') continue;

			let child = node.get(key);
			if (child === undefined) {
				child = new Map();
				node.set(key, child);
			}
			node = child;
		}
	}

	return root;
}

function indent(depth: number): string {
	return '  '.repeat(depth + 1);
}

/** `{ id fullpath }`, limited to the fields the type actually has. */
function relationStub(schema: SchemaIndex, typeName: string): string {
	const available = new Set(schema.getFields(typeName).map((field) => field.name));
	const picked = RELATION_STUB.filter((name) => available.has(name));

	return picked.length > 0 ? `{ ${picked.join(' ')} }` : '{ __typename }';
}

/** Possible concrete types behind a union or interface. */
function possibleTypes(schema: SchemaIndex, typeName: string): string[] {
	return (schema.getType(typeName)?.possibleTypes ?? []).map((type) => type.name);
}

/**
 * Walks the schema and selects every scalar, stubbing relations.
 *
 * The point is that a user who picks a class and runs the node gets a complete,
 * flat record back without having written any GraphQL - and that a relation
 * never silently disappears from the output just because nobody named it.
 */
function autoSelection(
	schema: SchemaIndex,
	typeName: string,
	depth: number,
	maxDepth: number,
	scalarsOnly: boolean,
): string {
	const lines: string[] = [];

	for (const field of schema.getFields(typeName)) {
		if (TREE_FIELDS.has(field.name)) continue;
		if (BINARY_FIELDS.get(typeName)?.has(field.name)) continue;

		if (isLeafField(field)) {
			lines.push(`${indent(depth)}${field.name}`);
			continue;
		}

		if (scalarsOnly) continue;

		const { kind, name } = unwrapType(field.type);
		if (!name) continue;

		if (depth + 1 > maxDepth) continue;

		if (kind === 'UNION' || kind === 'INTERFACE') {
			const fragments = possibleTypes(schema, name)
				.map(
					(concrete) => `${indent(depth + 1)}... on ${concrete} ${relationStub(schema, concrete)}`,
				)
				.join('\n');

			if (fragments === '') continue;

			lines.push(`${indent(depth)}${field.name} {\n${fragments}\n${indent(depth)}}`);
			continue;
		}

		if (kind === 'OBJECT') {
			const nested = autoSelection(schema, name, depth + 1, maxDepth, scalarsOnly);
			if (nested.trim() === '') continue;

			lines.push(`${indent(depth)}${field.name} {\n${nested}\n${indent(depth)}}`);
		}
	}

	return lines.join('\n');
}

/**
 * Emits a selection set for an explicit set of dot-paths.
 *
 * `strict` decides what happens to a field the type does not have. Off, the
 * field is emitted anyway, because the schema may be stale relative to a class
 * the user just edited and Pimcore's error is clearer than ours. On - used
 * inside the members of a union - it is dropped, since `mimetype` is simply not
 * a thing an `asset_folder` has and asking would make the document invalid.
 */
function selectedSelection(
	schema: SchemaIndex,
	typeName: string,
	tree: PathTree,
	depth: number,
	strict = false,
): string {
	const fields = new Map(schema.getFields(typeName).map((field) => [field.name, field]));
	const lines: string[] = [];

	for (const [name, children] of tree) {
		const field = fields.get(name);

		if (field === undefined) {
			if (!strict) lines.push(`${indent(depth)}${name}`);
			continue;
		}

		if (isLeafField(field)) {
			lines.push(`${indent(depth)}${name}`);
			continue;
		}

		const { kind, name: typeRefName } = unwrapType(field.type);
		if (!typeRefName) continue;

		if (children.size === 0) {
			if (kind === 'UNION' || kind === 'INTERFACE') {
				const fragments = possibleTypes(schema, typeRefName)
					.map(
						(concrete) =>
							`${indent(depth + 1)}... on ${concrete} ${relationStub(schema, concrete)}`,
					)
					.join('\n');
				lines.push(`${indent(depth)}${name} {\n${fragments}\n${indent(depth)}}`);
			} else {
				lines.push(`${indent(depth)}${name} ${relationStub(schema, typeRefName)}`);
			}
			continue;
		}

		if (kind === 'UNION' || kind === 'INTERFACE') {
			const fragments = possibleTypes(schema, typeRefName)
				.filter((concrete) => {
					const available = new Set(schema.getFields(concrete).map((field) => field.name));
					return [...children.keys()].some((key) => available.has(key));
				})
				.map((concrete) => {
					const body = selectedSelection(schema, concrete, children, depth + 2);
					return `${indent(depth + 1)}... on ${concrete} {\n${body}\n${indent(depth + 1)}}`;
				})
				.join('\n');

			if (fragments === '') continue;

			lines.push(`${indent(depth)}${name} {\n${fragments}\n${indent(depth)}}`);
			continue;
		}

		const body = selectedSelection(schema, typeRefName, children, depth + 1);
		lines.push(`${indent(depth)}${name} {\n${body}\n${indent(depth)}}`);
	}

	return lines.join('\n');
}

/**
 * Produces the selection set body for a Pimcore object type.
 *
 * Returns the body only - callers wrap it in the braces that belong to whatever
 * field they are selecting on.
 */
export function buildSelectionSet(
	schema: SchemaIndex | null,
	typeName: string,
	options: SelectionOptions,
): string {
	if (options.mode === 'raw') {
		const raw = (options.raw ?? '').trim().replace(/^\{/, '').replace(/\}$/, '').trim();

		if (raw === '') {
			throw new Error('The raw selection set is empty');
		}

		return `  ${raw}`;
	}

	if (schema === null) {
		throw new Error(
			'Building a selection set needs the endpoint schema, which is unavailable because introspection is disabled for this Datahub configuration. Switch Fields to "Raw" and write the selection set by hand.',
		);
	}

	if (schema.getType(typeName) === undefined) {
		throw new Error(
			`The endpoint schema has no type ${typeName}. Check the class name, and that the class is part of this endpoint's query schema.`,
		);
	}

	const paths = (options.fields ?? []).filter((path) => path.trim() !== '');

	if (options.mode === 'selected' && paths.length === 0) {
		throw new Error('No fields selected');
	}

	const bodyFor = (concrete: string, depth: number, strict = false): string => {
		const body =
			options.mode === 'selected'
				? selectedSelection(schema, concrete, buildPathTree(paths), depth, strict)
				: autoSelection(
						schema,
						concrete,
						depth,
						options.maxDepth ?? 1,
						options.scalarsOnly === true,
					);

		return appendExtras(schema, concrete, body, options.extra ?? [], depth);
	};

	// A union or interface root — `getAssetListing` hands back `asset_tree`, a
	// union of asset and asset_folder — cannot carry fields directly. Each member
	// gets its own inline fragment, and members that would contribute nothing
	// (a folder asked only for a mimetype) are left out.
	const rootKind = schema.getType(typeName)?.kind;

	if (rootKind === 'UNION' || rootKind === 'INTERFACE') {
		const fragments = possibleTypes(schema, typeName)
			.map((concrete) => ({ concrete, body: bodyFor(concrete, 1, true) }))
			.filter((entry) => entry.body.trim() !== '')
			.map((entry) => `  ... on ${entry.concrete} {\n${entry.body}\n  }`);

		if (fragments.length === 0) {
			throw new Error(
				`None of the types behind ${typeName} carry the requested fields. Check the field names against the endpoint schema.`,
			);
		}

		return fragments.join('\n');
	}

	return bodyFor(typeName, 0);
}

/**
 * Appends caller supplied field lines, skipping those the type does not have.
 *
 * Used for the asset download, which needs `data`, `filename` and `mimetype`
 * regardless of the chosen Fields mode — and must not add them to an
 * `asset_folder`, which has no such fields.
 */
function appendExtras(
	schema: SchemaIndex,
	typeName: string,
	body: string,
	extra: string[],
	depth: number,
): string {
	if (extra.length === 0) return body;

	const available = new Set(schema.getFields(typeName).map((field) => field.name));
	const present = new Set(
		body
			.split('\n')
			.map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(line)?.[1])
			.filter((name): name is string => Boolean(name)),
	);

	const lines = extra
		.map((entry) => ({ entry, name: /^([A-Za-z_][A-Za-z0-9_]*)/.exec(entry.trim())?.[1] }))
		.filter(({ name }) => name !== undefined && available.has(name) && !present.has(name))
		.map(({ entry }) => `${indent(depth)}${entry.trim()}`);

	if (lines.length === 0) return body;

	return body.trim() === '' ? lines.join('\n') : [body, ...lines].join('\n');
}

/** Serialises a GraphQL argument list from variable names. */
function renderArgs(alias: string, args: GraphqlArg[]): string {
	if (args.length === 0) return '';

	return `(${args.map((entry) => `${entry.arg}: $${alias}_${entry.arg}`).join(', ')})`;
}

/**
 * Assembles one document from a list of aliased operations.
 *
 * Every argument travels as a GraphQL variable rather than an inline literal.
 * That removes a whole class of escaping bugs - Pimcore filters are JSON inside
 * a GraphQL string, so inlining them means escaping quotes twice - and it lets
 * mutation inputs be passed as plain objects.
 *
 * Aliases are `op<n>`, where n indexes the operation within the batch. Errors
 * come back with the alias in their `path`, which is how a failure inside a
 * batch is attributed to the input item that caused it.
 */
export function buildDocument(
	operationType: 'query' | 'mutation',
	operations: AliasedOperation[],
): { query: string; variables: IDataObject } {
	if (operations.length === 0) {
		throw new Error('Cannot build an empty GraphQL document');
	}

	const variables: IDataObject = {};
	const declarations: string[] = [];
	const bodies: string[] = [];

	for (const operation of operations) {
		for (const entry of operation.args) {
			const variableName = `${operation.alias}_${entry.arg}`;
			declarations.push(`$${variableName}: ${entry.type}`);
			variables[variableName] = entry.value as IDataObject[string];
		}

		const selection = operation.selection.trim() === '' ? '' : ` {\n${operation.selection}\n  }`;

		bodies.push(
			`  ${operation.alias}: ${operation.field}${renderArgs(operation.alias, operation.args)}${selection}`,
		);
	}

	const header = declarations.length > 0 ? `(${declarations.join(', ')})` : '';

	return {
		query: `${operationType} N8nDatahub${header} {\n${bodies.join('\n')}\n}`,
		variables,
	};
}

/**
 * Lists selectable field paths for a class, one level of relations deep.
 *
 * Feeds the "Fields" multi-select. Relation fields appear both as a bare path
 * (which yields the id/fullpath stub) and as `relation.field` paths.
 */
export function listFieldPaths(
	schema: SchemaIndex,
	typeName: string,
): Array<{ name: string; value: string; description?: string }> {
	const out: Array<{ name: string; value: string; description?: string }> = [];

	for (const field of schema.getFields(typeName)) {
		if (TREE_FIELDS.has(field.name)) continue;

		if (isLeafField(field)) {
			out.push({ name: field.name, value: field.name });
			continue;
		}

		const { kind, name } = unwrapType(field.type);
		if (!name) continue;

		out.push({
			name: `${field.name} (relation)`,
			value: field.name,
			description: 'Returns ID and fullpath of the related elements',
		});

		const concreteTypes = kind === 'OBJECT' ? [name] : possibleTypes(schema, name);

		for (const concrete of concreteTypes) {
			for (const nested of schema.getFields(concrete)) {
				if (!isLeafField(nested) || TREE_FIELDS.has(nested.name)) continue;

				const value = `${field.name}.${nested.name}`;
				if (out.some((option) => option.value === value)) continue;

				out.push({ name: `${field.name} › ${nested.name}`, value });
			}
		}
	}

	return out;
}
