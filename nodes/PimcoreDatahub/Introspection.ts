import type { ILoadOptionsFunctions } from 'n8n-workflow';

import { buildGraphqlUrl, graphqlRequest } from './GenericFunctions';

/** A GraphQL type reference, possibly wrapped in LIST / NON_NULL shells. */
export interface TypeRef {
	kind: string;
	name: string | null;
	ofType?: TypeRef | null;
}

export interface SchemaField {
	name: string;
	description?: string | null;
	type: TypeRef;
}

export interface SchemaType {
	kind: string;
	name: string;
	description?: string | null;
	fields?: SchemaField[] | null;
	/**
	 * Fields of an INPUT_OBJECT, e.g. `UpdateProductInput`.
	 *
	 * GraphQL keeps the writable shape of a type here rather than in `fields`,
	 * which is null on every INPUT_OBJECT. This is the authoritative list of what
	 * a mutation accepts, and what the write field mapper is built from.
	 */
	inputFields?: SchemaField[] | null;
	possibleTypes?: Array<{ name: string }> | null;
}

export interface RawSchema {
	__schema: {
		queryType: { name: string } | null;
		mutationType: { name: string } | null;
		types: SchemaType[];
	};
}

/** Introspected schema with types indexed by name. */
export class SchemaIndex {
	private readonly types = new Map<string, SchemaType>();

	readonly queryTypeName: string | null;

	readonly mutationTypeName: string | null;

	constructor(raw: RawSchema) {
		for (const type of raw.__schema.types ?? []) {
			if (type.name) {
				this.types.set(type.name, type);
			}
		}

		this.queryTypeName = raw.__schema.queryType?.name ?? null;
		this.mutationTypeName = raw.__schema.mutationType?.name ?? null;
	}

	getType(name: string): SchemaType | undefined {
		return this.types.get(name);
	}

	getFields(typeName: string): SchemaField[] {
		return this.types.get(typeName)?.fields ?? [];
	}

	getInputFields(typeName: string): SchemaField[] {
		return this.types.get(typeName)?.inputFields ?? [];
	}

	/**
	 * Data object classes readable through this endpoint.
	 *
	 * Datahub names one query `get<Class>Listing` per class in the query schema,
	 * which makes the query type the authoritative list of what is exposed —
	 * more accurate than reading Pimcore's class definitions, because a class can
	 * exist without being published to this endpoint.
	 */
	get readableClasses(): string[] {
		if (!this.queryTypeName) return [];

		return (
			this.getFields(this.queryTypeName)
				.map((field) => /^get(.+)Listing$/.exec(field.name)?.[1])
				.filter((name): name is string => Boolean(name))
				// `getAssetListing` and friends match the same pattern but are special
				// entities, not data object classes, and have no `object_` type.
				.filter((name) => this.getType(`object_${name}`) !== undefined)
				.sort()
		);
	}

	/** Data object classes exposed for a given mutation, e.g. `create`. */
	writableClasses(operation: 'create' | 'update' | 'delete'): string[] {
		if (!this.mutationTypeName) return [];

		const pattern = new RegExp(`^${operation}(.+)$`);

		return this.getFields(this.mutationTypeName)
			.map((field) => pattern.exec(field.name)?.[1])
			.filter((name): name is string => Boolean(name))
			.filter((name) => !name.endsWith('Folder') && this.getType(`object_${name}`) !== undefined)
			.sort();
	}

	hasMutation(name: string): boolean {
		if (!this.mutationTypeName) return false;

		return this.getFields(this.mutationTypeName).some((field) => field.name === name);
	}
}

/** Strips LIST and NON_NULL shells to reach the named type underneath. */
export function unwrapType(type: TypeRef): {
	kind: string;
	name: string | null;
	isList: boolean;
} {
	let current: TypeRef | null | undefined = type;
	let isList = false;

	while (current && (current.kind === 'LIST' || current.kind === 'NON_NULL')) {
		if (current.kind === 'LIST') isList = true;
		current = current.ofType;
	}

	return {
		kind: current?.kind ?? 'SCALAR',
		name: current?.name ?? null,
		isList,
	};
}

/** True when a field can be selected without a sub-selection of its own. */
export function isLeafField(field: SchemaField): boolean {
	const { kind } = unwrapType(field.type);

	return kind === 'SCALAR' || kind === 'ENUM';
}

const INTROSPECTION_QUERY = `
query IntrospectDatahub {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind
      name
      description
      possibleTypes { name }
      fields(includeDeprecated: false) {
        name
        description
        type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
      }
      inputFields {
        name
        description
        type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
      }
    }
  }
}`;

interface CacheEntry {
	schema: SchemaIndex;
	fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

/**
 * Fetches and caches the endpoint schema.
 *
 * Introspecting a 28-class instance is a large response, and the node dropdowns
 * ask for it on every keystroke-triggered reload, so it is cached per endpoint
 * for a few minutes. The cache key is the resolved URL, which means two
 * credentials pointing at the same endpoint share one entry.
 */
export async function fetchSchema(this: ILoadOptionsFunctions): Promise<SchemaIndex> {
	const credentials = await this.getCredentials('pimcoreDatahubApi');
	const key = buildGraphqlUrl(credentials.baseUrl as string, credentials.endpoint as string);

	const cached = cache.get(key);
	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
		return cached.schema;
	}

	const response = await graphqlRequest.call<
		ILoadOptionsFunctions,
		[{ query: string }],
		Promise<{ data?: RawSchema; errors?: Array<{ message: string }> }>
	>(this, { query: INTROSPECTION_QUERY });

	if (!response.data?.__schema) {
		throw new Error(
			'The endpoint returned no schema. Introspection is disabled for this Datahub configuration, so class and field dropdowns are unavailable - enter the class name by hand and use a raw selection set.',
		);
	}

	const schema = new SchemaIndex(response.data);
	cache.set(key, { schema, fetchedAt: Date.now() });

	return schema;
}

/** Drops cached schemas. Exposed for tests. */
export function clearSchemaCache(): void {
	cache.clear();
}
